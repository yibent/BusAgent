import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import type { ParsedInstruction, RobotPlan, SkillStep } from './instruction-types.js';

export const TASK_PLANNER_REGISTRATION_KEY = 'TaskPlannerNode';

function asInstruction(payload: unknown): ParsedInstruction | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const raw = record.instruction ?? payload;
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Partial<ParsedInstruction>;
  if (typeof value.intent !== 'string' || value.target === undefined) return null;
  return value as ParsedInstruction;
}

function targetParams(instruction: ParsedInstruction): Record<string, unknown> {
  return {
    ...(instruction.observation_scope ? { scope: instruction.observation_scope } : {}),
    ...(instruction.vision?.mode ? { vision_mode: instruction.vision.mode } : {}),
    ...(instruction.vision?.scene_mode
      ? { scene_mode: instruction.vision.scene_mode }
      : {}),
    ...(instruction.vision?.slow_provider
      ? { slow_provider: instruction.vision.slow_provider }
      : {}),
    category: instruction.target.category,
    attributes: instruction.target.attributes,
    spatial_ref: instruction.target.spatial_ref,
    ordinal: instruction.target.ordinal,
    quantity: instruction.target.quantity,
    policy: instruction.target.spatial_ref ? 'spatial_reference' : 'nearest_unoccluded',
  };
}

/** Parameterized skill expansion from report section 7. */
export function buildPlan(
  instruction: ParsedInstruction,
  instructionId: string,
  taskVersion = 1,
  perceptionSelectsTarget = false,
): RobotPlan | null {
  let steps: SkillStep[];
  switch (instruction.intent) {
    case 'motion':
      if (!instruction.motion || instruction.needs_clarification) return null;
      steps = [{ id: 1, ...instruction.motion }];
      break;
    case 'capabilities':
      steps = [{ id: 1, skill: 'capabilities', params: {} }];
      break;
    case 'unsupported':
      return null;
    case 'find':
      steps = perceptionSelectsTarget
        ? [{ id: 1, skill: 'perceive', params: targetParams(instruction) }]
        : [
            { id: 1, skill: 'select_target', params: targetParams(instruction) },
            { id: 2, skill: 'perceive', params: {}, why: 'refresh scene observations' },
          ];
      break;
    case 'track':
      if (perceptionSelectsTarget) {
        steps = [
          {
            id: 1,
            skill: 'perceive',
            params: { ...targetParams(instruction), tracking: true },
          },
        ];
        break;
      }
      steps =
        instruction.target.category === null
          ? [{ id: 1, skill: 'follow', params: { enabled: true } }]
          : [
              { id: 1, skill: 'select_target', params: targetParams(instruction) },
              {
                id: 2,
                skill: 'perceive',
                params: {},
                why: 'refresh scene observations',
              },
              { id: 3, skill: 'follow', params: { enabled: true } },
            ];
      break;
    case 'pick':
      if (
        instruction.needs_clarification ||
        (!instruction.target.category &&
          !instruction.retry_last_grasp &&
          !instruction.prepare_last_grasp) ||
        (instruction.prepare_last_grasp && !instruction.grasp_preparation_id)
      )
        return null;
      steps = [
        // Ground only after this whole transaction acquires the physical lane.
        {
          id: 1,
          skill: 'grasp',
          params: {
            target: instruction.target,
            ...instruction.manipulation,
            ...(instruction.retry_last_grasp ? { retry_last: true } : {}),
            ...(instruction.prepare_last_grasp
              ? { prepare_last: true, proposal_id: instruction.grasp_preparation_id }
              : {}),
          },
          verify: instruction.prepare_last_grasp
            ? 'initial preparation reached; no grasp'
            : 'visual lift verification',
        },
      ];
      break;
    case 'place_held':
      if (instruction.needs_clarification || instruction.destination?.type !== 'named_region')
        return null;
      steps = [{
        id: 1,
        skill: 'place_held',
        params: { destination: instruction.destination, mode: 'auto', ...instruction.manipulation },
        verify: 'Arena verifies retained holding, release and stable placement',
      }];
      break;
    case 'pick_place':
      if (
        instruction.needs_clarification ||
        !instruction.target.category ||
        instruction.target.quantity !== 1 ||
        instruction.destination?.type !== 'named_region'
      )
        return null;
      steps = [
        {
          id: 1,
          skill: 'pick_place',
          params: {
            target: instruction.target,
            destination: instruction.destination,
            mode: 'auto',
            ...instruction.manipulation,
          },
          verify: 'Arena physical lift, release and stable placement evaluation',
        },
      ];
      break;
    case 'status_query':
      steps = [{ id: 1, skill: 'status', params: {} }];
      break;
    case 'cancel':
      steps = [
        {
          id: 1,
          skill: /停止|取消|中止/.test(instruction.source_text) ? 'stop' : 'hold',
          params: {},
          why: 'interrupt current motion',
        },
      ];
      break;
    case 'chat':
      return null;
  }
  return {
    instruction_id: instructionId,
    task_version: taskVersion,
    intent: instruction,
    steps,
  };
}

@Injectable()
export class TaskPlannerNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = TASK_PLANNER_REGISTRATION_KEY;
  private readonly logger = new Logger(TaskPlannerNode.name);

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (context.event.eventType !== 'command.grounded') return;
    const instruction = asInstruction(context.event.payload);
    if (instruction === null) throw new Error('instruction.parsed payload is invalid');
    const taskVersion = context.event.taskVersion ?? 1;
    const plan = buildPlan(
      instruction,
      context.event.correlationId,
      taskVersion,
      context.agentConfig.config.perception_selects_target === true,
    );
    if (plan === null) {
      await context.publish({
        event_type: 'plan.failed',
        correlation_id: context.event.correlationId,
        causation_id: context.event.eventId,
        ...(context.event.taskId ? { task_id: context.event.taskId } : {}),
        task_version: taskVersion,
        payload: { instruction, message: '这条指令尚不能生成可执行动作，未下发运动。' },
      });
      return;
    }
    await context.publish({
      event_type: 'plan.proposed',
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      ...(context.event.taskId ? { task_id: context.event.taskId } : {}),
      task_version: taskVersion,
      payload: plan,
    });
    this.logger.info(`planned intent=${instruction.intent} steps=${plan.steps.length}`);
  }
}
