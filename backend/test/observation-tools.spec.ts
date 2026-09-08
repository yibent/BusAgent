import { afterEach, expect, it, vi } from 'vitest';
import { observeScene } from '../src/apps/desktop-robot/intelligence/observation-tools.js';
afterEach(() => vi.unstubAllGlobals());
it('observes through the read-only endpoint with no motion submission or polling', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, state: 'completed', collection: { instances: [] } }),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const result = await observeScene(
    'http://arena',
    { category: 'block' },
    'c',
    new AbortController().signal,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe('http://arena/api/observe');
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
    params: { category: 'block' },
    correlation_id: 'c',
  });
  expect(result.ok).toBe(true);
});
