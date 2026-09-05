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
      steps = [
        { id: 1, skill: 'select_target', params: targetParams(instruction) },
        { id: 2, skill: 'perceive', params: {}, why: 'refresh scene observations' },
      ];
      break;
    case 'track':
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
      steps = [
        { id: 1, skill: 'perceive', params: {} },
        { id: 2, skill: 'select_target', params: targetParams(instruction) },
        { id: 3, skill: 'plan_grasp', params: { target: instruction.target } },
        { id: 4, skill: 'move_to', params: { target: 'pregrasp' } },
        { id: 5, skill: 'grasp', params: {}, verify: 'gripper holding target' },
      ];
      break;
    case 'pick_place': {
      const destination = instruction.destination;
      if (destination === null) return null;
      steps = [
        { id: 1, skill: 'perceive', params: {}, why: 'refresh scene graph' },
        { id: 2, skill: 'select_target', params: targetParams(instruction) },
        { id: 3, skill: 'plan_grasp', params: { target: instruction.target } },
        { id: 4, skill: 'move_to', params: { target: 'pregrasp' } },
        { id: 5, skill: 'grasp', params: {}, verify: 'gripper holding target' },
        {
          id: 6,
          skill: 'transport',
          params: { to: `preplace(${destination.bin_id},${destination.cell_index})` },
        },
        {
          id: 7,
          skill: 'place',
          params: {
            bin: destination.bin_id,
            cell: destination.cell_index,
            align: 'long_axis',
          },
        },
        {
          id: 8,
          skill: 'verify_placement',
          params: {
            bin: destination.bin_id,
            cell: destination.cell_index,
          },
          on_fail: 'recover',
        },
      ];
      break;
    }
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
    const plan = buildPlan(instruction, context.event.correlationId, taskVersion);
    if (plan === null) return;
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
