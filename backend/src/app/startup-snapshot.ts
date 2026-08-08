import type { AgentRuntimeConfig } from '../protocol/agent-runtime-config.js';
import type { RouteDefinition } from './app-config.js';
import type { RetryPolicy } from '../package/package-config.js';

export interface AppRetryOverride {
  maxAttempts: number;
}

/** Per-agent runtime view held by the immutable startup snapshot. */
export interface AppAgentRuntime {
  agentId: string;
  packageId: string;
  required: boolean;
  runtimeConfig: AgentRuntimeConfig;
  packageRetry: RetryPolicy;
  retryOverride?: AppRetryOverride;
}

/** Immutable startup snapshot (spec §1): no hot reload, config only changes on restart. */
export interface AppSnapshot {
  snapshotSha256: string;
  createdAt: string;
  appId: string;
  appVersion: string;
  agentIds: string[];
  agents: Map<string, AppAgentRuntime>;
  routes: RouteDefinition[];
  packageIds: string[];
}

/** Serializable form used for MySQL snapshots and the snapshot hash. */
export interface SerializableSnapshot {
  snapshotSha256: string;
  createdAt: string;
  appId: string;
  appVersion: string;
  packageIds: string[];
  agents: Array<{
    agentId: string;
    packageId: string;
    required: boolean;
    config: Record<string, unknown>;
    adapter: 'http' | 'in-process';
    eventUrl?: string;
    healthUrl?: string;
    registrationKey?: string;
    promptFile?: string;
    promptSha256?: string;
    retryOverrideMaxAttempts?: number;
    packageRetry: RetryPolicy;
  }>;
  routes: RouteDefinition[];
}

export function toSerializableSnapshot(
  snapshot: AppSnapshot,
  prompts: Map<string, { relativePath: string; promptSha256: string }>,
): SerializableSnapshot {
  return {
    snapshotSha256: snapshot.snapshotSha256,
    createdAt: snapshot.createdAt,
    appId: snapshot.appId,
    appVersion: snapshot.appVersion,
    packageIds: snapshot.packageIds,
    agents: snapshot.agentIds.map((agentId) => {
      const entry = snapshot.agents.get(agentId);
      const prompt = prompts.get(agentId);
      return {
        agentId,
        packageId: entry?.packageId ?? '',
        required: entry?.required ?? false,
        config: entry?.runtimeConfig.config ?? {},
        adapter: entry?.runtimeConfig.adapter ?? 'http',
        ...(entry?.runtimeConfig.eventUrl !== undefined
          ? { eventUrl: entry.runtimeConfig.eventUrl }
          : {}),
        ...(entry?.runtimeConfig.healthUrl !== undefined
          ? { healthUrl: entry.runtimeConfig.healthUrl }
          : {}),
        ...(entry?.runtimeConfig.registrationKey !== undefined
          ? { registrationKey: entry.runtimeConfig.registrationKey }
          : {}),
        ...(prompt !== undefined
          ? { promptFile: prompt.relativePath, promptSha256: prompt.promptSha256 }
          : {}),
        ...(entry?.retryOverride !== undefined
          ? { retryOverrideMaxAttempts: entry.retryOverride.maxAttempts }
          : {}),
        packageRetry: entry?.packageRetry ?? {
          max_attempts: 1,
          backoff_ms: 0,
          dead_letter: true,
        },
      };
    }),
    routes: snapshot.routes,
  };
}
