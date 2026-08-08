import type {
  Concurrency,
  Endpoint,
  Permissions,
  RetryPolicy,
} from '../package/package-config.js';

/** A package agent after installation into the global registry (spec §5). */
export interface InstalledAgent {
  agentId: string;
  packageId: string;
  packageVersion: string;
  endpoint: Endpoint;
  consumes: readonly string[];
  produces: readonly string[];
  /** Resolved JSON Schema object, or null when the package declares none. */
  configurationSchema: Readonly<Record<string, unknown>> | null;
  /** Package-relative path of the configuration schema file, when declared. */
  configurationSchemaPath?: string;
  concurrency: Concurrency;
  retry: RetryPolicy;
  permissions: Permissions;
}
