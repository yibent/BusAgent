import { BusAgentError } from '../../common/errors.js';
import { ackAccepted, ackRejected, type DeliveryAck } from '../../protocol/ack.js';
import type { HealthStatus } from '../../protocol/health.js';
import type { BusEvent } from '../../protocol/envelope.js';
import type { AgentRuntimeConfig } from '../../protocol/agent-runtime-config.js';
import type { AgentAdapter } from '../agent-adapter.js';

const DELIVERY_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * HTTP agent adapter (spec §8, §9). The host POSTs the event to the Package's
 * fixed `event_url` with an `Idempotency-Key` header; a `202 Accepted` is the
 * only delivery acknowledgement. Business results come back through `POST /v1/events`.
 */
export class HttpAgentAdapter implements AgentAdapter {
  constructor(
    private readonly eventUrl: string,
    private readonly healthUrl?: string,
  ) {}

  async deliver(event: BusEvent, config: AgentRuntimeConfig): Promise<DeliveryAck> {
    let response: Response;
    try {
      response = await fetch(this.eventUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': event.eventId,
        },
        body: JSON.stringify({ event, agent_config: config.config }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
    } catch (error) {
      return ackRejected(`HTTP delivery failed: ${(error as Error).message}`);
    }
    if (response.status === 202) {
      return ackAccepted();
    }
    const body = await response.text().catch(() => '');
    return ackRejected(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  cancel(): Promise<DeliveryAck> {
    // Cancellation is delivered as a `task.cancelled` event through the normal
    // ingress; the Package contract has no separate cancel endpoint.
    return Promise.resolve(ackAccepted());
  }

  async health(): Promise<HealthStatus> {
    if (!this.healthUrl) {
      return { ok: true };
    }
    try {
      const response = await fetch(this.healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return { ok: response.ok, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  async close(): Promise<void> {
    // fetch-based adapter keeps no connection pool.
  }
}

export function assertEventUrl(value: string): string {
  if (!value) {
    throw new BusAgentError('CONFIG_INVALID', 'HTTP agent without an event_url');
  }
  return value;
}
