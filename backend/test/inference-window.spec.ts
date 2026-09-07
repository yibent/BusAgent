/* eslint-disable @typescript-eslint/require-await -- asynchronous archive test doubles */
import { describe, expect, it } from 'vitest';
import {
  InferenceWindow,
  inferenceSize,
} from '../src/apps/desktop-robot/intelligence/context-window.js';
import {
  PLANNER_SYSTEM,
  SUPERVISOR_SYSTEM,
} from '../src/apps/desktop-robot/intelligence/agent-prompts.js';
import { roleTools } from '../src/apps/desktop-robot/intelligence/planning.js';
import type { Message } from '../src/apps/desktop-robot/intelligence/model-client.js';

describe('bounded retrievable agent context', () => {
  it('separates planner and supervisor instructions, tools and output contracts', () => {
    expect(PLANNER_SYSTEM).toContain('robot.planning');
    expect(SUPERVISOR_SYSTEM).toContain('robot.supervision');
    expect(SUPERVISOR_SYSTEM).not.toContain('manage_queue');
    expect(roleTools('planner').some((t) => t.function.name === 'submit_plan')).toBe(
      true,
    );
    expect(roleTools('supervisor').map((t) => t.function.name)).not.toContain(
      'submit_plan',
    );
    expect(roleTools('supervisor').map((t) => t.function.name)).not.toContain(
      'manage_queue',
    );
    expect(roleTools('supervisor').map((t) => t.function.name)).toContain(
      'submit_review',
    );
  });

  it('pages omitted evidence exactly, including after a new inference window', async () => {
    const saved = new Map<string, unknown>();
    const archive = async (ref: string, value: unknown) => {
      saved.set(ref, value);
    };
    const retrieve = async (ref: string) => saved.get(ref);
    const window = new InferenceWindow(12000, 800, archive, retrieve);
    const raw = {
      ok: true,
      geometry: {
        cells: Array.from({ length: 1000 }, (_, i) => ({
          ref: `obs:${'a'.repeat(32)}:side_camera:${i}`,
          row: Math.floor(i / 10),
          column: i % 10,
          occupancy: i === 903 ? 'unknown' : 'empty',
        })),
      },
    };
    const compact = await window.toolResult('inspect_object', raw);
    expect(compact.omitted_path_count).toBeGreaterThan(0);
    expect(saved.size).toBe(1);
    const resumed = new InferenceWindow(12000, 800, archive, retrieve);
    const page = await resumed.read(compact.evidence_ref, '/geometry/cells', 903, 4);
    expect(page).toMatchObject({
      offset: 903,
      total: 1000,
      next_offset: 907,
      items: [{ ...raw.geometry.cells[903] }, ...raw.geometry.cells.slice(904, 907)],
    });
    const duplicate = await window.toolResult('inspect_object', raw);
    expect(duplicate.evidence_ref).toBe(compact.evidence_ref);
    expect(duplicate.repeated_evidence).toBe(true);
    await expect(resumed.read('missing')).rejects.toThrow('证据不存在');
  });

  it('bounds a long tool loop without orphan calls, lost user constraints or invalid JSON', async () => {
    const window = new InferenceWindow(6500, 1000);
    const request = '只整理指定区域；第二排第三格；闭口朝上；不要搬走未装满的箱子。';
    const messages: Message[] = [
      { role: 'system', content: PLANNER_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          source: request,
          holding: { verified: true, object_id: 'object:part' },
        }),
      },
    ];
    const tools = roleTools('planner');
    let compacted = 0;
    for (let round = 0; round < 18; round++) {
      const id = `read-${round}`;
      const result = await window.toolResult('read_state', {
        ok: true,
        holding: { verified: true, object_id: 'object:part' },
        objects: Array.from({ length: 80 }, (_, i) => ({
          label: 'industrial shaft',
          ref: `object:${round}:${i}`,
          score: 0.9,
          description: 'surface and geometry '.repeat(20),
        })),
      });
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id, type: 'function', function: { name: 'read_state', arguments: '{}' } },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify(result),
      });
      const metrics = window.prepare(messages, tools);
      compacted += metrics.compacted_rounds;
      expect(
        metrics.text_tokens + metrics.tool_tokens + metrics.image_reserve_tokens,
      ).toBeLessThanOrEqual(6500);
      expect(messages[1]!.content).toContain(request);
      const calls = messages.flatMap((m) => m.tool_calls ?? []);
      const outputs = messages.filter((m) => m.role === 'tool');
      expect(outputs.map((m) => m.tool_call_id).sort()).toEqual(
        calls.map((c) => c.id).sort(),
      );
      for (const output of outputs)
        expect(() => {
          JSON.parse(typeof output.content === 'string' ? output.content : '{}');
        }).not.toThrow();
    }
    expect(compacted).toBeGreaterThan(0);
    expect(window.evidence.size).toBe(18);
  });

  it('does not silently truncate an oversized user constraint to make an action fit', () => {
    const window = new InferenceWindow(6000);
    const messages: Message[] = [
      { role: 'system', content: 'planner' },
      { role: 'user', content: '不许遗漏的约束'.repeat(9000) },
    ];
    expect(() => window.prepare(messages, [])).toThrow('不会截断用户约束');
    expect(messages[1]!.content).toHaveLength(7 * 9000);
  });

  it('accounts for images without treating base64 bytes as text tokens', () => {
    const result = inferenceSize(
      [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,' + 'A'.repeat(100000) },
            },
          ],
        },
      ],
      [],
    );
    expect(result.text_tokens).toBeLessThan(100);
    expect(result.image_count).toBe(1);
    expect(result.image_reserve_tokens).toBe(2048);
  });
});
