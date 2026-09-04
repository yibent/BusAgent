import { Inject, Injectable, OnModuleInit, forwardRef } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
} from '../../adapters/in-process/agent-classes.js';
import { EventBus } from '../../bus/event-bus.service.js';
import { BusAgentError } from '../../common/errors.js';
import { newCorrelationId, newStreamId } from '../../common/ids.js';
import { HostConfig } from '../../config/host-config.js';
import { RuntimeState } from '../../app/runtime-state.service.js';
import { SpeechGate } from '../conversation/speech-gate.js';
import { TranscriptDeltaEncoder } from './transcript-delta.js';
import { defaultSttStreamFactory } from './qwen-stt-stream.js';
import type { SttConnection, SttStreamFactory } from './stt-types.js';

export const STT_REGISTRATION_KEY = 'SttAgent';
export const STT_AGENT_ID = 'robot.stt';
export const STT_STREAM_FACTORY = Symbol('STT_STREAM_FACTORY');

export interface SttSessionStart {
  correlationId?: string;
  language?: string;
  sampleRate?: number;
  encoding?: string;
  emitUncommitted?: boolean;
}

export interface SttSessionListener {
  onDelta?: (payload: Record<string, unknown>) => void;
  onFinal?: (payload: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
}

interface Session {
  streamId: string;
  correlationId: string;
  encoder: TranscriptDeltaEncoder;
  connection: SttConnection;
  emitUncommitted: boolean;
  listener: SttSessionListener;
  closed: boolean;
}

function configValue(config: Record<string, unknown>, key: string): unknown {
  return config[key];
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * Speech-to-text module. Audio stays off the bus; this agent talks to Qwen-ASR
 * Realtime and publishes short text events for any downstream agent.
 */
@Injectable()
export class SttAgent implements InProcessAgent, OnModuleInit {
  readonly registrationKey = STT_REGISTRATION_KEY;
  private readonly logger = new Logger(SttAgent.name);
  private readonly sessions = new Map<string, Session>();

  constructor(
    @Inject(forwardRef(() => EventBus))
    private readonly eventBus: EventBus,
    private readonly hostConfig: HostConfig,
    private readonly runtime: RuntimeState,
    private readonly gate: SpeechGate,
    @Inject(STT_STREAM_FACTORY)
    private readonly connect: SttStreamFactory,
  ) {}

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  handle(): void {
    // Audio arrives through AudioGateway, not the event bus.
  }

  startSession(
    input: SttSessionStart,
    listener: SttSessionListener = {},
  ): { streamId: string; correlationId: string } {
    const apiKey = this.hostConfig.dashscopeApiKey;
    if (apiKey === undefined) {
      throw new BusAgentError(
        'CONFIG_INVALID',
        'DASHSCOPE_API_KEY is required for Qwen speech-to-text',
      );
    }

    const agentConfig =
      this.runtime.current.agents.get(STT_AGENT_ID)?.runtimeConfig.config ?? {};
    const language = input.language ?? asString(configValue(agentConfig, 'language'), 'zh');
    const sampleRate = input.sampleRate ?? asInt(configValue(agentConfig, 'sample_rate'), 16_000);
    const encoding = input.encoding ?? asString(configValue(agentConfig, 'encoding'), 'pcm');
    const emitUncommitted =
      input.emitUncommitted ?? asBool(configValue(agentConfig, 'emit_uncommitted'), true);
    const endpointingMs = asInt(configValue(agentConfig, 'endpointing_ms'), 400);
    const model = asString(configValue(agentConfig, 'model'), this.hostConfig.qwenSttModel);

    const streamId = newStreamId();
    const correlationId = input.correlationId ?? newCorrelationId();
    const encoder = new TranscriptDeltaEncoder();

    const session: Session = {
      streamId,
      correlationId,
      encoder,
      emitUncommitted,
      listener,
      closed: false,
      connection: this.connect(
        {
          apiKey,
          wsUrl: this.hostConfig.qwenSttWsUrl,
          model,
          sampleRate,
          encoding,
          language,
          endpointingMs,
        },
        {
          onReady: () => {
            this.logger.info(`STT stream ready ${streamId}`);
          },
          onPartial: (partial) => {
            void this.onPartial(session, partial.text, partial.isFinal, partial.speechFinal);
          },
          onDone: () => {
            this.closeSession(streamId);
          },
          onError: (error) => {
            this.logger.error(`STT stream ${streamId} failed: ${error.message}`);
            listener.onError?.(error);
            this.closeSession(streamId);
          },
        },
      ),
    };
    this.sessions.set(streamId, session);
    return { streamId, correlationId };
  }

  pushAudio(streamId: string, chunk: Buffer): void {
    this.sessions.get(streamId)?.connection.sendAudio(chunk);
  }

  finalize(streamId: string): void {
    this.sessions.get(streamId)?.connection.finalize();
  }

  endSession(streamId: string): void {
    this.sessions.get(streamId)?.connection.done();
  }

  closeSession(streamId: string): void {
    const session = this.sessions.get(streamId);
    if (session === undefined || session.closed) {
      return;
    }
    session.closed = true;
    session.connection.close();
    this.sessions.delete(streamId);
  }

  private async onPartial(
    session: Session,
    text: string,
    isFinal: boolean,
    speechFinal: boolean,
  ): Promise<void> {
    if (session.closed) {
      return;
    }
    if (this.gate.isBlocked(session.correlationId)) {
      session.encoder.reset();
      return;
    }
    const tick = session.encoder.push(text, isFinal, speechFinal);
    for (const delta of tick.deltas) {
      if (!delta.committed && !session.emitUncommitted) {
        continue;
      }
      const payload = {
        stream_id: session.streamId,
        seq: delta.seq,
        text: delta.text,
        committed: delta.committed,
      };
      await this.publish(session, 'transcript.delta', payload);
      session.listener.onDelta?.(payload);
    }
    if (tick.finalText !== null && tick.finalText.trim().length > 0) {
      const finalPayload = {
        stream_id: session.streamId,
        text: tick.finalText,
      };
      await this.publish(session, 'transcript.final', finalPayload);
      await this.publish(session, 'intent.created', {
        text: tick.finalText,
        stream_id: session.streamId,
        source: 'stt',
      });
      session.listener.onFinal?.(finalPayload);
    }
  }

  private async publish(
    session: Session,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.eventBus.publishFromAgent(STT_AGENT_ID, {
      event_type: eventType,
      source_agent_id: STT_AGENT_ID,
      correlation_id: session.correlationId,
      payload,
    });
  }
}

export { defaultSttStreamFactory };
