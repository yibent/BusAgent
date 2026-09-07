import { describe, expect, it, vi } from 'vitest';
import {
  selectImageObject,
  normalizeSelectionBox,
} from '../src/apps/desktop-robot/intelligence/visual-grounding.js';
const profile = {
  id: 'visual',
  name: 'Visual',
  provider: 'gemini' as const,
  baseUrl: 'http://example.test/v1',
  model: 'test',
  apiKey: 'test',
  vision: true,
  thinking: false,
  enabled: true,
};
const answer = (content: unknown) => ({
  model: 'test',
  elapsed_ms: 5,
  usage: {},
  message: { role: 'assistant' as const, content: JSON.stringify(content) },
});
describe('short-context visual grounding', () => {
  it('accepts structured tools or an explanatory fenced reply without repeating vision', async () => {
    const selected = {
      found: true,
      box_normalized: [0.5, 0.3, 0.56, 0.36],
      description: 'part {inside}',
      uncertainty: '',
    };
    for (const message of [
      {
        role: 'assistant' as const,
        content: 'Based on the image:\n```json\n' + JSON.stringify(selected) + '\n```',
      },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'box',
            type: 'function' as const,
            function: { name: 'select_box', arguments: JSON.stringify(selected) },
          },
        ],
      },
    ]) {
      const call = vi.fn().mockResolvedValue({ ...answer(selected), message });
      const result = await selectImageObject(
        [profile],
        Buffer.from('pixels'),
        'inside part',
        new AbortController().signal,
        vi.fn(),
        call,
      );
      expect(result.box_normalized).toEqual(selected.box_normalized);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
  it('keeps relation selection isolated from task history and records model cost', async () => {
    const call = vi.fn().mockResolvedValue(
      answer({
        found: true,
        box_normalized: [0.5, 0.3, 0.56, 0.36],
        description: 'bin interior',
      }),
    );
    const record = vi.fn();
    const r = await selectImageObject(
      [profile],
      Buffer.from('pixels'),
      'part inside the lower bin',
      new AbortController().signal,
      record,
      call,
    );
    expect(r.box_normalized).toEqual([0.5, 0.3, 0.56, 0.36]);
    expect(call.mock.calls[0]![1]).toHaveLength(1);
    expect(JSON.stringify(call.mock.calls[0]![1])).toContain(
      'part inside the lower bin',
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'model', role: 'visual_selector' }),
    );
  });
  it('does not turn a missing object or malformed coordinates into a robot reference', async () => {
    for (const result of [
      { found: false, uncertainty: 'occluded' },
      { found: true, box_normalized: [0.7, 0.3, 0.2, 0.5] },
      { found: true, box_normalized: [0, 0, 2, 1] },
    ]) {
      await expect(
        selectImageObject(
          [profile],
          Buffer.from('pixels'),
          'part',
          new AbortController().signal,
          vi.fn(),
          vi.fn().mockResolvedValue(answer(result)),
        ),
      ).rejects.toThrow();
    }
  });
});

describe('Gemini native box coordinates', () => {
  it('converts YX 0..1000 to XY 0..1 without swapping axes', async () => {
    const call = vi
      .fn()
      .mockResolvedValue(answer({ found: true, box_2d: [300, 500, 360, 560] }));
    const result = await selectImageObject(
      [profile],
      Buffer.from('pixels'),
      'part',
      new AbortController().signal,
      vi.fn(),
      call,
    );
    expect(result.box_normalized).toEqual([0.5, 0.3, 0.56, 0.36]);
    expect(call.mock.calls[0]![4]).toEqual({ maxTokens: 1536 });
  });
  it.each([
    { box_2d: [500, 100, 300, 200] },
    { box_2d: [0, 0, 2000, 1000] },
    { box_2d: [0, 0, 500, NaN] },
    { box_2d: [100, 200, 300, 400], box_normalized: [0.1, 0.2, 0.3, 0.4] },
  ])('rejects invalid or contradictory box coordinates: %j', (selection) => {
    expect(() => normalizeSelectionBox(selection)).toThrow();
  });
});
