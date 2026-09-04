import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import type { RobotPlan } from './instruction-types.js';
import { SKILL_CATALOG } from './skill-catalog.js';

export const LOOP_ROUTER_REGISTRATION_KEY = 'LoopRouterNode';

type LoopProfileConfig = {
  primary?: unknown;
  fallbacks?: unknown;
};

export interface SelectedLoopProfile {
  step_id: number;
  skill: string;
  loop_profile: string;
  fallbacks: string[];
}

/**
 * L0 routing is configuration-driven: deployments may replace providers and
 * fallback order without changing the task planner or coordinator.
 */
export function selectLoopProfiles(
  plan: RobotPlan,
  config: Record<string, unknown>,
): SelectedLoopProfile[] {
  const configured =
    config.profiles !== null && typeof config.profiles === 'object'
      ? (config.profiles as Record<string, LoopProfileConfig>)
      : {};
  return plan.steps.map((step) => {
    const override = configured[step.skill];
    const primary =
      typeof override?.primary === 'string' && override.primary.length > 0
        ? override.primary
        : (SKILL_CATALOG[step.skill]?.loopProfile ?? 'interaction_loop');
    const fallbacks = Array.isArray(override?.fallbacks)
      ? override.fallbacks.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      step_id: step.id,
      skill: step.skill,
      loop_profile: primary,
      fallbacks,
    };
  });
}

/** L0 loop routing: select configured graph profiles for each skill. */
@Injectable()
export class LoopRouterNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = LOOP_ROUTER_REGISTRATION_KEY;
  private readonly logger = new Logger(LoopRouterNode.name);

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (context.event.eventType !== 'plan.validated') return;
    if (context.event.payload === null || typeof context.event.payload !== 'object') {
      throw new Error('plan.validated payload is invalid');
    }
    const record = context.event.payload as Record<string, unknown>;
    const plan = record.plan as RobotPlan | undefined;
    if (!plan || !Array.isArray(plan.steps))
      throw new Error('validated plan is missing');
    const profiles = selectLoopProfiles(plan, context.agentConfig.config);
    await context.publish({
      event_type: 'execution.profile.selected',
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      ...(context.event.taskId ? { task_id: context.event.taskId } : {}),
      ...(context.event.taskVersion ? { task_version: context.event.taskVersion } : {}),
      payload: { ...record, profiles },
    });
    this.logger.info(`selected ${profiles.length} loop profile(s)`);
  }
}
