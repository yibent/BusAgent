import { describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock.js';
import { RegistryService } from '../src/registry/registry.service.js';
import { LeaseManager } from '../src/leases/lease-manager.service.js';
import { RuntimeState } from '../src/app/runtime-state.service.js';
import { Router } from '../src/bus/routing/router.service.js';
import { PermissionPolicy } from '../src/bus/routing/permission-policy.service.js';
import type { AppSnapshot } from '../src/app/startup-snapshot.js';
import type { RegistrationsRepository } from '../src/persistence/repositories/registrations.repository.js';
import { makeEvent, makeLoadedPackage, makePackageAgent } from './helpers.js';

class FakeClock implements Clock {
  ms = 1_000;
  now(): string {
    return new Date(this.ms).toISOString();
  }
  nowMs(): number {
    return this.ms;
  }
}

function fakeRepo(): RegistrationsRepository {
  return {
    findAll: () => Promise.resolve([]),
    upsert: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  } as unknown as RegistrationsRepository;
}

async function buildFixture() {
  const clock = new FakeClock();
  const registry = new RegistryService();
  registry.installPackage(
    makeLoadedPackage('p1', [
      makePackageAgent({
        agent_id: 'planner',
        endpoint: { adapter: 'http', event_url: 'http://planner/v1/events' },
        consumes: ['intent.created'],
        produces: ['plan.created'],
      }),
      makePackageAgent({
        agent_id: 'dialogue',
        consumes: ['intent.created', 'execution.progress', 'execution.completed'],
        produces: ['reply.created'],
        permissions: { context: ['conversation.*'], side_effects: [] },
      }),
      makePackageAgent({
        agent_id: 'executor',
        consumes: ['plan.created'],
        produces: ['execution.completed'],
        permissions: { context: ['task.*'], side_effects: ['robot.execute.requested'] },
      }),
    ]),
  );

  const leases = new LeaseManager(clock, fakeRepo());
  leases.registerInProcess('dialogue');
  leases.registerInProcess('executor');
  await leases.registerExternal('planner', 'http://planner/v1/events', '1.0.0');

  const snapshot: AppSnapshot = {
    snapshotSha256: 'x',
    createdAt: '2026-08-08T00:00:00.000Z',
    appId: 'app',
    appVersion: '1',
    agentIds: ['planner', 'dialogue', 'executor'],
    agents: new Map([
      [
        'planner',
        {
          agentId: 'planner',
          packageId: 'p1',
          required: true,
          runtimeConfig: {
            appId: 'app',
            agentId: 'planner',
            config: {},
            adapter: 'http',
            eventUrl: 'http://planner/v1/events',
          },
          packageRetry: { max_attempts: 3, backoff_ms: 1000, dead_letter: true },
        },
      ],
      [
        'dialogue',
        {
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
          packageRetry: { max_attempts: 2, backoff_ms: 500, dead_letter: true },
        },
      ],
      [
        'executor',
        {
          agentId: 'executor',
          packageId: 'p1',
          required: true,
          runtimeConfig: {
            appId: 'app',
            agentId: 'executor',
            config: {},
            adapter: 'in-process',
            registrationKey: 'ExampleExecutorAgent',
          },
          packageRetry: { max_attempts: 1, backoff_ms: 0, dead_letter: true },
        },
      ],
    ]),
    routes: [{ event: 'intent.created', to: ['planner', 'dialogue'] },
      {event: 'execution.progress', to: ['dialogue']},
      {event: 'execution.completed', to: ['dialogue']}],
    packageIds: ['p1'],
  };

  const runtime = new RuntimeState();
  runtime.set(snapshot);
  const router = new Router(
    registry,
    leases,
    runtime,
    new PermissionPolicy(),
  );
  return { clock, registry, leases, router };
}

describe('Router.resolveTargets', () => {
  it('routes to every active App target that consumes the event', async () => {
    const { router } = await buildFixture();
    const targets = router.resolveTargets(
      makeEvent({ eventType: 'intent.created' }),
      undefined,
    );
    const agents = targets.map((t) => t.agentId).sort();
    expect(agents).toEqual(['dialogue', 'planner']);
  });

  it('delivers completion after a long stream of physical progress events', async () => {
    const { router } = await buildFixture();
    for (let n = 0; n < 200; n++) {
      router.resolveTargets(makeEvent({eventType: 'execution.progress', taskId: 'long-pick-place'}), undefined);
    }
    const targets = router.resolveTargets(makeEvent({eventType: 'execution.completed', taskId: 'long-pick-place'}), undefined);
    expect(targets.map(t => t.agentId)).toEqual(['dialogue']);
  });

  it('stops routing to an agent once its lease expires', async () => {
    const { clock, router } = await buildFixture();
    clock.ms = 1_000 + 30_000 + 1;
    const targets = router.resolveTargets(
      makeEvent({ eventType: 'intent.created' }),
      undefined,
    );
    const agents = targets.map((t) => t.agentId);
    expect(agents).not.toContain('planner');
    expect(agents).toContain('dialogue');
  });

  it('drops next-hop suggestions outside the allowed set or contract', async () => {
    const { router } = await buildFixture();
    const targets = router.resolveTargets(makeEvent({ eventType: 'intent.created' }), [
      'executor',
      'planner',
    ]);
    const agents = targets.map((t) => t.agentId);
    // executor does not consume intent.created; planner is allowed.
    expect(agents).toContain('planner');
    expect(agents).not.toContain('executor');
  });
});
