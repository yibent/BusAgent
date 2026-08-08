import { z } from 'zod';

/** One agent entry inside an App file (spec §6). */
export const AppAgentEntrySchema = z.object({
  agent_id: z.string().min(1),
  required: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
  retry_override: z.object({ max_attempts: z.number().int().min(1) }).optional(),
});
export type AppAgentEntry = z.infer<typeof AppAgentEntrySchema>;

/** Route definition inside an App file (spec §6). */
export const RouteDefinitionSchema = z.object({
  event: z.string().min(1),
  from: z.array(z.string().min(1)).optional(),
  to: z.array(z.string().min(1)).min(1),
});
export type RouteDefinition = z.infer<typeof RouteDefinitionSchema>;

/** A `*.app.json` file (spec §6). */
export const AppFileSchema = z.object({
  schema_version: z.literal('1'),
  app: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  agents: z.array(AppAgentEntrySchema).min(1),
  routes: z.array(RouteDefinitionSchema).min(1),
});
export type AppFile = z.infer<typeof AppFileSchema>;
