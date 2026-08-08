import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BusEvent } from '../../protocol/envelope.js';
import type { TraceInfo } from '../../protocol/trace.js';
import { DatabaseConnection } from '../db/client.js';
import { events } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';

export type EventStatus = 'ingested' | 'routed' | 'stale' | 'dropped';

@Injectable()
export class EventsRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async insert(
    event: BusEvent,
    opts: { receivedAt: string; trace: TraceInfo; status: EventStatus },
  ): Promise<void> {
    await this.db.db
      .insert(events)
      .values({
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
      })
      .execute();
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
