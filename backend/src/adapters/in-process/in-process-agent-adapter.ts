import { ConversationHub } from '../../modules/conversation/conversation-hub.js';
import { traceExecution } from '../../observability/execution-span.js';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { BusAgentError } from '../../common/errors.js';
import { ackAccepted, type DeliveryAck } from '../../protocol/ack.js';
import type { HealthStatus } from '../../protocol/health.js';
import type { BusEvent } from '../../protocol/envelope.js';
import type { AgentRuntimeConfig } from '../../protocol/agent-runtime-config.js';
import type { AgentAdapter } from '../agent-adapter.js';
import { AgentClasses } from './agent-classes.js';
import { EventBus } from '../../bus/event-bus.service.js';

/**
 * Delivers events to in-process agents mounted via the static registry. The
 * agent publishes business results through the same unified ingress the host
 * exposes over HTTP, so semantics are identical for both adapter kinds.
 */
@Injectable()
export class InProcessAgentAdapter implements AgentAdapter {
  constructor(
    @Inject(forwardRef(() => EventBus))
    private readonly eventBus: EventBus,
    private readonly conversationHub: ConversationHub,
  ) {}

  async deliver(event: BusEvent, config: AgentRuntimeConfig): Promise<DeliveryAck> {
    const registrationKey = config.registrationKey;
    if (!registrationKey) {
      throw new BusAgentError(
        'CONFIG_INVALID',
        `In-process delivery without a registration key for ${config.agentId}`,
      );
    }
    const agent = AgentClasses.get(registrationKey);
    if (!agent) {
      throw new BusAgentError(
        'AGENT_NOT_INSTALLED',
        `In-process agent not registered for key: ${registrationKey}`,
        { agentId: config.agentId },
      );
    }
    await traceExecution(this.conversationHub, event, config.agentId, () =>
      agent.handle({
        event,
        agentConfig: config,
        publish: async (input) => {
          await this.eventBus.publishFromAgent(config.agentId, {
            ...input,
            source_agent_id: config.agentId,
          });
        },
      }),
    );
    return ackAccepted();
  }

  cancel(): Promise<DeliveryAck> {
    // Cancellation is delivered as an event; there is no separate in-process cancel channel.
    return Promise.resolve(ackAccepted());
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ ok: true });
  }

  async close(): Promise<void> {
    // In-process agents are closed by the host lifecycle when the snapshot unloads.
  }
}
