import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import type { Server } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { BusAgentError } from '../../common/errors.js';
import { newCorrelationId } from '../../common/ids.js';
import { HostRuntimeService } from '../../app/host-runtime.service.js';
import { RuntimeState } from '../../app/runtime-state.service.js';
import { EventBus } from '../../bus/event-bus.service.js';
import { ConversationHub } from '../conversation/conversation-hub.js';
import { SpeechGate } from '../conversation/speech-gate.js';
import { SttAgent } from './stt-agent.js';

interface ClientMessage {
  type?: string;
  language?: string;
  sample_rate?: number;
  encoding?: string;
  correlation_id?: string;
  text?: string;
}

/**
 * Browser session over `/v1/stt`: microphone audio in, transcript + reply out.
 */
@Injectable()
export class AudioGateway {
  private readonly logger = new Logger(AudioGateway.name);
  private wss: WebSocketServer | undefined;

  constructor(
    private readonly stt: SttAgent,
    private readonly runtime: HostRuntimeService,
    private readonly runtimeState: RuntimeState,
    @Inject(forwardRef(() => EventBus))
    private readonly eventBus: EventBus,
    private readonly hub: ConversationHub,
    private readonly gate: SpeechGate,
  ) {}

  attach(server: Server, path = '/v1/stt'): void {
    this.wss = new WebSocketServer({ server, path });
    this.wss.on('connection', (socket) => {
      this.onConnection(socket);
    });
    this.logger.info(`Audio gateway listening on ${path}`);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.wss === undefined) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
    });
  }

  private onConnection(socket: WebSocket): void {
    if (this.runtime.currentState !== 'ready') {
      this.send(socket, { type: 'error', message: 'host is still starting' });
      socket.close();
      return;
    }

    let conversationId: string | undefined;
    let streamId: string | undefined;
    let unsubscribe: (() => void) | undefined;

    const ensureHub = (id: string): void => {
      if (conversationId === id && unsubscribe !== undefined) {
        return;
      }
      unsubscribe?.();
      conversationId = id;
      unsubscribe = this.hub.subscribe(id, (message) => this.send(socket, message));
    };

    this.send(socket, { type: 'session.welcome', capabilities: ['bus.timeline.v1'] });

    socket.on('message', (data, isBinary) => {
      this.onMessage(socket, data, isBinary, {
        getConversationId: () => conversationId,
        getStreamId: () => streamId,
        setStreamId: (id) => {
          streamId = id;
        },
        ensureHub,
      });
    });
    socket.on('close', () => {
      unsubscribe?.();
      if (streamId !== undefined) {
        this.stt.closeSession(streamId);
      }
    });
    socket.on('error', (error) => {
      this.logger.warn(`session websocket error: ${error.message}`);
    });
  }

  private onMessage(
    socket: WebSocket,
    data: RawData,
    isBinary: boolean,
    state: {
      getConversationId: () => string | undefined;
      getStreamId: () => string | undefined;
      setStreamId: (id: string | undefined) => void;
      ensureHub: (id: string) => void;
    },
  ): void {
    const streamId = state.getStreamId();
    if (isBinary) {
      if (streamId === undefined) {
        this.send(socket, { type: 'error', message: 'send session.start before audio' });
        return;
      }
      this.stt.pushAudio(streamId, toBuffer(data));
      return;
    }

    const raw = toBuffer(data).toString('utf8');
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(socket, { type: 'error', message: 'invalid JSON' });
      return;
    }

    const type = message.type ?? '';
    if (type === 'session.subscribe') {
      if (typeof message.correlation_id === 'string' && message.correlation_id) {
        state.ensureHub(message.correlation_id);
      }
      return;
    }
    if (type === 'session.start') {
      if (streamId !== undefined) {
        this.send(socket, { type: 'error', message: 'session already started' });
        return;
      }
      this.startVoiceTurn(socket, message, state);
      return;
    }
    if (type === 'user.text') {
      void this.handleTyped(socket, message, state);
      return;
    }
    if (type === 'speech.ended') {
      const conversationId = message.correlation_id ?? state.getConversationId();
      if (conversationId !== undefined) {
        this.gate.playbackEnded(conversationId);
      }
      return;
    }
    if (streamId === undefined) {
      this.send(socket, { type: 'error', message: 'send session.start first' });
      return;
    }
    if (type === 'finalize') {
      this.stt.finalize(streamId);
      return;
    }
    if (type === 'audio.done') {
      this.stt.finalize(streamId);
      this.stt.endSession(streamId);
      state.setStreamId(undefined);
    }
  }

  private startVoiceTurn(
    socket: WebSocket,
    message: ClientMessage,
    state: {
      getConversationId: () => string | undefined;
      setStreamId: (id: string | undefined) => void;
      ensureHub: (id: string) => void;
    },
  ): void {
    const conversationId = message.correlation_id ?? state.getConversationId() ?? newCorrelationId();
    state.ensureHub(conversationId);
    try {
      const started = this.stt.startSession(
        {
          correlationId: conversationId,
          ...(message.language !== undefined ? { language: message.language } : {}),
          ...(message.sample_rate !== undefined ? { sampleRate: message.sample_rate } : {}),
          ...(message.encoding !== undefined ? { encoding: message.encoding } : {}),
        },
        {
          onDelta: (payload) => this.send(socket, { type: 'transcript.delta', ...payload }),
          onFinal: (payload) => this.send(socket, { type: 'transcript.final', ...payload }),
          onError: (error) => this.send(socket, { type: 'error', message: error.message }),
        },
      );
      state.setStreamId(started.streamId);
      this.logger.info(`voice turn ${started.streamId} conv=${started.correlationId}`);
      this.send(socket, {
        type: 'session.ready',
        stream_id: started.streamId,
        correlation_id: started.correlationId,
      });
    } catch (error) {
      const messageText =
        error instanceof BusAgentError ? error.message : (error as Error).message;
      this.logger.error(`session.start failed: ${messageText}`);
      this.send(socket, { type: 'error', message: messageText });
    }
  }

  private async handleTyped(
    socket: WebSocket,
    message: ClientMessage,
    state: {
      getConversationId: () => string | undefined;
      ensureHub: (id: string) => void;
    },
  ): Promise<void> {
    const text = message.text?.trim() ?? '';
    if (text.length === 0) {
      return;
    }
    const conversationId =
      message.correlation_id ?? state.getConversationId() ?? newCorrelationId();
    state.ensureHub(conversationId);
    try {
      this.send(socket, { type: 'user.accepted', text, correlation_id: conversationId });
      await this.eventBus.ingestHostEvent({
        app_id: this.runtimeState.current.appId,
        event_type: 'intent.created',
        correlation_id: conversationId,
        payload: { text, source: 'typed' },
      });
    } catch (error) {
      const messageText = (error as Error).message;
      this.logger.error(`typed intent failed: ${messageText}`);
      this.send(socket, { type: 'error', message: messageText });
    }
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(payload));
    }
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}
