import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseConnection } from '../db/client.js';
import { registrations } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';
import type { LeaseRecord } from '../../leases/lease-manager.service.js';

@Injectable()
export class RegistrationsRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async upsert(record: LeaseRecord): Promise<void> {
    await this.db.db
      .insert(registrations)
      .values({
        agent_id: record.agentId,
        endpoint_url: record.endpointUrl,
        instance_version: record.instanceVersion,
        lease_expires_at: toMysqlDatetime(
          new Date(record.leaseExpiresAtMs).toISOString(),
        ),
        registered_at: toMysqlDatetime(new Date(record.registeredAtMs).toISOString()),
        last_renewed_at: toMysqlDatetime(
          new Date(record.lastRenewedAtMs).toISOString(),
        ),
      })
      .onDuplicateKeyUpdate({
        set: {
          endpoint_url: record.endpointUrl,
          instance_version: record.instanceVersion,
          lease_expires_at: toMysqlDatetime(
            new Date(record.leaseExpiresAtMs).toISOString(),
          ),
          last_renewed_at: toMysqlDatetime(
            new Date(record.lastRenewedAtMs).toISOString(),
          ),
        },
      })
      .execute();
  }

  async findAll(): Promise<LeaseRecord[]> {
    const rows = await this.db.db.select().from(registrations).execute();
    return rows.map((row) => ({
      agentId: row.agent_id,
      endpointUrl: row.endpoint_url,
      instanceVersion: row.instance_version,
      leaseExpiresAtMs: new Date(
        `${row.lease_expires_at.replace(' ', 'T')}Z`,
      ).getTime(),
      registeredAtMs: new Date(`${row.registered_at.replace(' ', 'T')}Z`).getTime(),
      lastRenewedAtMs: new Date(`${row.last_renewed_at.replace(' ', 'T')}Z`).getTime(),
    }));
  }

  async delete(agentId: string): Promise<void> {
    await this.db.db
      .delete(registrations)
      .where(eq(registrations.agent_id, agentId))
      .execute();
  }
}
