import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import type { RowDataPacket } from 'mysql2';
import { toMysqlDatetime } from './mysql-datetime.js';
import { DatabaseConnection } from './client.js';

interface Migration {
  version: number;
  name: string;
  statements: string[];
}

const INITIAL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS busagent_config_snapshots (
  id VARCHAR(64) PRIMARY KEY,
  snapshot_type VARCHAR(16) NOT NULL,
  entity_key VARCHAR(255) NOT NULL,
  version VARCHAR(64) NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_snapshots_type (snapshot_type, entity_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS busagent_agents (
  agent_id VARCHAR(128) PRIMARY KEY,
  package_id VARCHAR(128) NOT NULL,
  package_version VARCHAR(64) NOT NULL,
  adapter VARCHAR(16) NOT NULL,
  endpoint JSON NOT NULL,
  consumes JSON NOT NULL,
  produces JSON NOT NULL,
  configuration_schema JSON NULL,
  concurrency JSON NOT NULL,
  retry JSON NOT NULL,
  permissions JSON NOT NULL,
  registration_key VARCHAR(128) NULL,
  installed_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS busagent_registrations (
  agent_id VARCHAR(128) PRIMARY KEY,
  endpoint_url VARCHAR(512) NOT NULL,
  instance_version VARCHAR(64) NOT NULL,
  lease_expires_at DATETIME(3) NOT NULL,
  registered_at DATETIME(3) NOT NULL,
  last_renewed_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS busagent_events (
  event_id VARCHAR(128) PRIMARY KEY,
  event_type VARCHAR(128) NOT NULL,
  app_id VARCHAR(128) NOT NULL,
  source_agent_id VARCHAR(128) NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  causation_id VARCHAR(128) NULL,
  task_id VARCHAR(128) NULL,
  task_version INT NULL,
  priority INT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  deadline DATETIME(3) NULL,
  idempotency_key VARCHAR(128) NULL,
  event_json JSON NOT NULL,
  trace_json JSON NULL,
  status VARCHAR(24) NOT NULL,
  received_at DATETIME(3) NOT NULL,
  INDEX idx_events_app_type (app_id, event_type),
  INDEX idx_events_task (task_id),
  INDEX idx_events_correlation (correlation_id),
  INDEX idx_events_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS busagent_deliveries (
  id VARCHAR(255) PRIMARY KEY,
  event_id VARCHAR(128) NOT NULL,
  app_id VARCHAR(128) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  queue_name VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL,
  next_attempt_at DATETIME(3) NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  delivered_at DATETIME(3) NULL,
  INDEX idx_deliveries_event (event_id),
  INDEX idx_deliveries_status (status),
  INDEX idx_deliveries_queue (queue_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS busagent_tasks (
  task_id VARCHAR(128) PRIMARY KEY,
  app_id VARCHAR(128) NOT NULL,
  current_version INT NOT NULL,
  state VARCHAR(24) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS busagent_idempotency (
  idempotency_key VARCHAR(128) PRIMARY KEY,
  event_id VARCHAR(128) NOT NULL,
  kind VARCHAR(24) NOT NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS busagent_dead_letters (
  id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(128) NOT NULL,
  app_id VARCHAR(128) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  detail_json JSON NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  redelivered_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS busagent_audit_log (
  id VARCHAR(64) PRIMARY KEY,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  detail_json JSON NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

const MIGRATIONS: Migration[] = [{ version: 1, name: 'init', statements: INITIAL_STATEMENTS }];

/** Applies versioned migrations; MySQL is the source of truth for recovery. */
@Injectable()
export class MigrationRunner {
  private readonly logger = new Logger('MigrationRunner');

  constructor(private readonly db: DatabaseConnection) {}

  async up(): Promise<void> {
    await this.db.pool.query(
      `CREATE TABLE IF NOT EXISTS busagent_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        applied_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    for (const migration of MIGRATIONS) {
      const [rows] = await this.db.pool.query(
        'SELECT version FROM busagent_migrations WHERE version = ?',
        [migration.version],
      );
      const applied = rows as RowDataPacket[];
      if (applied.length > 0) {
        this.logger.debug(`migration ${migration.version} ${migration.name} already applied`);
        continue;
      }
      this.logger.info(`applying migration ${migration.version} ${migration.name}`);
      for (const statement of migration.statements) {
        await this.db.pool.query(statement);
      }
      await this.db.pool.query(
        'INSERT INTO busagent_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, toMysqlDatetime(new Date().toISOString())],
      );
      this.logger.info(`applied migration ${migration.version} ${migration.name}`);
    }
  }
}

/** Runs schema migrations before any other module reads MySQL. */
@Injectable()
export class SchemaBootstrap implements OnModuleInit {
  constructor(private readonly migrations: MigrationRunner) {}

  async onModuleInit(): Promise<void> {
    await this.migrations.up();
  }
}
