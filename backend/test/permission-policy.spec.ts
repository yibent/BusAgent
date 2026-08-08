import { describe, expect, it } from 'vitest';
import {
  matchWildcard,
  PermissionPolicy,
} from '../src/bus/routing/permission-policy.service.js';
import type { AppSnapshot } from '../src/app/startup-snapshot.js';
import type { InstalledAgent } from '../src/registry/installed-agent.js';
import { makeEvent, makePackageAgent } from './helpers.js';

describe('matchWildcard', () => {
  it('matches exact patterns', () => {
    expect(matchWildcard('task.*', 'task.42')).toBe(true);
  });

  it('matches a bare prefix for a trailing .* pattern', () => {
    expect(matchWildcard('task.*', 'task')).toBe(true);
  });

  it('rejects out-of-scope candidates', () => {
    expect(matchWildcard('task.*', 'conversation.1')).toBe(false);
  });
});

function snapshotWith(dialogue: boolean): AppSnapshot {
  const agents = new Map<
    string,
    AppSnapshot['agents'] extends Map<string, infer T> ? T : never
  >();
  if (dialogue) {
    agents.set('dialogue', {
      agentId: 'dialogue',
      packageId: 'p1',
      required: true,
      runtimeConfig: {
        appId: 'app',
        agentId: 'dialogue',
        config: {},
        adapter: 'in-process',
        registrationKey: 'DialogueAgent',
      },
      packageRetry: { max_attempts: 1, backoff_ms: 0, dead_letter: true },
    });
  }
  return {
    snapshotSha256: 'x',
    createdAt: '2026-08-08T00:00:00.000Z',
    appId: 'app',
    appVersion: '1',
    agentIds: ['planner', 'dialogue'],
    agents,
    routes: [],
    packageIds: ['p1'],
  };
}

describe('PermissionPolicy.allowSuggestion', () => {
  it('rejects a suggestion for an agent outside the App allowed set', () => {
    const policy = new PermissionPolicy();
    const snapshot = snapshotWith(true);
    const stranger = makePackageAgent({
      agent_id: 'stranger',
      consumes: ['intent.created'],
    }) as unknown as InstalledAgent;
    const event = makeEvent({ eventType: 'intent.created' });
    expect(policy.allowSuggestion(event, 'stranger', snapshot, stranger)).toBe(false);
  });

  it('rejects a suggestion for an agent that does not consume the event', () => {
    const policy = new PermissionPolicy();
    const snapshot = snapshotWith(true);
    const target = {
      ...makePackageAgent({ agent_id: 'planner', consumes: ['other.event'] }),
    } as unknown as InstalledAgent;
    const event = makeEvent({ eventType: 'intent.created' });
    expect(policy.allowSuggestion(event, 'planner', snapshot, target)).toBe(false);
  });

  it('allows a suggestion inside the target context permission', () => {
    const policy = new PermissionPolicy();
    const snapshot = snapshotWith(true);
    const target = makePackageAgent({
      agent_id: 'dialogue',
      consumes: ['intent.created'],
      permissions: { context: ['conversation.*'], side_effects: [] },
    }) as unknown as InstalledAgent;
    const event = makeEvent({
      eventType: 'intent.created',
      correlationId: 'conversation_9',
    });
    expect(policy.allowSuggestion(event, 'dialogue', snapshot, target)).toBe(true);
  });
});
