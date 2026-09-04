import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';

export const EXECUTOR_REGISTRATION_KEY = 'ExampleExecutorAgent';

@Injectable()
export class ExecutorAgent implements InProcessAgent, OnModuleInit {
  readonly registrationKey = EXECUTOR_REGISTRATION_KEY;
  private readonly logger = new Logger(ExecutorAgent.name);

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (context.event.eventType !== 'robot.execute.requested') {
      this.logger.info(`received ${context.event.eventType}`);
      return;
    }
    await context.publish({
      event_type: 'execution.accepted',
      correlation_id: context.event.correlationId,
      payload: { ref: 'example' },
    });
    await context.publish({
      event_type: 'execution.completed',
      correlation_id: context.event.correlationId,
      payload: { ref: 'example', ok: true },
    });
  }
}
