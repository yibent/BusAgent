import { Injectable } from '@nestjs/common';
import type { BusEvent } from '../../protocol/envelope.js';
import type { AppSnapshot } from '../../app/startup-snapshot.js';
import type { InstalledAgent } from '../../registry/installed-agent.js';

/** Wildcard matcher supporting `task.*`-style patterns (trailing `.*` also matches the bare prefix). */
export function matchWildcard(pattern: string, candidate: string): boolean {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${escaped}$`);
  if (regex.test(candidate)) {
    return true;
  }
  if (pattern.endsWith('.*')) {
    return candidate === pattern.slice(0, -2);
  }
  return false;
}

/**
 * Permission checks for next-hop suggestions (spec §12): the target must be in
 * the App's allowed set, must consume the event type, and the suggestion must
 * fall inside the target's declared `context` permission. The host is the
 * final authority; suggestions that fail any check are silently dropped.
 */
@Injectable()
export class PermissionPolicy {
  allowSuggestion(
    event: BusEvent,
    targetAgentId: string,
    snapshot: AppSnapshot,
    target: InstalledAgent,
  ): boolean {
    if (!snapshot.agents.has(targetAgentId)) {
      return false;
    }
    if (!target.consumes.includes(event.eventType)) {
      return false;
    }
    const context = target.permissions.context;
    if (context.length === 0) {
      return false;
    }
    const candidates = this.scopeCandidates(event);
    return context.some((pattern) =>
      candidates.some((candidate) => matchWildcard(pattern, candidate)),
    );
  }

  private scopeCandidates(event: BusEvent): string[] {
    const candidates: string[] = [event.eventType];
    if (event.taskId !== undefined) {
      candidates.push('task', `task.${event.taskId}`);
    }
    if (event.correlationId) {
      candidates.push(`conversation.${event.correlationId}`);
    }
    return candidates;
  }
}
