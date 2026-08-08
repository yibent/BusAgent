import { describe, expect, it } from 'vitest';
import { AppValidator } from '../src/app/app-validator.js';
import { ConfigSchemaValidator } from '../src/app/config-schema-validator.js';
import { RegistryService } from '../src/registry/registry.service.js';
import type { ResolvedApp } from '../src/app/app-loader.js';
import { makeLoadedPackage, makePackageAgent } from './helpers.js';

function resolvedApp(agents: unknown[], routes: unknown[]): ResolvedApp {
  return {
    filePath: '/tmp/test.app.json',
    appDir: '/tmp',
    appId: 'app',
    appVersion: '1',
    config: {
      schema_version: '1',
      app: { id: 'app', version: '1' },
      agents: agents as never,
      routes: routes as never,
    },
    resolvedFiles: new Map(),
    sha256: 'x',
  };
}

describe('AppValidator', () => {
  it('rejects an App referencing an agent no package installed', () => {
    const registry = new RegistryService();
    const validator = new AppValidator(registry, new ConfigSchemaValidator());
    const app = resolvedApp(
      [{ agent_id: 'ghost', required: true, config: {} }],
      [{ event: 'e', to: ['ghost'] }],
    );
    expect(() => validator.validate(app)).toThrowError(/not installed/);
  });

  it('rejects an App retry override above the package cap', () => {
    const registry = new RegistryService();
    registry.installPackage(
      makeLoadedPackage('p1', [
        makePackageAgent({
          agent_id: 'planner',
          consumes: ['intent.created'],
          retry: { max_attempts: 3, backoff_ms: 1000, dead_letter: true },
        }),
      ]),
    );
    const validator = new AppValidator(registry, new ConfigSchemaValidator());
    const app = resolvedApp(
      [
        {
          agent_id: 'planner',
          required: true,
          config: {},
          retry_override: { max_attempts: 5 },
        },
      ],
      [{ event: 'intent.created', to: ['planner'] }],
    );
    expect(() => validator.validate(app)).toThrowError(/exceeds the Package cap/);
  });

  it('rejects a route targeting an agent that does not consume the event', () => {
    const registry = new RegistryService();
    registry.installPackage(
      makeLoadedPackage('p1', [
        makePackageAgent({ agent_id: 'dialogue', consumes: ['other.event'] }),
      ]),
    );
    const validator = new AppValidator(registry, new ConfigSchemaValidator());
    const app = resolvedApp(
      [{ agent_id: 'dialogue', required: true, config: {} }],
      [{ event: 'intent.created', to: ['dialogue'] }],
    );
    expect(() => validator.validate(app)).toThrowError(/does not consume/);
  });
});
