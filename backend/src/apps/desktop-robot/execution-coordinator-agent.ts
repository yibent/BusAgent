import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import { ExecutionGate } from '../../execution/execution-gate.js';
import type { RobotPlan } from './instruction-types.js';

export const EXECUTION_COORDINATOR_REGISTRATION_KEY = 'ExecutionCoordinatorNode';

function validatedPlan(payload: unknown): { plan: RobotPlan; status: unknown } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const plan = record.plan;
  const validation = record.validation;
  if (
    plan === null ||
    typeof plan !== 'object' ||
    !Array.isArray((plan as RobotPlan).steps)
  ) {
    return null;
  }
  const status =
    validation !== null && typeof validation === 'object'
      ? (validation as Record<string, unknown>).status
      : undefined;
  return { plan: plan as RobotPlan, status };
}

function interruptPlan(correlationId: string, taskVersion: number): RobotPlan {
  return {
    instruction_id: correlationId,
    task_version: taskVersion,
    intent: {
      intent: 'cancel',
      target: {
        category: null,
        attributes: {},
        spatial_ref: null,
        ordinal: null,
        quantity: 1,
      },
      destination: null,
      constraints: { order: null, avoid: [] },
      needs_clarification: false,
      clarification_question: null,
      source_text: 'immediate interrupt',
    },
    steps: [{ id: 1, skill: 'hold', params: {}, why: 'immediate interrupt' }],
  };
}

@Injectable()
export class ExecutionCoordinatorNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = EXECUTION_COORDINATOR_REGISTRATION_KEY;
  private readonly logger = new Logger(ExecutionCoordinatorNode.name);

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (
      !['execution.profile.selected', 'interrupt.requested'].includes(
        context.event.eventType,
      )
    )
      return;
    const taskId = context.event.taskId ?? `task_${context.event.correlationId}`;
    const taskVersion = context.event.taskVersion ?? 1;
    const validated =
      context.event.eventType === 'interrupt.requested'
        ? {
            plan: interruptPlan(context.event.correlationId, taskVersion),
            status: 'approved',
          }
        : validatedPlan(context.event.payload);
    if (validated === null) throw new Error('plan.validated payload is invalid');
    if (
      context.event.eventType === 'interrupt.requested' &&
      /停止|取消|中止/.test(
        String((context.event.payload as { text?: string }).text ?? ''),
      )
    ) {
      validated.plan.steps[0]!.skill = 'stop';
    }
    const grant = ExecutionGate.authorize(
      taskId,
      taskVersion,
      validated.plan,
      validated.status,
    );
    const idempotencyKey =
      context.event.eventType === 'interrupt.requested'
        ? `interrupt:${context.event.eventId}`
        : `execute:${taskId}:v${taskVersion}`;
    await context.publish({
      event_type: 'robot.execute.requested',
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      task_id: taskId,
      task_version: taskVersion,
      idempotency_key: idempotencyKey,
      payload: {
        plan: validated.plan,
        execution_credential: grant.credential,
        lane_key: grant.laneKey,
      },
    });
    this.logger.info(
      `queued plan task=${taskId} version=${taskVersion} lane=${grant.laneKey}`,
    );
  }
}
