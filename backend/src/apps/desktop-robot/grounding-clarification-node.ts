import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import type { ParsedInstruction } from './instruction-types.js';
import { intentVersion } from './pending-intents.js';
import { z } from 'zod';

const resultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string(),
    observed_at: z.number().optional(),
    cancel_epoch: z.number().optional(),
    target_world_m: z
      .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
      .optional(),
  })
  .passthrough();

export const GROUNDING_REGISTRATION_KEY = 'GroundingClarificationNode';

function instructionFrom(payload: unknown): ParsedInstruction | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = payload as Partial<ParsedInstruction>;
  return typeof value.intent === 'string' && value.target !== undefined
    ? (value as ParsedInstruction)
    : null;
}

/**
 * Owns clarification and spatial grounding. The RGB-D provider resolves object
 * references using a fresh camera observation, never model-generated XYZ.
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
    if (
      context.agentConfig.config.provider === 'rgbd' &&
      (instruction.object_goal || instruction.intent === 'find')
    ) {
      void this.resolveScene(context, instruction, common).catch((error: unknown) =>
        this.logger.error(String(error)),
      );
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

  private async resolveScene(
    context: InProcessEventContext,
    instruction: ParsedInstruction,
    common: {
      correlation_id: string;
      causation_id: string;
      task_id?: string;
      task_version?: number;
    },
  ): Promise<void> {
    const version = intentVersion(context.event.correlationId);
    try {
      const configuredUrl = context.agentConfig.config.controller_url;
      const url =
        typeof configuredUrl === 'string' ? configuredUrl : 'http://127.0.0.1:7861';
      const response = await fetch(`${url}/api/ground`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          category: instruction.target.category,
          color: instruction.target.attributes.color,
          selector: instruction.target.spatial_ref,
          ...(instruction.object_goal
            ? { offset_m: instruction.object_goal.offset_m }
            : {}),
        }),
      });
      if (!response.ok) throw new Error(`感知接口 HTTP ${response.status}`);
      const result = resultSchema.parse(await response.json());
      if (version !== intentVersion(context.event.correlationId)) return;
      if (!result.ok) throw new Error(result.message);
      if (!instruction.object_goal) {
        await context.publish({
          ...common,
          event_type: 'observation.ready',
          payload: result,
        });
        return;
      }
      if (
        !result.target_world_m ||
        result.observed_at === undefined ||
        result.cancel_epoch === undefined
      )
        throw new Error('感知没有返回可用三维位置，未执行移动。');
      instruction.motion = {
        skill: 'move_cartesian',
        params: {
          xyz_m: result.target_world_m,
          absolute: true,
          frame: 'world',
          grounding: {
            observed_at: result.observed_at,
            cancel_epoch: result.cancel_epoch,
          },
        },
      };
      await context.publish({
        ...common,
        event_type: 'command.grounded',
        payload: { instruction, grounding: { status: 'resolved', ...result } },
      });
    } catch (error) {
      if (version !== intentVersion(context.event.correlationId)) return;
      await context.publish({
        ...common,
        event_type: 'clarification.requested',
        payload: {
          question: `${instruction.object_goal ? '未执行物体定位移动' : '未获得确定的感知结果'}：${(error as Error).message}`,
          instruction,
          reason: 'GROUNDING_UNAVAILABLE',
        },
      });
    }
  }
}
