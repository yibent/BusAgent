import { z } from 'zod';

/** Lease TTL is fixed at 30 seconds (spec §1, §8). */
export const LEASE_TTL_SECONDS = 30;

/** External agents renew their lease every 10 seconds (spec §1, §8). */
export const LEASE_RENEW_INTERVAL_SECONDS = 10;

/** Body accepted by `POST /internal/registrations` (spec §8). */
export const RegistrationSchema = z.object({
  agent_id: z.string().min(1),
  endpoint_url: z.string().url(),
  instance_version: z.string().min(1),
  lease_ttl_seconds: z.literal(LEASE_TTL_SECONDS),
});

export type RegistrationRequest = z.infer<typeof RegistrationSchema>;
