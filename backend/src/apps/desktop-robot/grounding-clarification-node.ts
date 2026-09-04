import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import type { ParsedInstruction } from './instruction-types.js';

export const GROUNDING_REGISTRATION_KEY = 'GroundingClarificationNode';

function instructionFrom(payload: unknown): ParsedInstruction | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = payload as Partial<ParsedInstruction>;
  return typeof value.intent === 'string' && value.target !== undefined
    ? (value as ParsedInstruction)
    : null;
}

/**
 * Owns clarification and spatial grounding. The current provider preserves
 * semantic spatial references until a SceneGraph provider is connected.
 */
@Injectable()
export class GroundingClarificationNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = GROUNDING_REGISTRATION_KEY;
  private readonly logger = new Logger(GroundingClarificationNode.name);

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (context.event.eventType !== 'instruction.parsed') return;
    const instruction = instructionFrom(context.event.payload);
    if (instruction === null) throw new Error('instruction.parsed payload is invalid');
    const common = {
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      ...(context.event.taskId ? { task_id: context.event.taskId } : {}),
      ...(context.event.taskVersion ? { task_version: context.event.taskVersion } : {}),
    };
    if (instruction.needs_clarification) {
      await context.publish({
        ...common,
        event_type: 'clarification.requested',
        payload: {
          question: instruction.clarification_question,
          instruction,
        },
      });
      return;
    }
    if (instruction.target.spatial_ref) {
      await context.publish({
        ...common,
        event_type: 'clarification.requested',
        payload: {
          question: `当前还不能根据场景确认“${instruction.target.spatial_ref}”指的是哪一个物体，请补充类别或颜色。`,
          reason: 'SCENE_GRAPH_UNAVAILABLE',
          instruction,
        },
      });
      this.logger.warn('spatial reference requires a SceneGraph provider');
      return;
    }
    await context.publish({
      ...common,
      event_type: 'command.grounded',
      payload: {
        instruction,
        grounding: {
          status: 'not_required',
          scene_version: null,
        },
      },
    });
    this.logger.info(`grounded intent=${instruction.intent}`);
  }
}
