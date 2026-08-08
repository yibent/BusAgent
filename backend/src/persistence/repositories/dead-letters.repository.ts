import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseConnection } from '../db/client.js';
import { deadLetters } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';
import { Clock } from '../../common/clock.js';

export interface DeadLetterEntry {
  eventId: string;
  appId: string;
  agentId: string;
  reason: string;
  detail: Record<string, unknown> | null;
}

@Injectable()
export class DeadLettersRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly clock: Clock,
  ) {}

  async insert(entry: DeadLetterEntry): Promise<void> {
    await this.db.db
      .insert(deadLetters)
      .values({
        id: randomUUID(),
        event_id: entry.eventId,
        app_id: entry.appId,
        agent_id: entry.agentId,
        reason: entry.reason,
        detail_json: entry.detail,
        status: 'dead',
        created_at: toMysqlDatetime(this.clock.now()),
        redelivered_at: null,
      })
      .execute();
  }

  async list(): Promise<
    Array<{ id: string; eventId: string; agentId: string; reason: string }>
  > {
    const rows = await this.db.db
      .select()
      .from(deadLetters)
      .orderBy(deadLetters.created_at)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      agentId: row.agent_id,
      reason: row.reason,
    }));
  }

  async markRedelivered(id: string): Promise<void> {
    await this.db.db
      .update(deadLetters)
      .set({ status: 'redelivered', redelivered_at: toMysqlDatetime(this.clock.now()) })
      .where(eq(deadLetters.id, id))
      .execute();
  }
}
