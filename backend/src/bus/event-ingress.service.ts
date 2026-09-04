import { Injectable } from '@nestjs/common';
import { Logger } from '../common/logger.js';
import { BusAgentError } from '../common/errors.js';
import { statusForCode } from '../common/http-status.js';
import { AgentPublishInputSchema } from '../protocol/ingress.js';
import { EventBus } from './event-bus.service.js';

export interface HttpResult {
  status: number;
  body: unknown;
}

/**
 * Handler behind the unified `POST /v1/events` (spec §8). Only returns 202 as
 * a delivery acknowledgement; business results are published as new events.
 */
@Injectable()
export class EventIngressService {
  private readonly logger = new Logger('EventIngress');

  constructor(private readonly eventBus: EventBus) {}

  async handle(body: unknown): Promise<HttpResult> {
    const parsed = AgentPublishInputSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn('rejected malformed event envelope');
      return {
        status: 400,
        body: { error: 'ENVELOPE_INVALID', detail: parsed.error.issues },
      };
    }
    try {
      const event = await this.eventBus.publishFromAgent(
        parsed.data.source_agent_id,
        parsed.data,
      );
      this.logger.info(
        `accepted ${parsed.data.event_type} from ${parsed.data.source_agent_id} as ${event.eventId}`,
      );
      return { status: 202, body: { event_id: event.eventId, status: 'accepted' } };
    } catch (error) {
      if (error instanceof BusAgentError) {
        this.logger.warn(`${error.code}: ${error.message}`);
        return {
          status: statusForCode(error.code),
          body: { error: error.code, message: error.message },
        };
      }
      throw error;
    }
  }
}
