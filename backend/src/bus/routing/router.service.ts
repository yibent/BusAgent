import { Injectable } from '@nestjs/common';
import type { BusEvent } from '../../protocol/envelope.js';
import type { EventKind } from '../event-kind.js';
import { eventKindOf } from '../event-kind.js';
import { RegistryService } from '../../registry/registry.service.js';
import type { AppAgentRuntime, AppSnapshot } from '../../app/startup-snapshot.js';
import type { RetryPolicy } from '../../package/package-config.js';
import { LeaseManager } from '../../leases/lease-manager.service.js';
import { PermissionPolicy } from './permission-policy.service.js';
import { RuntimeState } from '../../app/runtime-state.service.js';

export interface DeliveryTarget {
  appId: string;
  agentId: string;
  queueName: string;
  runtimeConfig: AppAgentRuntime['runtimeConfig'];
  eventKind: EventKind;
  packageRetry: RetryPolicy;
}

/**
 * Resolves where an event must go from the immutable AppSnapshot routes plus
 * any agent-suggested next hops, applying the checks of spec §12:
 * allowed set, consumes contract, lease/activity and permissions.
 */
@Injectable()
export class Router {
  constructor(
    private readonly registry: RegistryService,
    private readonly leases: LeaseManager,
    private readonly runtime: RuntimeState,
    private readonly policy: PermissionPolicy,
  ) {}

  resolveTargets(
    event: BusEvent,
    suggestedTargets: string[] | undefined,
  ): DeliveryTarget[] {
    const snapshot = this.runtime.current;
    const targets: DeliveryTarget[] = [];
    const seen = new Set<string>();

    for (const route of snapshot.routes) {
      if (route.event !== event.eventType) {
        continue;
      }
      if (
        route.from &&
        route.from.length > 0 &&
        !route.from.includes(event.sourceAgentId)
      ) {
        continue;
      }
      for (const agentId of route.to) {
        if (seen.has(agentId)) {
          continue;
        }
        if (!this.targetEligible(event, agentId)) {
          continue;
        }
        seen.add(agentId);
        targets.push(this.targetFor(event, agentId, snapshot));
      }
    }

    if (suggestedTargets) {
      for (const agentId of suggestedTargets) {
        if (seen.has(agentId)) {
          continue;
        }
        const installed = this.registry.get(agentId);
        if (!installed) {
          continue;
        }
        if (!this.policy.allowSuggestion(event, agentId, snapshot, installed)) {
          continue;
        }
        if (!this.targetEligible(event, agentId)) {
          continue;
        }
        seen.add(agentId);
        targets.push(this.targetFor(event, agentId, snapshot));
      }
    }

    return targets;
  }

  private targetEligible(event: BusEvent, agentId: string): boolean {
    const installed = this.registry.get(agentId);
    if (!installed) {
      return false;
    }
    if (!installed.consumes.includes(event.eventType)) {
      return false;
    }
    if (!this.leases.isActive(agentId)) {
      return false;
    }
    return true;
  }

  private targetFor(
    event: BusEvent,
    agentId: string,
    snapshot: AppSnapshot,
  ): DeliveryTarget {
    const entry = snapshot.agents.get(agentId);
    const installed = this.registry.get(agentId);
    const runtimeConfig = entry?.runtimeConfig ?? {
      appId: snapshot.appId,
      agentId,
      config: {},
      adapter:
        installed?.endpoint.adapter === 'http'
          ? ('http' as const)
          : ('in-process' as const),
    };
    return {
      appId: snapshot.appId,
      agentId,
      queueName: `busagent:${snapshot.appId}:${agentId}`,
      runtimeConfig,
      eventKind: eventKindOf(event, this.registry),
      packageRetry: entry?.packageRetry ??
        installed?.retry ?? { max_attempts: 1, backoff_ms: 0, dead_letter: true },
    };
  }
}
