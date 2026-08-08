import { z } from 'zod';

/**
 * Body accepted by the unified `POST /v1/events` ingress (spec §8). Uses the
 * snake_case wire format; the host maps it to the camelCase BusEvent and
 * appends the system-generated eventId, receive time and trace information.
 */
export const AgentPublishInputSchema = z.object({
  event_type: z.string().min(1),
  source_agent_id: z.string().min(1),
  correlation_id: z.string().min(1).optional(),
  causation_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  task_version: z.number().int().min(1).optional(),
  priority: z.number().int().min(0).max(9).optional(),
  deadline: z.string().datetime({ offset: true }).optional(),
  idempotency_key: z.string().min(1).optional(),
  /**
   * Optional next-hop suggestion from the producing agent. The host validates
   * it against the App's allowed set, the target's consumes contract and
   * permissions, and is the final authority on delivery.
   */
  suggested_targets: z.array(z.string().min(1)).optional(),
  payload: z.unknown().default({}),
});

export type AgentPublishInput = z.infer<typeof AgentPublishInputSchema>;

/** Host-originated input (e.g. system/CLI), carries the target app id. */
export const HostEventInputSchema = AgentPublishInputSchema.omit({
  source_agent_id: true,
}).extend({
  app_id: z.string().min(1),
});

export type HostEventInput = z.infer<typeof HostEventInputSchema>;
