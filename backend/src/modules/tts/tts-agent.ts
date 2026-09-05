import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
} from '../../adapters/in-process/agent-classes.js';
import { HostConfig } from '../../config/host-config.js';
import { RuntimeState } from '../../app/runtime-state.service.js';
import { ConversationHub } from '../conversation/conversation-hub.js';
import { pcm16MonoDurationMs, SpeechGate } from '../conversation/speech-gate.js';
import { defaultTtsStreamFactory } from './qwen-tts-stream.js';
import type { TtsConnection, TtsStreamFactory } from './tts-types.js';

export const TTS_REGISTRATION_KEY = 'TtsAgent';
export const TTS_AGENT_ID = 'robot.tts';
export const TTS_STREAM_FACTORY = Symbol('TTS_STREAM_FACTORY');

interface Session {
  conversationId: string;
  turn: number;
  sampleRate: number;
  connection: TtsConnection;
  ready: Promise<void>;
  started: boolean;
  closed: boolean;
  finishing: boolean;
  pendingText: string;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

/**
 * Speech synthesis module. Text arrives from DialogueAgent; PCM is sent to
 * the live browser session and never placed on the event bus.
 */
@Injectable()
export class TtsAgent implements InProcessAgent, OnModuleInit {
  readonly registrationKey = TTS_REGISTRATION_KEY;
  private readonly logger = new Logger(TtsAgent.name);
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly hostConfig: HostConfig,
    private readonly runtime: RuntimeState,
    private readonly hub: ConversationHub,
    private readonly gate: SpeechGate,
    @Inject(TTS_STREAM_FACTORY)
    private readonly connect: TtsStreamFactory,
  ) {}

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  handle(): void {
    // Text arrives through DialogueAgent, not the event bus.
  }

  startTurn(conversationId: string, turn: number): void {
    this.cancel(conversationId);
    this.gate.startAssistantTurn(conversationId);
    const apiKey = this.hostConfig.dashscopeApiKey;
    if (apiKey === undefined) {
      this.logger.warn('DASHSCOPE_API_KEY is required for Qwen TTS');
      return;
    }

    const config = this.agentConfig();
    const sampleRate = asInt(config.sample_rate, 24_000);
    const model = asString(config.model, this.hostConfig.qwenTtsModel);
    const voice = asString(config.voice, this.hostConfig.qwenTtsVoice);
    const languageType = asString(config.language_type, 'Chinese');

    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);

    const session: Session = {
      conversationId,
      turn,
      sampleRate,
      ready,
      started: false,
      closed: false,
      finishing: false,
      pendingText: '',
      connection: this.connect(
        {
          apiKey,
          wsUrl: this.hostConfig.qwenTtsWsUrl,
          model,
          voice,
          sampleRate,
          languageType,
        },
        {
          onReady: () => {
            resolveReady();
          },
          onAudio: (base64) => {
            this.onAudio(session, base64);
          },
          onDone: () => {
            this.closeSession(conversationId, turn);
          },
          onError: (error) => {
            this.logger.error(
              `TTS stream conv=${conversationId} failed: ${error.message}`,
            );
            rejectReady(error);
            if (!session.closed) {
              this.hub.publish(conversationId, {
                type: 'error',
                message: error.message,
              });
            }
            this.closeSession(conversationId, turn);
          },
        },
      ),
    };
    this.sessions.set(conversationId, session);
    this.logger.info(`TTS turn ${turn} conv=${conversationId} voice=${voice}`);
  }

  append(conversationId: string, turn: number, text: string): void {
    const session = this.sessions.get(conversationId);
    if (
      session === undefined ||
      session.turn !== turn ||
      session.closed ||
      session.finishing
    ) {
      return;
    }
    if (text.length === 0) {
      return;
    }
    this.gate.appendAssistantText(conversationId, text);
    session.pendingText += text;
    // Commit complete sentences, not LLM token fragments or comma-separated
    // clauses. A decimal point (e.g. 2.5 cm) must never split a spoken value.
    let boundary: number;
    while ((boundary = session.pendingText.indexOf('。')) !== -1) {
      const sentence = session.pendingText.slice(0, boundary + 1);
      session.pendingText = session.pendingText.slice(boundary + 1);
      this.sendText(session, sentence);
    }
  }

  async finishTurn(conversationId: string, turn: number): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (
      session === undefined ||
      session.turn !== turn ||
      session.closed ||
      session.finishing
    ) {
      return;
    }
    session.finishing = true;
    this.flushText(session);
    await this.sendWhenReady(session, () => {
      session.connection.finish();
    });
  }

  cancel(conversationId: string): void {
    this.stop(conversationId, false);
  }

  interrupt(conversationId: string): void {
    this.stop(conversationId, true);
  }

  private stop(conversationId: string, interrupted: boolean): void {
    const session = this.sessions.get(conversationId);
    if (session === undefined || session.closed) {
      return;
    }
    // Close without session.finish: interrupted buffered text must never be spoken.
    this.closeSession(conversationId, session.turn, interrupted);
  }

  private flushText(session: Session): void {
    if (session.closed) return;
    const text = session.pendingText;
    session.pendingText = '';
    this.sendText(session, text);
  }

  private sendText(session: Session, text: string): void {
    // A punctuation-only tail needs no standalone audio segment.
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    void this.sendWhenReady(session, () => session.connection.appendText(text));
  }

  private async sendWhenReady(session: Session, write: () => void): Promise<void> {
    try {
      await session.ready;
    } catch {
      return;
    }
    if (session.closed) {
      return;
    }
    write();
  }

  private onAudio(session: Session, base64Pcm: string): void {
    if (session.closed) {
      return;
    }
    const bytes = Buffer.from(base64Pcm, 'base64');
    if (!session.started) {
      session.started = true;
      this.gate.beginSpeaking(session.conversationId);
      this.hub.publish(session.conversationId, {
        type: 'speech.start',
        turn: session.turn,
        sample_rate: session.sampleRate,
        encoding: 'pcm',
      });
    }
    this.gate.extendPlayback(
      session.conversationId,
      pcm16MonoDurationMs(bytes.byteLength, session.sampleRate),
    );
    this.hub.publish(session.conversationId, {
      type: 'speech.audio',
      turn: session.turn,
      audio: base64Pcm,
    });
  }

  private closeSession(
    conversationId: string,
    turn: number,
    interrupted = false,
  ): void {
    const session = this.sessions.get(conversationId);
    if (session === undefined || session.turn !== turn || session.closed) {
      return;
    }
    session.closed = true;
    session.pendingText = '';
    session.connection.close();
    this.sessions.delete(conversationId);
    if (session.started) {
      if (!interrupted) {
        this.gate.extendPlayback(conversationId, 800);
      }
      this.hub.publish(conversationId, { type: 'speech.done', turn });
    }
  }

  private agentConfig(): Record<string, unknown> {
    if (!this.runtime.isReady()) {
      return {};
    }
    return this.runtime.current.agents.get(TTS_AGENT_ID)?.runtimeConfig.config ?? {};
  }
}

export { defaultTtsStreamFactory };
