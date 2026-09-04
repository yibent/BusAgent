import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseConnection } from '../db/client.js';
import { deliveries } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';

export type DeliveryStatus =
  | 'queued'
  | 'delivered'
  | 'retrying'
  | 'dead'
  | 'cancelled'
  | 'skipped'
  | 'unknown';

export interface RecoverableDelivery {
  id: string;
  eventId: string;
  appId: string;
  agentId: string;
  queueName: string;
  maxAttempts: number;
  attempts: number;
  /** Recorded `next_attempt_at` (MySQL DATETIME string) or null. */
  nextAttemptAt: string | null;
}

@Injectable()
export class DeliveriesRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async create(record: {
    id: string;
    eventId: string;
    appId: string;
    agentId: string;
    queueName: string;
    maxAttempts: number;
    createdAt: string;
  }): Promise<void> {
    await this.db.db
      .insert(deliveries)
      .values({
        id: record.id,
        event_id: record.eventId,
        app_id: record.appId,
        agent_id: record.agentId,
        queue_name: record.queueName,
        status: 'queued',
        attempts: 0,
        max_attempts: record.maxAttempts,
        next_attempt_at: null,
        last_error: null,
        created_at: toMysqlDatetime(record.createdAt),
        updated_at: toMysqlDatetime(record.createdAt),
        delivered_at: null,
      })
      .execute();
  }

  async recordAttempt(
    id: string,
    patch: {
      status: DeliveryStatus;
      attempts: number;
      lastError?: string;
      nextAttemptAt?: string;
      deliveredAt?: string;
      updatedAt: string;
    },
  ): Promise<void> {
    await this.db.db
      .update(deliveries)
      .set({
        status: patch.status,
        attempts: patch.attempts,
        ...(patch.lastError !== undefined ? { last_error: patch.lastError } : {}),
        ...(patch.nextAttemptAt !== undefined
          ? { next_attempt_at: toMysqlDatetime(patch.nextAttemptAt) }
          : {}),
        ...(patch.deliveredAt !== undefined
          ? { delivered_at: toMysqlDatetime(patch.deliveredAt) }
          : {}),
        updated_at: toMysqlDatetime(patch.updatedAt),
      })
      .where(eq(deliveries.id, id))
      .execute();
  }

  /** Deliveries that still owe a job after a restart (recovery from MySQL). */
  async findRecoverable(): Promise<RecoverableDelivery[]> {
    const rows = await this.db.db
      .select()
      .from(deliveries)
      .where(inArray(deliveries.status, ['queued', 'retrying']))
      .execute();
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      appId: row.app_id,
      agentId: row.agent_id,
      queueName: row.queue_name,
      maxAttempts: row.max_attempts,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
    }));
  }

  async hasUnknown(eventId: string, agentId: string): Promise<boolean> {
    const rows = await this.db.db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.event_id, eventId),
          eq(deliveries.agent_id, agentId),
          eq(deliveries.status, 'unknown'),
        ),
      )
      .limit(1)
      .execute();
    return rows.length > 0;
  }
}
