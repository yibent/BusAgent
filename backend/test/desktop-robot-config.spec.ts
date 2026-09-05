import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPackages } from '../src/package/package-loader.js';
import { loadApp } from '../src/app/app-loader.js';
import { RegistryService } from '../src/registry/registry.service.js';
import { PackageInstaller } from '../src/package/package-installer.js';
import { ConfigSchemaValidator } from '../src/app/config-schema-validator.js';
import { AppValidator } from '../src/app/app-validator.js';

describe('desktop robot runtime configuration', () => {
  it('loads the real packages and validates every configured route', async () => {
    const configDir = resolve('backend-config');
    const packages = await loadPackages(resolve(configDir, 'packages'));
    const registry = new RegistryService();
    new PackageInstaller(registry).installAll(packages);
    const app = await loadApp(resolve(configDir, 'apps', 'desktop-robot.app.json'));
    expect(() =>
      new AppValidator(registry, new ConfigSchemaValidator()).validate(app),
    ).not.toThrow();
    expect(registry.get('robot.instruction_understanding')?.endpoint.adapter).toBe(
      'in-process',
    );
    expect(registry.get('robot.device_adapter')?.concurrency.mode).toBe('serial');
    const intentRoute = app.config.routes.find(
      (route) => route.event === 'intent.created',
    );
    // Typed input originates at the built-in system.input, speech at robot.stt.
    // Omitting a source restriction includes both without inventing an agent.
    expect(intentRoute?.from).toBeUndefined();
    expect(intentRoute?.to).toEqual(['robot.instruction_understanding']);
    expect(
      app.config.routes.find((route) => route.event === 'conversation.requested')?.to,
    ).toEqual(['robot.dialogue']);
  });
});
