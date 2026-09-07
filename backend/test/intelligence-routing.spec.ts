import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  routedCompletion,
  clearModelCooldowns,
} from '../src/apps/desktop-robot/intelligence/model-routing.js';
import { independentAhead } from '../src/apps/desktop-robot/intelligence/lookahead.js';
import type { ModelProfile } from '../src/apps/desktop-robot/intelligence/model-config.js';
import type { Decision } from '../src/apps/desktop-robot/intelligence/types.js';

beforeEach(() => clearModelCooldowns());
afterEach(() => vi.restoreAllMocks());
const primary: ModelProfile = {
  id: 'plus',
  name: 'plus',
  provider: 'qwen',
  baseUrl: 'https://example.test/v1',
  model: 'plus',
  apiKey: 'test',
  thinking: false,
  vision: true,
  enabled: true,
};
const backup = { ...primary, id: 'max', model: 'max' };
const answer = {
  message: { role: 'assistant' as const, content: 'OK' },
  usage: {},
  model: 'max',
  elapsed_ms: 1,
};
it('falls back once and avoids a failed provider on later tool rounds', async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error('HTTP 503'))
    .mockResolvedValue(answer);
  const record = vi.fn().mockResolvedValue(undefined);
  const failed = new Set<string>();
  await routedCompletion(
    [primary, backup],
    [],
    [],
    new AbortController().signal,
    record,
    call,
    failed,
  );
  await routedCompletion(
    [primary, backup],
    [],
    [],
    new AbortController().signal,
    record,
    call,
    failed,
  );
  expect(call.mock.calls.map((c) => (c[0] as ModelProfile).id)).toEqual([
    'plus',
    'max',
    'max',
  ]);
  expect(record.mock.calls[0]![0]).toMatchObject({
    kind: 'provider_failure',
    profile: 'plus',
  });
});
it('does not send images to a text-only fallback', async () => {
  const call = vi.fn().mockRejectedValue(new Error('HTTP 503'));
  await expect(
    routedCompletion(
      [primary, { ...backup, vision: false }],
      [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } },
          ],
        },
      ],
      [],
      new AbortController().signal,
      vi.fn().mockResolvedValue(undefined),
      call,
    ),
  ).rejects.toThrow('503');
  expect(call).toHaveBeenCalledTimes(1);
});
it('cancellation never launches a fallback request', async () => {
  const abort = new AbortController();
  const call = vi.fn().mockImplementation(() => {
    abort.abort();
    return Promise.reject(new Error('cancelled'));
  });
  await expect(
    routedCompletion(
      [primary, backup],
      [],
      [],
      abort.signal,
      vi.fn().mockResolvedValue(undefined),
      call,
    ),
  ).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(1);
});

describe('independent lookahead guard', () => {
  const current = {
    title: 'first',
    skill: 'pick_place',
    params: { target: 'orange gear', destination: { label: 'blue tray' } },
    review_after: false,
  };
  const decision: Decision = {
    mode: 'simple',
    outcome: 'continue',
    summary: 'next',
    completion: 'placed',
    message: '',
    actions: [
      {
        title: 'next',
        skill: 'pick_place',
        params: { target: 'cyan ring', destination: { label: 'yellow tray' } },
        review_after: false,
      },
    ],
  };
  it('permits independent explicit goals but rejects shared regions or fresh semantic decisions', () => {
    expect(independentAhead(decision, current)).toBe(true);
    expect(independentAhead({ ...decision, mode: 'complex' }, current)).toBe(false);
    expect(
      independentAhead(
        {
          ...decision,
          actions: [
            {
              ...decision.actions[0]!,
              params: { target: 'cyan ring', destination: { label: 'blue tray' } },
            },
          ],
        },
        current,
      ),
    ).toBe(false);
    expect(
      independentAhead(
        {
          ...decision,
          actions: [
            {
              ...decision.actions[0]!,
              params: {
                target: 'ring inside blue tray',
                destination: { label: 'yellow tray' },
              },
            },
          ],
        },
        current,
      ),
    ).toBe(false);
  });
});

it('shares provider cooldown across requests and probes it again after expiry', async () => {
  let now = 100000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValue(answer);
  const record = vi.fn();
  const request = () =>
    routedCompletion(
      [primary, backup],
      [],
      [],
      new AbortController().signal,
      record,
      call,
    );
  await request();
  await request();
  expect(call.mock.calls.map((c) => (c[0] as ModelProfile).id)).toEqual([
    'plus',
    'max',
    'max',
  ]);
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'provider_cooldown', profile: 'plus' }),
  );
  now += 31000;
  await request();
  expect((call.mock.calls.at(-1)![0] as ModelProfile).id).toBe('plus');
});
