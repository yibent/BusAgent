import { describe, expect, it, vi } from 'vitest';
import {
  compactContext,
  ContextMemory,
  estimateTokens,
  memoryEntry,
  conversationEpisodes,
} from '../src/modules/conversation/context-memory.js';
import { ContextCompression } from '../src/modules/conversation/context-compression.js';
import {
  MemoryAgent,
  ContextCompressionAgent,
} from '../src/modules/conversation/memory-agents.js';
import { makeEvent } from './helpers.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';
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

describe('asynchronous memory and context workers', () => {
  it('uses a current materialization but bypasses it when a new user event arrives', async () => {
    let latest = 'e1';
    const at = '2026-09-07 10:00:00.000';
    const saved = { entries: [{ text: 'old request' }], has_more: false };
    const query = vi.fn((sql: string) => {
      // Query doubles are synchronously resolved; callers still await them.
      if (sql.startsWith('SELECT event_id, received_at'))
        return [[{ event_id: latest, received_at: at }]];
      if (sql.includes('FROM busagent_conversation_memory'))
        return [[{ source_cursor: '2026-09-07T10:00:00.000Z|e1', payload: saved }]];
      if (sql.includes('FROM busagent_goal_queue')) return [[]];
      if (sql.includes('FROM busagent_events'))
        return [
          [
            {
              event_id: latest,
              received_at: at,
              event_json: {
                eventId: latest,
                eventType: 'intent.created',
                payload: { text: 'new constraint: do not place' },
              },
            },
          ],
        ];
      return [[]];
    });
    const memory = new ContextMemory({
      pool: { query },
    } as unknown as DatabaseConnection);
    const first = await memory.view('session', 2400);
    expect(JSON.stringify(first)).toContain('old request');
    expect(
      query.mock.calls.some(([sql]) => sql.startsWith('SELECT event_id, event_json')),
    ).toBe(false);
    latest = 'e2';
    const second = await memory.view('session', 2400);
    expect(JSON.stringify(second)).toContain('new constraint: do not place');
    expect(JSON.stringify(second)).not.toContain('old request');
  });
  it('invalidates compressed views when live holding changes and scopes caches by conversation and budget', async () => {
    const cache = new Map<string, unknown>();
    const query = vi.fn((sql: string, args: unknown[]) => {
      const key = String(args[0]) + ':' + String(args[1]);
      if (sql.startsWith('SELECT')) return [cache.has(key) ? [cache.get(key)] : []];
      cache.set(key, {
        version: args[2],
        payload: JSON.parse(String(args[3])) as unknown,
      });
      return [[]];
    });
    const compressor = new ContextCompression({
      pool: { query },
    } as unknown as DatabaseConnection);
    const first = await compressor.conversation(
      'session',
      [],
      { holding: { verified: true } },
      2400,
    );
    const cached = await compressor.conversation(
      'session',
      [],
      { holding: { verified: true } },
      2400,
    );
    expect(cached.context_source).toBe('compression_cache');
    expect(cached.context_version).toBe(first.context_version);
    const released = await compressor.conversation(
      'session',
      [],
      { holding: { verified: false } },
      2400,
    );
    expect(released.context_version).not.toBe(first.context_version);
    expect(JSON.stringify(released)).toContain('"verified":false');
    expect((await compressor.conversation('other', [], {}, 2400)).context_source).toBe(
      'structured_compression',
    );
    expect(
      (await compressor.conversation('session', [], {}, 2000)).context_source,
    ).toBe('structured_compression');
  });
  it('publishes only metadata after durable materialization, with no model calls or recursive memory events', async () => {
    const memory = {
      materialize: vi.fn().mockResolvedValue({
        version: 'v1',
        source_cursor: 'cursor',
        entries: [{ text: 'private' }],
        has_more: false,
      }),
      view: vi.fn((_id: string, budget: number) => ({
        budget_tokens: budget,
        estimated_tokens: 80,
        omitted: 0,
      })),
    };
    const publish = vi.fn();
    const context = {
      event: makeEvent({ eventType: 'intent.created', correlationId: 'session' }),
      publish,
    } as unknown as InProcessEventContext;
    await new MemoryAgent(memory as unknown as ContextMemory).handle(context);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'memory.updated',
        idempotency_key: 'memory:v1',
      }),
    );
    expect(JSON.stringify(publish.mock.calls)).not.toContain('private');
    await new ContextCompressionAgent(memory as unknown as ContextMemory).handle({
      ...context,
      event: makeEvent({ eventType: 'memory.updated', correlationId: 'session' }),
    });
    expect(memory.view.mock.calls.map((c) => c[1])).toEqual([2000, 2400, 4200]);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event_type: 'context.compacted',
        payload: expect.objectContaining({ model_calls: 0 }) as unknown,
      }),
    );
    await new MemoryAgent(memory as unknown as ContextMemory).handle({
      ...context,
      event: makeEvent({ eventType: 'context.compacted' }),
    });
    expect(memory.materialize).toHaveBeenCalledTimes(1);
  });
});
