import { z } from 'zod';

export const HttpEndpointSchema = z.object({
  adapter: z.literal('http'),
  event_url: z.string().url(),
  health_url: z.string().url().optional(),
});
export type HttpEndpoint = z.infer<typeof HttpEndpointSchema>;

export const InProcessEndpointSchema = z.object({
  adapter: z.literal('in-process'),
  registration_key: z.string().min(1),
});
export type InProcessEndpoint = z.infer<typeof InProcessEndpointSchema>;

export const EndpointSchema = z.discriminatedUnion('adapter', [
  HttpEndpointSchema,
  InProcessEndpointSchema,
]);
export type Endpoint = z.infer<typeof EndpointSchema>;

export const ConcurrencySchema = z.object({
  mode: z.enum(['partitioned', 'serial']),
  partition_key: z.string().min(1).optional(),
  limit: z.number().int().min(1),
});
export type Concurrency = z.infer<typeof ConcurrencySchema>;

export const RetryPolicySchema = z.object({
  max_attempts: z.number().int().min(1),
  backoff_ms: z.number().int().min(0),
  dead_letter: z.boolean(),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const PermissionsSchema = z.object({
  context: z.array(z.string().min(1)),
  side_effects: z.array(z.string().min(1)),
});
export type Permissions = z.infer<typeof PermissionsSchema>;

/** A single agent declaration inside a Package file (spec §5). */
export const AgentDeclarationSchema = z.object({
  agent_id: z.string().min(1),
  endpoint: EndpointSchema,
  consumes: z.array(z.string().min(1)).default([]),
  produces: z.array(z.string().min(1)).default([]),
  configuration_schema: z.string().min(1).optional(),
  concurrency: ConcurrencySchema,
  retry: RetryPolicySchema,
  permissions: PermissionsSchema,
});
export type AgentDeclaration = z.infer<typeof AgentDeclarationSchema>;

/** A `*.package.json` file (spec §5). */
export const PackageFileSchema = z.object({
  schema_version: z.literal('1'),
  package: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  agents: z.array(AgentDeclarationSchema).min(1),
});
export type PackageFile = z.infer<typeof PackageFileSchema>;
