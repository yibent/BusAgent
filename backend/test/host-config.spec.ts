import { describe, expect, it } from 'vitest';
import { HostConfig } from '../src/config/host-config.js';

describe('HostConfig.fromEnv', () => {
  it('applies the spec defaults when nothing is set', () => {
    const config = HostConfig.fromEnv({});
    expect(config.eventIngressPath).toBe('/v1/events');
    expect(config.registrationPath).toBe('/internal/registrations');
    expect(config.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(config.registrationWaitTimeoutMs).toBe(30_000);
  });

  it('honours explicit environment values', () => {
    const config = HostConfig.fromEnv({
      BUSAGENT_EVENT_INGRESS_PATH: '/ingest',
      BUSAGENT_PORT: '8080',
    });
    expect(config.eventIngressPath).toBe('/ingest');
    expect(config.port).toBe(8080);
  });

  it('rejects invalid environment values with a structured error', () => {
    expect(() => HostConfig.fromEnv({ BUSAGENT_PORT: 'not-a-port' })).toThrowError();
  });
});
