import { z } from 'zod';

/**
 * The immutable event envelope (spec §7). All timestamps are ISO-8601 strings
 * with timezone offset. The payload carries the full JSON event body; large
 * media are referenced externally, never inlined.
 */
export const BusEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  appId: z.string().min(1),
  sourceAgentId: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  taskVersion: z.number().int().min(1).optional(),
  priority: z.number().int().min(0).max(9),
  createdAt: z.string().datetime({ offset: true }),
  deadline: z.string().datetime({ offset: true }).optional(),
  idempotencyKey: z.string().min(1).optional(),
  payload: z.unknown(),
});

export type BusEvent = z.infer<typeof BusEventSchema>;
