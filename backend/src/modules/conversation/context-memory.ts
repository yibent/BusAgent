import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { fromMysqlDatetime } from '../../persistence/db/mysql-datetime.js';
import { DatabaseConnection } from '../../persistence/db/client.js';
import type { QueueState } from '../../apps/desktop-robot/intelligence/types.js';
import {
  compactContext,
  memoryEntry,
  taskMemory,
  MEMORY_TYPES,
} from './context-format.js';
import { ContextCompression } from './context-compression.js';
export {
  compactContext,
  estimateTokens,
  memoryEntry,
  conversationEpisodes,
  taskMemory,
} from './context-format.js';
const receivedIso = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : String(value).includes('T')
      ? new Date(String(value)).toISOString()
      : fromMysqlDatetime(String(value));
const cursorOf = (row: RowDataPacket) =>
  `${receivedIso(row.received_at)}|${String(row.event_id)}`;
const decode = (x: unknown): unknown =>
  typeof x === 'string' ? (JSON.parse(x) as unknown) : x;
@Injectable()
export class ContextMemory {
  constructor(
    private readonly db: DatabaseConnection,
    @Optional() private readonly compression?: ContextCompression,
  ) {}

  /** Materialized memory is a projection of the immutable Bus archive. */
  async materialize(conversation: string) {
    const history = await this.history(conversation, { limit: 80 });
    if (!history.entries.length || !('source_cursor' in history)) return;
    const version = createHash('sha256')
      .update(JSON.stringify({ conversation, history }))
      .digest('hex');
    const snapshot = { ...history, version };
    await this.db.pool.query(
      'INSERT INTO busagent_conversation_memory (conversation_id, source_cursor, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE payload = IF(VALUES(source_cursor) >= source_cursor, VALUES(payload), payload), source_cursor = GREATEST(source_cursor, VALUES(source_cursor)), updated_at = CURRENT_TIMESTAMP(3)',
      [conversation, history.source_cursor, JSON.stringify(snapshot)],
    );
    return snapshot;
  }

  async view(conversation: string, budget = 4500) {
    const [history, queue] = await Promise.all([
      this.currentHistory(conversation),
      this.db.pool.query<RowDataPacket[]>(
        'SELECT payload FROM busagent_goal_queue WHERE id = ?',
        ['arm-01'],
      ),
    ]);
    const state = queue[0][0] ? (decode(queue[0][0].payload) as QueueState) : undefined;
    const working = state ? taskMemory(state) : {};
    const view = this.compression
      ? await this.compression.conversation(
          conversation,
          history.entries,
          working,
          budget,
        )
      : compactContext(history.entries, working, budget);
    return {
      ...view,
      older_history_available: history.has_more,
      archive_before: 'before' in history ? history.before : undefined,
    };
  }

  private async currentHistory(conversation: string) {
    const [head, saved] = await Promise.all([
      this.db.pool.query<RowDataPacket[]>(
        `SELECT event_id, received_at FROM busagent_events WHERE correlation_id = ? AND event_type IN (${MEMORY_TYPES.map(() => '?').join(',')}) ORDER BY received_at DESC, event_id DESC LIMIT 1`,
        [conversation, ...MEMORY_TYPES],
      ),
      this.db.pool.query<RowDataPacket[]>(
        'SELECT source_cursor, payload FROM busagent_conversation_memory WHERE conversation_id = ?',
        [conversation],
      ),
    ]);
    const cursor = head[0][0] ? cursorOf(head[0][0]) : '';
    if (cursor && saved[0][0]?.source_cursor === cursor)
      return decode(saved[0][0].payload) as Awaited<
        ReturnType<ContextMemory['history']>
      >;
    // Memory and dialogue run in parallel. Never wait for the worker or serve
    // an older materialization when the user's new event is already archived.
    return this.history(conversation, { limit: 80 });
  }

  async history(
    conversation: string,
    options: { query?: string; ref?: string; before?: string; limit?: number } = {},
  ) {
    const limit = Math.max(1, Math.min(80, Math.trunc(options.limit ?? 20)));
    // Goal refs address the shared robot queue. Conversation text stays session-scoped.
    if (options.ref?.startsWith('goal_')) {
      const [rows] = await this.db.pool.query<RowDataPacket[]>(
        'SELECT payload FROM busagent_goal_queue WHERE id = ?',
        ['arm-01'],
      );
      const state = rows[0] ? (decode(rows[0].payload) as QueueState) : undefined;
      const goal = state?.goals.find((g) => g.id === options.ref);
      return {
        entries: goal
          ? [{ ...taskMemory({ ...state!, goals: [goal] }), ref: goal.id }]
          : [],
        has_more: false,
      };
    }
    const conditions = [
      'correlation_id = ?',
      `event_type IN (${MEMORY_TYPES.map(() => '?').join(',')})`,
    ];
    const params: unknown[] = [conversation, ...MEMORY_TYPES];
    if (options.ref) {
      conditions.push('event_id = ?');
      params.push(options.ref);
    }
    if (options.before) {
      const [at, id] = options.before.split('|');
      const date = new Date(at!);
      if (!Number.isFinite(date.getTime())) throw new Error('历史分页游标无效');
      if (id) {
        conditions.push('(received_at < ? OR (received_at = ? AND event_id < ?))');
        params.push(
          date.toISOString().slice(0, 23).replace('T', ' '),
          date.toISOString().slice(0, 23).replace('T', ' '),
          id,
        );
      } else {
        conditions.push('received_at < ?');
        params.push(date.toISOString().slice(0, 23).replace('T', ' '));
      }
    }
    if (options.query) {
      conditions.push(
        "JSON_UNQUOTE(JSON_EXTRACT(event_json, '$.payload.text')) LIKE ?",
      );
      params.push(`%${options.query.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const [rows] = await this.db.pool.query<RowDataPacket[]>(
      `SELECT event_id, event_json, received_at FROM busagent_events WHERE ${conditions.join(' AND ')} ORDER BY received_at DESC, event_id DESC LIMIT ${limit + 1}`,
      params,
    );
    const selected = rows.slice(0, limit);
    return {
      entries: selected.reverse().map((row) => memoryEntry(decode(row.event_json))),
      has_more: rows.length > limit,
      source_cursor: rows[0] ? cursorOf(rows[0]) : '',
      before: selected[0] ? cursorOf(selected[0]) : undefined,
    };
  }
}
