/** Health probe result. The lease is the routing authority; health is diagnostic only. */
export interface HealthStatus {
  ok: boolean;
  detail?: string;
}
