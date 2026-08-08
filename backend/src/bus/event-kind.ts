import type { BusEvent } from '../protocol/envelope.js';
import type { RegistryService } from '../registry/registry.service.js';

export type EventKind = 'normal' | 'task' | 'physical';

/**
 * Event classification (spec §10): task events carry task_id + task_version;
 * physical side-effect events are declared in some agent's
 * `permissions.side_effects`. Physical events forbid automatic retries.
 */
export function eventKindOf(event: BusEvent, registry: RegistryService): EventKind {
  const isPhysical = registry
    .all()
    .some((agent) => agent.permissions.side_effects.includes(event.eventType));
  if (isPhysical) {
    return 'physical';
  }
  if (event.taskId !== undefined && event.taskVersion !== undefined) {
    return 'task';
  }
  return 'normal';
}

export function isPhysicalEventType(
  eventType: string,
  registry: RegistryService,
): boolean {
  return registry
    .all()
    .some((agent) => agent.permissions.side_effects.includes(eventType));
}

/** Physical events must carry an idempotency key and an execution credential. */
export function hasExecutionCredential(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const credential =
    record['execution_credential'] ??
    record['executionCredential'] ??
    record['credential'];
  return credential !== undefined && credential !== null && credential !== '';
}
