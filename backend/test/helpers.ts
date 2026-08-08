import type { BusEvent } from '../src/protocol/envelope.js';
import type { PackageAgent, LoadedPackage } from '../src/package/package-loader.js';
import type { AgentDeclaration } from '../src/package/package-config.js';

/** Builds a valid BusEvent for pure-logic tests. */
export function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    eventId: overrides.eventId ?? 'evt_1',
    eventType: overrides.eventType ?? 'test.event',
    appId: overrides.appId ?? 'desktop-robot-assistant',
    sourceAgentId: overrides.sourceAgentId ?? 'system.input',
    correlationId: overrides.correlationId ?? 'corr_1',
    priority: overrides.priority ?? 0,
    createdAt: overrides.createdAt ?? '2026-08-08T00:00:00.000Z',
    payload: overrides.payload ?? {},
    ...(overrides.causationId !== undefined
      ? { causationId: overrides.causationId }
      : {}),
    ...(overrides.taskId !== undefined ? { taskId: overrides.taskId } : {}),
    ...(overrides.taskVersion !== undefined
      ? { taskVersion: overrides.taskVersion }
      : {}),
    ...(overrides.deadline !== undefined ? { deadline: overrides.deadline } : {}),
    ...(overrides.idempotencyKey !== undefined
      ? { idempotencyKey: overrides.idempotencyKey }
      : {}),
  };
}

/** Builds a package agent declaration for registry/install tests. */
export function makePackageAgent(
  overrides: Partial<AgentDeclaration> & { agent_id: string },
): PackageAgent {
  const base: AgentDeclaration = {
    agent_id: overrides.agent_id,
    endpoint: { adapter: 'in-process', registration_key: 'Key' },
    consumes: [],
    produces: [],
    concurrency: { mode: 'serial', limit: 1 },
    retry: { max_attempts: 1, backoff_ms: 0, dead_letter: true },
    permissions: { context: [], side_effects: [] },
  };
  return {
    ...base,
    ...overrides,
    configurationSchema: null,
  };
}

/** Builds a loaded package holding the given agents. */
export function makeLoadedPackage(
  packageId: string,
  agents: PackageAgent[],
): LoadedPackage {
  return {
    filePath: `${packageId}.package.json`,
    packageId,
    packageVersion: '1.0.0',
    agents,
  };
}
