import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2';
import { DatabaseConnection } from '../../../persistence/db/client.js';
import type { InProcessPublishInput } from '../../../adapters/in-process/agent-classes.js';
import { emptyQueue, type QueueState } from './types.js';

export interface QueuedEvent {
  key: string;
  event: InProcessPublishInput;
}
export interface TaskStore {
  read(): Promise<QueueState>;
  change<T>(
    mutate: (state: QueueState, emit: (entry: QueuedEvent) => void) => T,
  ): Promise<T>;
  pending(): Promise<QueuedEvent[]>;
  delivered(key: string): Promise<void>;
}
const decode = (value: unknown): QueueState =>
  typeof value === 'string' ? (JSON.parse(value) as QueueState) : (value as QueueState);

/** A locked arm queue and transactional outbox; no physical command is sent from a DB transaction. */
@Injectable()
export class QueueStore implements TaskStore {
  constructor(private readonly db: DatabaseConnection) {}
  async read(): Promise<QueueState> {
    const [rows] = await this.db.pool.query<RowDataPacket[]>(
      'SELECT payload FROM busagent_goal_queue WHERE id = ?',
      ['arm-01'],
    );
    return rows[0] ? decode(rows[0].payload) : emptyQueue();
  }
  async change<T>(
    mutate: (state: QueueState, emit: (entry: QueuedEvent) => void) => T,
  ): Promise<T> {
    const connection = await this.db.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        'INSERT IGNORE INTO busagent_goal_queue (id, payload) VALUES (?, ?)',
        ['arm-01', JSON.stringify(emptyQueue())],
      );
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT payload FROM busagent_goal_queue WHERE id = ? FOR UPDATE',
        ['arm-01'],
      );
      const state = decode(rows[0]!.payload);
      const events: QueuedEvent[] = [];
      const result = mutate(state, (entry) => events.push(entry));
      state.revision++;
      await connection.query(
        'UPDATE busagent_goal_queue SET payload = ? WHERE id = ?',
        [JSON.stringify(state), 'arm-01'],
      );
      for (const entry of events)
        await connection.query(
          'INSERT IGNORE INTO busagent_goal_outbox (id, payload) VALUES (?, ?)',
          [entry.key, JSON.stringify(entry.event)],
        );
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  async pending(): Promise<QueuedEvent[]> {
    const [rows] = await this.db.pool.query<RowDataPacket[]>(
      'SELECT id, payload FROM busagent_goal_outbox WHERE sent = 0 ORDER BY sequence_id LIMIT 32',
    );
    return rows.map((row) => ({
      key: String(row.id),
      event:
        typeof row.payload === 'string'
          ? (JSON.parse(row.payload) as InProcessPublishInput)
          : (row.payload as InProcessPublishInput),
    }));
  }
  async delivered(key: string): Promise<void> {
    await this.db.pool.query('UPDATE busagent_goal_outbox SET sent = 1 WHERE id = ?', [
      key,
    ]);
  }
}
