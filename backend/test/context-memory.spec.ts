import { describe, expect, it, vi } from 'vitest';
import {
  compactContext,
  ContextMemory,
  estimateTokens,
  memoryEntry,
  conversationEpisodes,
} from '../src/modules/conversation/context-memory.js';
import type { DatabaseConnection } from '../src/persistence/db/client.js';

describe('durable context views', () => {
  it('consolidates repeated progress receipts while keeping the user constraint and authoritative failure separate', () => {
    const rows = [
      memoryEntry({
        eventId: 'input',
        eventType: 'intent.created',
        payload: { text: '放好后不要再次抓取' },
      }),
      ...Array.from({ length: 20 }, (_, i) =>
        memoryEntry({
          eventId: `progress-${i}`,
          eventType: 'intelligence.reply',
          payload: { instruction_id: 'input', text: `阶段${i}`, goal_state: 'running' },
        }),
      ),
      memoryEntry({
        eventId: 'failed',
        eventType: 'execution.failed',
        payload: { result: { ok: false, failure: 'slipped' }, instruction_id: 'input' },
      }),
    ];
    const episodes = conversationEpisodes(rows);
    expect(episodes).toHaveLength(1);
    expect(JSON.stringify(episodes)).toContain('不要再次抓取');
    expect(JSON.stringify(episodes)).toContain('slipped');
    expect(JSON.stringify(episodes)).not.toContain('阶段18');
    expect(estimateTokens(episodes)).toBeLessThan(estimateTokens(rows) / 3);
  });
  it('preserves working constraints and negative evidence under a bounded budget', () => {
    const entries = Array.from({ length: 120 }, (_, i) =>
      memoryEntry({
        eventId: `e${i}`,
        eventType: 'intent.created',
        payload: { text: `第${i}项要求，禁止翻转。`.repeat(8) },
      }),
    );
    entries.push(
      memoryEntry({
        eventId: 'failure',
        eventType: 'execution.failed',
        payload: {
          result: {
            ok: false,
            failure: 'slipped',
            evaluation: { physical_success: false },
            image: 'data:big',
          },
        },
      }),
    );
    const view = compactContext(
      entries,
      {
        holding: { verified: true },
        active: [
          {
            ref: 'goal_a',
            source: '先拿着，暂时不要放下',
            state: 'paused',
            revision: 3,
            completion: '等待后续指令',
          },
        ],
      },
      1800,
    );
    expect(estimateTokens(view)).toBeLessThanOrEqual(1800);
    expect(view.omitted).toBeGreaterThan(0);
    expect(JSON.stringify(view)).toContain('暂时不要放下');
    expect(JSON.stringify(view)).toContain('physical_success":false');
    expect(JSON.stringify(view)).not.toContain('data:big');
    expect(view.recent.at(-1)?.ref).toBe('failure');
  });
  it('distinguishes assistant claims from measured outcomes', () => {
    expect(
      memoryEntry({ eventType: 'reply.created', payload: { text: '成功了' } })
        .authority,
    ).toBe('reported_speech');
    expect(
      memoryEntry({ eventType: 'execution.failed', payload: { ok: false } }).authority,
    ).toBe('execution_evidence');
  });
  it('retrieves the full original message from the durable, session-scoped archive after compaction/restart', async () => {
    const original = {
      eventId: 'original',
      eventType: 'intent.created',
      payload: { text: '不要重试；先解释原因，再等我指定放哪里。' },
    };
    const query = vi
      .fn()
      .mockResolvedValue([
        [{ event_json: JSON.stringify(original), received_at: new Date() }],
      ]);
    const memory = new ContextMemory({
      pool: { query },
    } as unknown as DatabaseConnection);
    const result = await memory.history('one-session', { ref: 'original' });
    expect(result.entries[0]).toMatchObject({
      ref: 'original',
      text: original.payload.text,
    });
    expect(query.mock.calls[0]?.[0]).toContain('correlation_id = ?');
    expect(query.mock.calls[0]?.[1]).toContain('one-session');
  });
});
