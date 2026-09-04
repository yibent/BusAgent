import {
  datetime,
  index,
  int,
  json,
  mysqlTable,
  text,
  varchar,
} from 'drizzle-orm/mysql-core';

/** Package/App startup snapshots (spec §10). */
export const configSnapshots = mysqlTable('busagent_config_snapshots', {
  id: varchar('id', { length: 64 }).primaryKey(),
  snapshot_type: varchar('snapshot_type', { length: 16 }).notNull(),
  entity_key: varchar('entity_key', { length: 255 }).notNull(),
  version: varchar('version', { length: 64 }).notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  payload: json('payload').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
});

/** Global agent registry persisted at install time. */
export const agents = mysqlTable('busagent_agents', {
  agent_id: varchar('agent_id', { length: 128 }).primaryKey(),
  package_id: varchar('package_id', { length: 128 }).notNull(),
  package_version: varchar('package_version', { length: 64 }).notNull(),
  adapter: varchar('adapter', { length: 16 }).notNull(),
  endpoint: json('endpoint').notNull(),
  consumes: json('consumes').notNull(),
  produces: json('produces').notNull(),
  configuration_schema: json('configuration_schema'),
  concurrency: json('concurrency').notNull(),
  retry: json('retry').notNull(),
  permissions: json('permissions').notNull(),
  registration_key: varchar('registration_key', { length: 128 }),
  installed_at: datetime('installed_at', { mode: 'string' }).notNull(),
});

/** Active registration + lease records (30s TTL, 10s renew). */
export const registrations = mysqlTable('busagent_registrations', {
  agent_id: varchar('agent_id', { length: 128 }).primaryKey(),
  endpoint_url: varchar('endpoint_url', { length: 512 }).notNull(),
  instance_version: varchar('instance_version', { length: 64 }).notNull(),
  lease_expires_at: datetime('lease_expires_at', { mode: 'string' }).notNull(),
  registered_at: datetime('registered_at', { mode: 'string' }).notNull(),
  last_renewed_at: datetime('last_renewed_at', { mode: 'string' }).notNull(),
});

/** Full JSON event body plus query columns (spec §10). */
export const events = mysqlTable(
  'busagent_events',
  {
    event_id: varchar('event_id', { length: 128 }).primaryKey(),
    event_type: varchar('event_type', { length: 128 }).notNull(),
    app_id: varchar('app_id', { length: 128 }).notNull(),
    source_agent_id: varchar('source_agent_id', { length: 128 }).notNull(),
    correlation_id: varchar('correlation_id', { length: 128 }).notNull(),
    causation_id: varchar('causation_id', { length: 128 }),
    task_id: varchar('task_id', { length: 128 }),
    task_version: int('task_version'),
    priority: int('priority').notNull(),
    created_at: datetime('created_at', { mode: 'string' }).notNull(),
    deadline: datetime('deadline', { mode: 'string' }),
    idempotency_key: varchar('idempotency_key', { length: 128 }),
    event_json: json('event_json').notNull(),
    trace_json: json('trace_json'),
    status: varchar('status', { length: 24 }).notNull(),
    received_at: datetime('received_at', { mode: 'string' }).notNull(),
  },
  (t) => [
    index('idx_events_app_type').on(t.app_id, t.event_type),
    index('idx_events_task').on(t.task_id),
    index('idx_events_correlation').on(t.correlation_id),
    index('idx_events_status').on(t.status),
  ],
);

/** Per (event, agent) delivery record; survives restart so the in-process queue can be rebuilt. */
export const deliveries = mysqlTable(
  'busagent_deliveries',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    event_id: varchar('event_id', { length: 128 }).notNull(),
    app_id: varchar('app_id', { length: 128 }).notNull(),
    agent_id: varchar('agent_id', { length: 128 }).notNull(),
    queue_name: varchar('queue_name', { length: 255 }).notNull(),
    status: varchar('status', { length: 24 }).notNull(),
    attempts: int('attempts').notNull().default(0),
    max_attempts: int('max_attempts').notNull(),
    next_attempt_at: datetime('next_attempt_at', { mode: 'string' }),
    last_error: text('last_error'),
    created_at: datetime('created_at', { mode: 'string' }).notNull(),
    updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
    delivered_at: datetime('delivered_at', { mode: 'string' }),
  },
  (t) => [
    index('idx_deliveries_event').on(t.event_id),
    index('idx_deliveries_status').on(t.status),
    index('idx_deliveries_queue').on(t.queue_name),
  ],
);

/** Task state used to reject stale results and honour cancellation. */
export const tasks = mysqlTable('busagent_tasks', {
  task_id: varchar('task_id', { length: 128 }).primaryKey(),
  app_id: varchar('app_id', { length: 128 }).notNull(),
  current_version: int('current_version').notNull(),
  state: varchar('state', { length: 24 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

/** Idempotency records preventing duplicate side effects (spec §14). */
export const idempotency = mysqlTable('busagent_idempotency', {
  idempotency_key: varchar('idempotency_key', { length: 128 }).primaryKey(),
  event_id: varchar('event_id', { length: 128 }).notNull(),
  kind: varchar('kind', { length: 24 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
});

/** Dead-letter metadata; redelivery is a manual operation. */
export const deadLetters = mysqlTable('busagent_dead_letters', {
  id: varchar('id', { length: 64 }).primaryKey(),
  event_id: varchar('event_id', { length: 128 }).notNull(),
  app_id: varchar('app_id', { length: 128 }).notNull(),
  agent_id: varchar('agent_id', { length: 128 }).notNull(),
  reason: varchar('reason', { length: 255 }).notNull(),
  detail_json: json('detail_json'),
  status: varchar('status', { length: 16 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  redelivered_at: datetime('redelivered_at', { mode: 'string' }),
});

/** Append-only audit log. */
export const auditLog = mysqlTable('busagent_audit_log', {
  id: varchar('id', { length: 64 }).primaryKey(),
  action: varchar('action', { length: 64 }).notNull(),
  entity_type: varchar('entity_type', { length: 32 }).notNull(),
  entity_id: varchar('entity_id', { length: 128 }).notNull(),
  detail_json: json('detail_json'),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
});
