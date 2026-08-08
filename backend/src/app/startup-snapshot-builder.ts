import { Injectable } from '@nestjs/common';
import { BusAgentError } from '../common/errors.js';
import type { ResolvedApp } from './app-loader.js';
import type { AppAgentRuntime, AppSnapshot } from './startup-snapshot.js';
import { RegistryService } from '../registry/registry.service.js';

/** Builds the immutable AppSnapshot used for routing and delivery (spec §1, §6). */
@Injectable()
export class StartupSnapshotBuilder {
  constructor(private readonly registry: RegistryService) {}

  build(resolved: ResolvedApp, createdAt: string): AppSnapshot {
    const runtimeAgents = new Map<string, AppAgentRuntime>();
    const packageIds = new Set<string>();

    for (const entry of resolved.config.agents) {
      const installed = this.registry.get(entry.agent_id);
      if (!installed) {
        throw new BusAgentError(
          'AGENT_NOT_INSTALLED',
          `Agent not installed: ${entry.agent_id}`,
        );
      }
      packageIds.add(installed.packageId);
      runtimeAgents.set(entry.agent_id, {
        agentId: entry.agent_id,
        packageId: installed.packageId,
        required: entry.required,
        runtimeConfig: {
          appId: resolved.appId,
          agentId: entry.agent_id,
          config: entry.config,
          adapter: installed.endpoint.adapter,
          ...(installed.endpoint.adapter === 'http'
            ? {
                eventUrl: installed.endpoint.event_url,
                ...(installed.endpoint.health_url !== undefined
                  ? { healthUrl: installed.endpoint.health_url }
                  : {}),
              }
            : { registrationKey: installed.endpoint.registration_key }),
        },
        packageRetry: installed.retry,
        ...(entry.retry_override !== undefined
          ? { retryOverride: { maxAttempts: entry.retry_override.max_attempts } }
          : {}),
      });
    }

    return {
      snapshotSha256: resolved.sha256,
      createdAt,
      appId: resolved.appId,
      appVersion: resolved.appVersion,
      agentIds: [...runtimeAgents.keys()],
      agents: runtimeAgents,
      routes: resolved.config.routes,
      packageIds: [...packageIds],
    };
  }
}
