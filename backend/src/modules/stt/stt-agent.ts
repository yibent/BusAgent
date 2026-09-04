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
import { ConversationInterruptions } from '../conversation/conversation-interruptions.js';
import { SpeechGate, speechContentLength } from '../conversation/speech-gate.js';
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
  utteranceSettleMs: number;
  bargeInMinChars: number;
  listener: SttSessionListener;
  pendingFinalText: string;
  settleTimer: ReturnType<typeof setTimeout> | undefined;
  forceFlush: boolean;
  work: Promise<void>;
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

function joinUtteranceParts(current: string, next: string): string {
  const left = current.trim();
  const right = next.trim();
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const needsSpace = /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
  return `${left}${needsSpace ? ' ' : ''}${right}`;
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
    private readonly interruptions: ConversationInterruptions,
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
    const utteranceSettleMs = asInt(
      configValue(agentConfig, 'utterance_settle_ms'),
      900,
    );
    const bargeInMinChars = asInt(configValue(agentConfig, 'barge_in_min_chars'), 3);
    const model = asString(configValue(agentConfig, 'model'), this.hostConfig.qwenSttModel);

    const streamId = newStreamId();
    const correlationId = input.correlationId ?? newCorrelationId();
    const encoder = new TranscriptDeltaEncoder();

    const session: Session = {
      streamId,
      correlationId,
      encoder,
      emitUncommitted,
      utteranceSettleMs,
      bargeInMinChars,
      listener,
      pendingFinalText: '',
      settleTimer: undefined,
      forceFlush: false,
      work: Promise.resolve(),
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
            this.cancelSettleTimer(session);
            this.enqueue(session, () =>
              this.onPartial(session, partial.text, partial.isFinal, partial.speechFinal),
            );
          },
          onDone: () => {
            this.cancelSettleTimer(session);
            this.enqueue(session, async () => {
              await this.flushPending(session);
              this.closeSession(streamId);
            });
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
    const session = this.sessions.get(streamId);
    if (session === undefined) return;
    session.forceFlush = true;
    if (session.pendingFinalText.length > 0) {
      this.cancelSettleTimer(session);
      this.enqueue(session, () => this.flushPending(session));
    }
  }

  endSession(streamId: string): void {
    const session = this.sessions.get(streamId);
    if (session === undefined) return;
    session.forceFlush = true;
    session.connection.done();
  }

  closeSession(streamId: string): void {
    const session = this.sessions.get(streamId);
    if (session === undefined || session.closed) {
      return;
    }
    session.closed = true;
    this.cancelSettleTimer(session);
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
      const longEnough = speechContentLength(text) >= session.bargeInMinChars;
      if (!longEnough || this.gate.isLikelyEcho(session.correlationId, text)) {
        session.encoder.reset();
        session.pendingFinalText = '';
        return;
      }
      this.gate.interrupt(session.correlationId);
      this.interruptions.interrupt(session.correlationId);
      session.encoder.reset();
      session.pendingFinalText = '';
      this.logger.info(
        `human barge-in detected conv=${session.correlationId} chars=${speechContentLength(text)}`,
      );
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
      session.pendingFinalText = joinUtteranceParts(
        session.pendingFinalText,
        tick.finalText,
      );
      this.scheduleSettledFinal(session);
    }
  }

  private scheduleSettledFinal(session: Session): void {
    this.cancelSettleTimer(session);
    const delay = session.forceFlush ? 0 : session.utteranceSettleMs;
    session.settleTimer = setTimeout(() => {
      session.settleTimer = undefined;
      this.enqueue(session, () => this.flushPending(session));
    }, Math.max(0, delay));
  }

  private cancelSettleTimer(session: Session): void {
    if (session.settleTimer === undefined) return;
    clearTimeout(session.settleTimer);
    session.settleTimer = undefined;
  }

  private enqueue(session: Session, operation: () => Promise<void>): void {
    session.work = session.work.then(operation).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`STT stream ${session.streamId} processing failed: ${message}`);
      session.listener.onError?.(error instanceof Error ? error : new Error(message));
      this.closeSession(session.streamId);
    });
  }

  private async flushPending(session: Session): Promise<void> {
    if (session.closed) return;
    const text = session.pendingFinalText.trim();
    if (text.length === 0) return;
    session.pendingFinalText = '';
    const finalPayload = {
      stream_id: session.streamId,
      text,
    };
    await this.publish(session, 'transcript.final', finalPayload);
    await this.publish(session, 'intent.created', {
      text,
      stream_id: session.streamId,
      source: 'stt',
    });
    session.listener.onFinal?.(finalPayload);
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
