import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type {
  SttConnectOptions,
  SttConnection,
  SttHandlers,
  SttStreamFactory,
} from './stt-types.js';

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
  return asText(msg.message, 'stt error');
}

/**
 * Qwen-ASR Realtime client (`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`).
 * Audio is sent as base64 JSON events; transcripts arrive as text + stash.
 */
export function connectQwenStt(
  options: SttConnectOptions,
  handlers: SttHandlers,
): SttConnection {
  const url = new URL(options.wsUrl);
  if (!url.searchParams.has('model')) {
    url.searchParams.set('model', options.model);
  }

  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  });

  let ready = false;
  const pending: Buffer[] = [];

  const sendJson = (payload: Record<string, unknown>): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const sendAudioFrame = (chunk: Buffer): void => {
    sendJson({
      event_id: eventId(),
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    });
  };

  const flush = (): void => {
    if (!ready || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    for (const chunk of pending) {
      sendAudioFrame(chunk);
    }
    pending.length = 0;
  };

  const sendSessionUpdate = (): void => {
    const session: Record<string, unknown> = {
      modalities: ['text'],
      input_audio_format: options.encoding,
      sample_rate: options.sampleRate,
      turn_detection: {
        type: 'server_vad',
        threshold: 0,
        silence_duration_ms: options.endpointingMs,
      },
    };
    if (options.language !== undefined && options.language.length > 0) {
      session.input_audio_transcription = { language: options.language };
    }
    sendJson({
      event_id: eventId(),
      type: 'session.update',
      session,
    });
  };

  socket.on('open', () => {
    // Wait for session.created before session.update (server speaks first).
  });

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      return;
    }
    const raw = typeof data === 'string' ? data : toUtf8(data);
    const msg = parseMessage(raw);
    if (msg === null) {
      handlers.onError(new Error(`invalid STT JSON: ${raw}`));
      return;
    }
    const type = asText(msg.type);
    if (type === 'session.created') {
      sendSessionUpdate();
      return;
    }
    if (type === 'session.updated') {
      ready = true;
      flush();
      handlers.onReady();
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.text') {
      const committed = asText(msg.text);
      const stash = asText(msg.stash);
      if (committed.length > 0) {
        handlers.onPartial({ text: committed, isFinal: true, speechFinal: false });
      }
      if (stash.length > 0) {
        handlers.onPartial({
          text: committed + stash,
          isFinal: false,
          speechFinal: false,
        });
      }
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      handlers.onPartial({
        text: asText(msg.transcript),
        isFinal: true,
        speechFinal: true,
      });
      return;
    }
    if (type === 'session.finished') {
      handlers.onDone(asText(msg.transcript));
      return;
    }
    if (type === 'error' || type === 'conversation.item.input_audio_transcription.failed') {
      handlers.onError(new Error(errorMessage(msg)));
    }
  });

  socket.on('error', (error) => {
    handlers.onError(error);
  });

  return {
    sendAudio(chunk: Buffer): void {
      if (!ready || socket.readyState !== WebSocket.OPEN) {
        pending.push(chunk);
        return;
      }
      sendAudioFrame(chunk);
    },
    done(): void {
      sendJson({ event_id: eventId(), type: 'session.finish' });
    },
    close(): void {
      pending.length = 0;
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    },
  };
}

export const defaultSttStreamFactory: SttStreamFactory = connectQwenStt;
