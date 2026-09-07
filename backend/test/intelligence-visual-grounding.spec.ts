import { describe, expect, it, vi } from 'vitest';
import { selectImageObject } from '../src/apps/desktop-robot/intelligence/visual-grounding.js';
const profile = {
  id: 'visual',
  name: 'Visual',
  provider: 'qwen' as const,
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
    expect(call.mock.calls[0][1]).toHaveLength(1);
    expect(JSON.stringify(call.mock.calls[0][1])).toContain(
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
