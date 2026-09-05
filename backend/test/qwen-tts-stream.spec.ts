import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectQwenTts } from '../src/modules/tts/qwen-tts-stream.js';

const sockets = vi.hoisted(
  () =>
    [] as Array<{
      sent: Array<Record<string, unknown>>;
      emit: (type: string) => void;
      close: ReturnType<typeof vi.fn>;
    }>,
);
vi.mock('ws', () => ({
  WebSocket: class {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    handlers = new Map<string, (...args: unknown[]) => void>();
    close = vi.fn();
    constructor() {
      sockets.push(this);
    }
    on(name: string, callback: (...args: unknown[]) => void) {
      this.handlers.set(name, callback);
    }
    send(text: string) {
      this.sent.push(JSON.parse(text) as Record<string, unknown>);
    }
    emit(type: string) {
      this.handlers.get('message')?.(Buffer.from(JSON.stringify({ type })), false);
    }
  },
}));

describe('Qwen TTS committed segments', () => {
  beforeEach(() => {
    sockets.length = 0;
  });
  it('commits early, serializes response audio, then finishes after the final segment', () => {
    const onDone = vi.fn();
    const connection = connectQwenTts(
      {
        apiKey: 'test',
        wsUrl: 'wss://example.test',
        model: 'tts',
        voice: 'Cherry',
        languageType: 'Chinese',
        sampleRate: 24000,
      },
      { onReady: vi.fn(), onAudio: vi.fn(), onError: vi.fn(), onDone },
    );
    const socket = sockets[0]!;
    socket.emit('session.created');
    expect(socket.sent[0]).toMatchObject({
      type: 'session.update',
      session: { mode: 'commit' },
    });
    socket.emit('session.updated');
    connection.appendText('第一段');
    connection.appendText('第二段');
    connection.finish();
    expect(socket.sent.map((e) => e.type)).toEqual([
      'session.update',
      'input_text_buffer.append',
      'input_text_buffer.commit',
    ]);
    socket.emit('response.done');
    expect(onDone).not.toHaveBeenCalled();
    expect(socket.sent.at(-2)).toMatchObject({
      type: 'input_text_buffer.append',
      text: '第二段',
    });
    expect(socket.sent.at(-1)?.type).toBe('input_text_buffer.commit');
    socket.emit('response.done');
    expect(socket.sent.at(-1)?.type).toBe('session.finish');
    socket.emit('session.finished');
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('never submits queued segments after interruption', () => {
    const connection = connectQwenTts(
      {
        apiKey: 'test',
        wsUrl: 'wss://example.test',
        model: 'tts',
        voice: 'Cherry',
        languageType: 'Chinese',
        sampleRate: 24000,
      },
      { onReady: vi.fn(), onAudio: vi.fn(), onError: vi.fn(), onDone: vi.fn() },
    );
    const socket = sockets[0]!;
    socket.emit('session.updated');
    connection.appendText('第一段');
    connection.appendText('不要播报');
    connection.close();
    socket.emit('response.done');
    expect(socket.sent.map((e) => e.type)).toEqual([
      'input_text_buffer.append',
      'input_text_buffer.commit',
    ]);
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
