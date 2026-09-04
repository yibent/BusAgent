import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contentDeltaFromSseData,
  streamQwenChat,
  takeSseLineBatch,
} from '../src/modules/dialogue/qwen-chat.js';

describe('contentDeltaFromSseData', () => {
  it('extracts incremental chat content', () => {
    expect(
      contentDeltaFromSseData(
        JSON.stringify({ choices: [{ delta: { content: '你好' } }] }),
      ),
    ).toBe('你好');
  });

  it('ignores done and empty chunks', () => {
    expect(contentDeltaFromSseData('[DONE]')).toBeUndefined();
    expect(contentDeltaFromSseData('{"choices":[{"delta":{}}]}')).toBeUndefined();
  });
});

describe('takeSseLineBatch', () => {
  it('keeps the incomplete trailing line in rest', () => {
    const batch = takeSseLineBatch('data: {"choices":[{"delta":{"content":"你"}}]}\ndata: {"choi');
    expect(batch.deltas).toEqual(['你']);
    expect(batch.done).toBe(false);
    expect(batch.rest).toBe('data: {"choi');
  });

  it('stops at [DONE]', () => {
    const batch = takeSseLineBatch('data: {"choices":[{"delta":{"content":"好"}}]}\ndata: [DONE]\nignored\n');
    expect(batch.deltas).toEqual(['好']);
    expect(batch.done).toBe(true);
    expect(batch.rest).toBe('');
  });
});

describe('streamQwenChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('yields content deltas from an SSE body', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n'),
        );
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\ndata: [DONE]\n'),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          body: stream,
        }),
      ),
    );

    const parts: string[] = [];
    for await (const delta of streamQwenChat({
      apiKey: 'k',
      url: 'https://example.test/chat',
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      parts.push(delta);
    }
    expect(parts).toEqual(['你', '好']);
  });

  it('throws on HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve('unauthorized'),
          body: null,
        }),
      ),
    );
    await expect(
      streamQwenChat({
        apiKey: 'k',
        url: 'https://example.test/chat',
        model: 'qwen-plus',
        messages: [],
      }).next(),
    ).rejects.toThrow(/HTTP 401/);
  });
});
