import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseConnection } from '../db/client.js';
import { configSnapshots } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';
import { Clock } from '../../common/clock.js';

@Injectable()
export class SnapshotsRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly clock: Clock,
  ) {}

  async save(
    type: 'package' | 'app',
    entityKey: string,
    version: string,
    sha256: string,
    payload: unknown,
  ): Promise<void> {
    await this.db.db
      .insert(configSnapshots)
      .values({
        id: randomUUID(),
        snapshot_type: type,
        entity_key: entityKey,
        version,
        sha256,
        payload,
        created_at: toMysqlDatetime(this.clock.now()),
      })
      .execute();
  }

  async findLatestByType(type: 'package' | 'app', entityKey: string): Promise<unknown> {
    const rows = await this.db.db
      .select()
      .from(configSnapshots)
      .where(
        and(
          eq(configSnapshots.snapshot_type, type),
          eq(configSnapshots.entity_key, entityKey),
        ),
      )
      .orderBy(desc(configSnapshots.created_at))
      .limit(1)
      .execute();
    const row = rows[0];
    return row ? row.payload : null;
  }
}
