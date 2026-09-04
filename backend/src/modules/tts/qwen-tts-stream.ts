import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type {
  TtsConnectOptions,
  TtsConnection,
  TtsHandlers,
  TtsStreamFactory,
} from './tts-types.js';

function parseMessage(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function toUtf8(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

function eventId(): string {
  return `event_${randomUUID()}`;
}

function errorMessage(msg: Record<string, unknown>): string {
  const nested = msg.error;
  if (nested !== null && typeof nested === 'object') {
    const record = nested as Record<string, unknown>;
    const text = asText(record.message);
    if (text.length > 0) {
      return text;
    }
  }
  return asText(msg.message, 'tts error');
}

/**
 * Qwen-TTS Realtime client (`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`).
 * Text is appended as JSON events; PCM arrives as base64 `response.audio.delta`.
 */
export function connectQwenTts(
  options: TtsConnectOptions,
  handlers: TtsHandlers,
): TtsConnection {
  const url = new URL(options.wsUrl);
  if (!url.searchParams.has('model')) {
    url.searchParams.set('model', options.model);
  }

  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  });

  let ready = false;

  const sendJson = (payload: Record<string, unknown>): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const sendSessionUpdate = (): void => {
    sendJson({
      event_id: eventId(),
      type: 'session.update',
      session: {
        voice: options.voice,
        mode: 'server_commit',
        language_type: options.languageType,
        response_format: 'pcm',
        sample_rate: options.sampleRate,
      },
    });
  };

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      return;
    }
    const raw = typeof data === 'string' ? data : toUtf8(data);
    const msg = parseMessage(raw);
    if (msg === null) {
      handlers.onError(new Error(`invalid TTS JSON: ${raw}`));
      return;
    }
    const type = asText(msg.type);
    if (type === 'session.created') {
      sendSessionUpdate();
      return;
    }
    if (type === 'session.updated') {
      ready = true;
      handlers.onReady();
      return;
    }
    if (type === 'response.audio.delta') {
      const delta = asText(msg.delta);
      if (delta.length > 0) {
        handlers.onAudio(delta);
      }
      return;
    }
    if (type === 'session.finished' || type === 'response.done') {
      if (type === 'session.finished') {
        handlers.onDone();
      }
      return;
    }
    if (type === 'error') {
      handlers.onError(new Error(errorMessage(msg)));
    }
  });

  socket.on('error', (error) => {
    handlers.onError(error);
  });

  socket.on('close', () => {
    if (ready) {
      handlers.onDone();
    }
  });

  return {
    appendText(text: string): void {
      if (text.length === 0) {
        return;
      }
      sendJson({
        event_id: eventId(),
        type: 'input_text_buffer.append',
        text,
      });
    },
    finish(): void {
      sendJson({ event_id: eventId(), type: 'session.finish' });
    },
    close(): void {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    },
  };
}

export const defaultTtsStreamFactory: TtsStreamFactory = connectQwenTts;
