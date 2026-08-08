import { describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock.js';
import { LeaseManager } from '../src/leases/lease-manager.service.js';
import type { RegistrationsRepository } from '../src/persistence/repositories/registrations.repository.js';

class FakeClock implements Clock {
  ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
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

describe('LeaseManager', () => {
  it('registers a new external agent and makes it active', async () => {
    const leases = new LeaseManager(new FakeClock(1_000), fakeRepo());
    await expect(
      leases.registerExternal('robot.planner', 'http://planner/v1/events', '1.0.0'),
    ).resolves.toBe('registered');
    expect(leases.isActive('robot.planner')).toBe(true);
  });

  it('treats a matching re-registration as a renewal', async () => {
    const leases = new LeaseManager(new FakeClock(1_000), fakeRepo());
    await leases.registerExternal('a', 'http://a', '1.0.0');
    await expect(leases.registerExternal('a', 'http://a', '1.0.0')).resolves.toBe(
      'renewed',
    );
  });

  it('rejects a conflicting registration while the lease is active', async () => {
    const leases = new LeaseManager(new FakeClock(1_000), fakeRepo());
    await leases.registerExternal('a', 'http://a', '1.0.0');
    await expect(
      leases.registerExternal('a', 'http://other', '1.0.0'),
    ).rejects.toMatchObject({
      code: 'REGISTRATION_CONFLICT',
    });
  });

  it('stops routing an agent once its lease expires', async () => {
    const clock = new FakeClock(1_000);
    const leases = new LeaseManager(clock, fakeRepo());
    await leases.registerExternal('a', 'http://a', '1.0.0');
    expect(leases.isActive('a')).toBe(true);
    clock.ms = 1_000 + 30_000 + 1;
    expect(leases.isActive('a')).toBe(false);
  });

  it('allows re-registration after expiry', async () => {
    const clock = new FakeClock(1_000);
    const leases = new LeaseManager(clock, fakeRepo());
    await leases.registerExternal('a', 'http://a', '1.0.0');
    clock.ms = 1_000 + 31_000;
    await expect(leases.registerExternal('a', 'http://a', '1.0.0')).resolves.toBe(
      'registered',
    );
  });

  it('keeps in-process agents permanently active', () => {
    const leases = new LeaseManager(new FakeClock(1_000), fakeRepo());
    leases.registerInProcess('robot.dialogue');
    expect(leases.isActive('robot.dialogue')).toBe(true);
  });
});
