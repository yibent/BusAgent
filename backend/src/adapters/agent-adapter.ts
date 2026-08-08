import type { BusEvent } from '../protocol/envelope.js';
import type { AgentRuntimeConfig } from '../protocol/agent-runtime-config.js';
import type { DeliveryAck } from '../protocol/ack.js';
import type { HealthStatus } from '../protocol/health.js';

/**
 * Uniform delivery abstraction for in-process classes and HTTP services
 * (spec §9). `deliver()` returns only a delivery acknowledgement; business
 * results are published back through the unified ingress.
 */
export interface AgentAdapter {
  deliver(event: BusEvent, config: AgentRuntimeConfig): Promise<DeliveryAck>;
  cancel(eventId: string): Promise<DeliveryAck>;
  health(): Promise<HealthStatus>;
  close(): Promise<void>;
}
