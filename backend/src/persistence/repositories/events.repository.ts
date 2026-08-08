import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BusEvent } from '../../protocol/envelope.js';
import type { TraceInfo } from '../../protocol/trace.js';
import type { IdempotencyKind } from './idempotency.repository.js';
import { DatabaseConnection } from '../db/client.js';
import { events, idempotency } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';

export type EventStatus = 'ingested' | 'routed' | 'stale' | 'dropped';
export type IdempotencyClaimResult = 'claimed' | 'replay';

export interface EventInsertClaim {
  key: string;
  kind: IdempotencyKind;
  nowIso: string;
}

@Injectable()
export class EventsRepository {
  constructor(private readonly db: DatabaseConnection) {}

  /**
   * Inserts an event row. When a `claim` is provided the idempotency-key row is
   * inserted in the same transaction, making the claim and the event persist
   * atomically (spec §14): concurrent publishes with the same key are deduped by
   * the unique key, so a retried client cannot produce duplicate side effects.
   * Returns 'replay' when an earlier event already owns the key.
   */
  async insert(
    event: BusEvent,
    opts: { receivedAt: string; trace: TraceInfo; status: EventStatus },
    claim?: EventInsertClaim,
  ): Promise<IdempotencyClaimResult> {
    const values = {
      event_id: event.eventId,
      event_type: event.eventType,
      app_id: event.appId,
      source_agent_id: event.sourceAgentId,
      correlation_id: event.correlationId,
      causation_id: event.causationId ?? null,
      task_id: event.taskId ?? null,
      task_version: event.taskVersion ?? null,
      priority: event.priority,
      created_at: toMysqlDatetime(event.createdAt),
      deadline: event.deadline !== undefined ? toMysqlDatetime(event.deadline) : null,
      idempotency_key: event.idempotencyKey ?? null,
      event_json: event,
      trace_json: opts.trace,
      status: opts.status,
      received_at: toMysqlDatetime(opts.receivedAt),
    };

    if (!claim) {
      await this.db.db.insert(events).values(values).execute();
      return 'claimed';
    }

    return this.db.db.transaction(async (tx) => {
      try {
        await tx
          .insert(idempotency)
          .values({
            idempotency_key: claim.key,
            event_id: event.eventId,
            kind: claim.kind,
            created_at: toMysqlDatetime(claim.nowIso),
          })
          .execute();
      } catch (error) {
        const errno = (error as { errno?: number }).errno;
        if (errno === 1062) {
          return 'replay';
        }
        throw error;
      }
      await tx.insert(events).values(values).execute();
      return 'claimed';
    });
  }

  async findById(eventId: string): Promise<BusEvent | null> {
    const rows = await this.db.db
      .select()
      .from(events)
      .where(eq(events.event_id, eventId))
      .limit(1)
      .execute();
    const row = rows[0];
    return row ? (row.event_json as BusEvent) : null;
  }

  async markStatus(eventId: string, status: EventStatus): Promise<void> {
    await this.db.db
      .update(events)
      .set({ status })
      .where(eq(events.event_id, eventId))
      .execute();
  }
}
