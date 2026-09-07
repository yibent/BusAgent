import { beforeEach, expect, it, vi } from 'vitest';
import { connectQwenStt } from '../src/modules/stt/qwen-stt-stream.js';
const sockets = vi.hoisted(
  () => [] as Array<{ emit: (value: Record<string, unknown>) => void }>,
);
vi.mock('ws', () => ({
  WebSocket: class {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    handlers = new Map<string, (...args: unknown[]) => void>();
    constructor() {
      sockets.push(this);
    }
    on(name: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(name, handler);
    }
    send() {}
    close() {}
    emit(value: Record<string, unknown>) {
      this.handlers.get('message')?.(Buffer.from(JSON.stringify(value)), false);
    }
  },
}));
beforeEach(() => {
  sockets.length = 0;
});
it('deduplicates provider events and completed item replays, but permits repeated words in distinct utterances', () => {
  const onPartial = vi.fn();
  connectQwenStt(
    {
      apiKey: 'test',
      wsUrl: 'wss://test.example',
      model: 'asr',
      sampleRate: 16000,
      encoding: 'pcm',
      endpointingMs: 800,
    },
    { onPartial, onReady: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
  );
  const socket = sockets[0]!;
  socket.emit({
    type: 'conversation.item.input_audio_transcription.text',
    event_id: 'e1',
    item_id: 'item1',
    text: '刚才',
    stash: '做了什么',
  });
  socket.emit({
    type: 'conversation.item.input_audio_transcription.text',
    event_id: 'e1',
    item_id: 'item1',
    text: '刚才',
    stash: '做了什么',
  });
  for (const id of ['e2', 'e3'])
    socket.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: id,
      item_id: 'item1',
      transcript: '刚才做了什么',
    });
  socket.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    event_id: 'e4',
    item_id: 'item2',
    transcript: '刚才做了什么',
  });
  expect(onPartial.mock.calls.filter(([p]) => p.speechFinal)).toHaveLength(2);
  expect(onPartial).toHaveBeenCalledTimes(4);
});
