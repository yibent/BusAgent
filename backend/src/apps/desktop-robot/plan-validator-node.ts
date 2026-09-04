import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import type { RobotPlan } from './instruction-types.js';
import { SKILL_CATALOG } from './skill-catalog.js';

export const PLAN_VALIDATOR_REGISTRATION_KEY = 'PlanValidatorNode';

export function readPlan(payload: unknown): RobotPlan | null {
  if (payload === null || typeof payload !== 'object') return null;
  const candidate = payload as Partial<RobotPlan>;
  if (!Array.isArray(candidate.steps) || candidate.intent === undefined) return null;
  return candidate as RobotPlan;
}

/** Deterministic skill-level validation; no model or controller calls. */
export function validatePlan(plan: RobotPlan): string[] {
  const errors: string[] = [];
  if (plan.steps.length === 0) errors.push('plan has no steps');
  // Runtime readiness is currently supplied by the configured desktop robot
  // app; later this seed can come from a SceneSnapshot/health context block.
  const facts = new Set<string>(['camera.ready']);
  for (const [index, step] of plan.steps.entries()) {
    if (step.id !== index + 1) errors.push(`step ${step.id} is out of sequence`);
    const definition = SKILL_CATALOG[step.skill];
    if (definition === undefined) {
      errors.push(`step ${step.id} uses unknown skill ${step.skill}`);
      continue;
    }
    for (const parameter of definition.requiredParams) {
      const value = step.params[parameter];
      if (value === undefined || value === null || value === '') {
        errors.push(`step ${step.id} ${step.skill} requires parameter ${parameter}`);
      }
    }
    for (const condition of definition.preconditions) {
      if (!facts.has(condition)) {
        errors.push(`step ${step.id} ${step.skill} requires ${condition}`);
      }
    }
    for (const condition of definition.postconditions) facts.add(condition);
  }
  return errors;
}

@Injectable()
export class PlanValidatorNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = PLAN_VALIDATOR_REGISTRATION_KEY;
  private readonly logger = new Logger(PlanValidatorNode.name);

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (context.event.eventType !== 'plan.proposed') return;
    const plan = readPlan(context.event.payload);
    const errors = plan === null ? ['plan payload is invalid'] : validatePlan(plan);
    const base = {
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      ...(context.event.taskId ? { task_id: context.event.taskId } : {}),
      ...(context.event.taskVersion ? { task_version: context.event.taskVersion } : {}),
    };
    if (plan === null || errors.length > 0) {
      await context.publish({
        ...base,
        event_type: 'plan.rejected',
        payload: { plan, errors },
      });
      this.logger.warn(`plan rejected: ${errors.join('; ')}`);
      return;
    }
    await context.publish({
      ...base,
      event_type: 'plan.validated',
      payload: { plan, validation: { status: 'approved', errors: [] } },
    });
    this.logger.info(`plan validated steps=${plan.steps.length}`);
  }
}
