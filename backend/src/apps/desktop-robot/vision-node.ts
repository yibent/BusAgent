import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';

/** Nominal bus node: image inference runs locally, outside the bus critical path.
 * Neither image bytes nor masks are forwarded to dialogue/LLM nodes.
 */
@Injectable()
export class VisionNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = 'VisionNode';
  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey))
      AgentClasses.register(this.registrationKey, this);
  }
  async handle(context: InProcessEventContext): Promise<void> {
    const payload = context.event.payload as Record<string, unknown>;
    const observation = payload.observation as Record<string, unknown>;
    await context.publish({
      event_type: 'perception.reported',
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      ...(context.event.taskId
        ? {
            task_id: context.event.taskId,
            task_version: context.event.taskVersion ?? 1,
          }
        : {}),
      payload: {
        command_id: payload.command_id,
        request_id: observation.request_id,
        label: observation.label,
        ok: observation.ok,
        elapsed_s: observation.elapsed_s,
        views: observation.views,
        result_ref: observation.result_ref,
      },
    });
  }
}
