import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseConnection } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';
import { Clock } from '../../common/clock.js';

@Injectable()
export class AuditRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly clock: Clock,
  ) {}

  async append(
    action: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    await this.db.db
      .insert(auditLog)
      .values({
        id: randomUUID(),
        action,
        entity_type: entityType,
        entity_id: entityId,
        detail_json: detail,
        created_at: toMysqlDatetime(this.clock.now()),
      })
      .execute();
  }
}
