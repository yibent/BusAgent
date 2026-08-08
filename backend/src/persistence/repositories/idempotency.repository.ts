import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseConnection } from '../db/client.js';
import { idempotency } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';

export type IdempotencyKind = 'ingest' | 'publish' | 'physical';

@Injectable()
export class IdempotencyRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async findEventIdByKey(key: string): Promise<string | null> {
    const rows = await this.db.db
      .select({ eventId: idempotency.event_id })
      .from(idempotency)
      .where(eq(idempotency.idempotency_key, key))
      .limit(1)
      .execute();
    const row = rows[0];
    return row ? row.eventId : null;
  }

  /** Returns true when the record was inserted, false when the key already exists. */
  async insertIfAbsent(
    key: string,
    eventId: string,
    kind: IdempotencyKind,
    nowIso: string,
  ): Promise<boolean> {
    try {
      await this.db.db
        .insert(idempotency)
        .values({
          idempotency_key: key,
          event_id: eventId,
          kind,
          created_at: toMysqlDatetime(nowIso),
        })
        .execute();
      return true;
    } catch (error) {
      const errno = (error as { errno?: number }).errno;
      if (errno === 1062) {
        return false;
      }
      throw error;
    }
  }
}
