import { join, resolve } from 'node:path';
import { z } from 'zod';
import { BusAgentError } from '../common/errors.js';

const DEFAULT_PORT = 3000;
const DEFAULT_REGISTRATION_WAIT_TIMEOUT_MS = 30_000;

const EnvSchema = z.object({
  BUSAGENT_CONFIG_DIR: z.string().min(1).optional(),
  BUSAGENT_PACKAGE_DIR: z.string().min(1).optional(),
  BUSAGENT_APP_FILE: z.string().min(1).optional(),
  BUSAGENT_REDIS_URL: z.string().url().optional(),
  BUSAGENT_MYSQL_URL: z.string().url().optional(),
  BUSAGENT_EVENT_INGRESS_PATH: z.string().min(1).optional(),
  BUSAGENT_REGISTRATION_PATH: z.string().min(1).optional(),
  BUSAGENT_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  BUSAGENT_REGISTRATION_WAIT_TIMEOUT_MS: z.coerce.number().int().min(0).optional(),
  BUSAGENT_HOST_ID: z.string().min(1).optional(),
});

/** Immutable host configuration parsed once at startup (spec §4). */
export class HostConfig {
  readonly configDir: string;
  readonly packageDir: string;
  readonly appFile: string;
  readonly redisUrl: string;
  readonly mysqlUrl: string;
  readonly eventIngressPath: string;
  readonly registrationPath: string;
  readonly port: number;
  readonly registrationWaitTimeoutMs: number;
  readonly hostId: string;

  private constructor(values: {
    configDir: string;
    packageDir: string;
    appFile: string;
    redisUrl: string;
    mysqlUrl: string;
    eventIngressPath: string;
    registrationPath: string;
    port: number;
    registrationWaitTimeoutMs: number;
    hostId: string;
  }) {
    this.configDir = values.configDir;
    this.packageDir = values.packageDir;
    this.appFile = values.appFile;
    this.redisUrl = values.redisUrl;
    this.mysqlUrl = values.mysqlUrl;
    this.eventIngressPath = values.eventIngressPath;
    this.registrationPath = values.registrationPath;
    this.port = values.port;
    this.registrationWaitTimeoutMs = values.registrationWaitTimeoutMs;
    this.hostId = values.hostId;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HostConfig {
    const parsed = EnvSchema.safeParse(env);
    if (!parsed.success) {
      throw new BusAgentError(
        'CONFIG_INVALID',
        'Invalid host environment configuration',
        {
          issues: parsed.error.issues,
        },
      );
    }
    const e = parsed.data;
    const configDir = resolve(e.BUSAGENT_CONFIG_DIR ?? './backend-config');
    const packageDir = resolve(e.BUSAGENT_PACKAGE_DIR ?? join(configDir, 'packages'));
    const appFile = resolve(
      e.BUSAGENT_APP_FILE ?? join(configDir, 'apps', 'desktop-robot.app.json'),
    );
    return new HostConfig({
      configDir,
      packageDir,
      appFile,
      redisUrl: e.BUSAGENT_REDIS_URL ?? 'redis://127.0.0.1:6379',
      mysqlUrl: e.BUSAGENT_MYSQL_URL ?? 'mysql://root:root@127.0.0.1:3306/busagent',
      eventIngressPath: e.BUSAGENT_EVENT_INGRESS_PATH ?? '/v1/events',
      registrationPath: e.BUSAGENT_REGISTRATION_PATH ?? '/internal/registrations',
      port: e.BUSAGENT_PORT ?? DEFAULT_PORT,
      registrationWaitTimeoutMs:
        e.BUSAGENT_REGISTRATION_WAIT_TIMEOUT_MS ?? DEFAULT_REGISTRATION_WAIT_TIMEOUT_MS,
      hostId: e.BUSAGENT_HOST_ID ?? 'host-default',
    });
  }
}
