import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../../adapters/in-process/agent-classes.js';
import { TaskEngine } from './task-engine.js';

/** Separate Bus identities/queues; shared tooling does not share a model transcript. */
@Injectable()
export class PlanningAgent implements InProcessAgent, OnModuleInit {
  readonly registrationKey = 'PlanningAgentNode';
  constructor(private readonly engine: TaskEngine) {}
  onModuleInit() {
    if (!AgentClasses.has(this.registrationKey))
      AgentClasses.register(this.registrationKey, this);
  }
  async handle(context: InProcessEventContext) {
    if (context.event.eventType === 'planning.requested')
      await this.engine.handleInference('planner', context);
  }
}

@Injectable()
export class SupervisionAgent implements InProcessAgent, OnModuleInit {
  readonly registrationKey = 'SupervisionAgentNode';
  constructor(private readonly engine: TaskEngine) {}
  onModuleInit() {
    if (!AgentClasses.has(this.registrationKey))
      AgentClasses.register(this.registrationKey, this);
  }
  async handle(context: InProcessEventContext) {
    if (context.event.eventType === 'supervision.requested')
      await this.engine.handleInference('supervisor', context);
  }
}
