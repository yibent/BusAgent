import { describe, expect, it } from 'vitest';
import { RegistryService } from '../src/registry/registry.service.js';
import { makeLoadedPackage, makePackageAgent } from './helpers.js';

describe('RegistryService', () => {
  it('installs agents from a package', () => {
    const registry = new RegistryService();
    registry.installPackage(
      makeLoadedPackage('p1', [makePackageAgent({ agent_id: 'robot.planner' })]),
    );
    expect(registry.has('robot.planner')).toBe(true);
    expect(registry.get('robot.planner')?.packageId).toBe('p1');
  });

  it('rejects a duplicate global agent_id across packages', () => {
    const registry = new RegistryService();
    registry.installPackage(
      makeLoadedPackage('p1', [makePackageAgent({ agent_id: 'robot.planner' })]),
    );
    expect(() =>
      registry.installPackage(
        makeLoadedPackage('p2', [makePackageAgent({ agent_id: 'robot.planner' })]),
      ),
    ).toThrowError(/conflict/i);
    expect(registry.size).toBe(1);
  });
});
