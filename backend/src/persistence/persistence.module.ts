import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { HostConfig } from '../config/host-config.js';
import { DatabaseConnection } from './db/client.js';
import { MigrationRunner, SchemaBootstrap } from './db/migrate.js';
import { AgentsRepository } from './repositories/agents.repository.js';
import { AuditRepository } from './repositories/audit.repository.js';
import { DeadLettersRepository } from './repositories/dead-letters.repository.js';
import { DeliveriesRepository } from './repositories/deliveries.repository.js';
import { EventsRepository } from './repositories/events.repository.js';
import { IdempotencyRepository } from './repositories/idempotency.repository.js';
import { RegistrationsRepository } from './repositories/registrations.repository.js';
import { SnapshotsRepository } from './repositories/snapshots.repository.js';
import { TasksRepository } from './repositories/tasks.repository.js';
import { AuditService } from '../observability/audit.service.js';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DatabaseConnection,
      useFactory: (config: HostConfig) => new DatabaseConnection(config.mysqlUrl),
      inject: [HostConfig],
    },
    MigrationRunner,
    SchemaBootstrap,
    SnapshotsRepository,
    AgentsRepository,
    RegistrationsRepository,
    EventsRepository,
    DeliveriesRepository,
    TasksRepository,
    IdempotencyRepository,
    DeadLettersRepository,
    AuditRepository,
    AuditService,
  ],
  exports: [
    DatabaseConnection,
    MigrationRunner,
    SnapshotsRepository,
    AgentsRepository,
    RegistrationsRepository,
    EventsRepository,
    DeliveriesRepository,
    TasksRepository,
    IdempotencyRepository,
    DeadLettersRepository,
    AuditRepository,
    AuditService,
  ],
})
export class PersistenceModule {}
