import { Injectable } from '@nestjs/common';
import type { InstalledAgent } from '../../registry/installed-agent.js';
import type {
  Concurrency,
  Endpoint,
  Permissions,
  RetryPolicy,
} from '../../package/package-config.js';
import { DatabaseConnection } from '../db/client.js';
import { agents } from '../db/schema.js';
import { toMysqlDatetime } from '../db/mysql-datetime.js';
import { Clock } from '../../common/clock.js';

@Injectable()
export class AgentsRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly clock: Clock,
  ) {}

  /** Replaces the installed-agent snapshot. Config only changes at startup. */
  async replaceAll(installed: InstalledAgent[]): Promise<void> {
    const db = this.db.db;
    await db.delete(agents).execute();
    if (installed.length === 0) {
      return;
    }
    const installedAt = toMysqlDatetime(this.clock.now());
    await db
      .insert(agents)
      .values(
        installed.map((a) => ({
          agent_id: a.agentId,
          package_id: a.packageId,
          package_version: a.packageVersion,
          adapter: a.endpoint.adapter,
          endpoint: a.endpoint,
          consumes: [...a.consumes],
          produces: [...a.produces],
          configuration_schema: a.configurationSchema,
          concurrency: a.concurrency,
          retry: a.retry,
          permissions: a.permissions,
          registration_key:
            a.endpoint.adapter === 'in-process' ? a.endpoint.registration_key : null,
          installed_at: installedAt,
        })),
      )
      .execute();
  }

  async findAll(): Promise<Array<InstalledAgent & { installedAt: string }>> {
    const rows = await this.db.db.select().from(agents).execute();
    return rows.map((row) => ({
      agentId: row.agent_id,
      packageId: row.package_id,
      packageVersion: row.package_version,
      endpoint: row.endpoint as Endpoint,
      consumes: row.consumes as string[],
      produces: row.produces as string[],
      configurationSchema: (row.configuration_schema ?? null) as Readonly<
        Record<string, unknown>
      > | null,
      concurrency: row.concurrency as Concurrency,
      retry: row.retry as RetryPolicy,
      permissions: row.permissions as Permissions,
      installedAt: row.installed_at,
    }));
  }
}
