import { Logger } from '@nestjs/common';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
  type InProcessPublishInput,
} from '../adapters/in-process/agent-classes.js';

/**
 * EXAMPLE in-process agents for the reference App (backend-config). They are
 * deliberately trivial stubs — implementing concrete agent business logic,
 * model calls or robot driving is out of scope for this backend. Remove or
 * replace them with real agents registered the same way.
 */
const logger = new Logger('ExampleAgents');

function publishBase(
  context: InProcessEventContext,
  eventType: string,
  payload: Record<string, unknown>,
): InProcessPublishInput {
  return {
    event_type: eventType,
    correlation_id: context.event.correlationId,
    ...(context.event.causationId !== undefined
      ? { causation_id: context.event.causationId }
      : {}),
    ...(context.event.taskId !== undefined ? { task_id: context.event.taskId } : {}),
    ...(context.event.taskVersion !== undefined
      ? { task_version: context.event.taskVersion }
      : {}),
    payload,
  };
}

class ExampleDialogueAgent implements InProcessAgent {
  readonly registrationKey = 'DialogueAgent';

  handle(context: InProcessEventContext): void {
    logger.log(
      `[example] DialogueAgent received ${context.event.eventType} (id=${context.event.eventId})`,
    );
  }
}

class ExampleExecutorAgent implements InProcessAgent {
  readonly registrationKey = 'ExampleExecutorAgent';

  async handle(context: InProcessEventContext): Promise<void> {
    if (context.event.eventType !== 'robot.execute.requested') {
      logger.log(`[example] ExecutorAgent received ${context.event.eventType}`);
      return;
    }
    // Physical executors must publish accepted -> started -> completed|failed|unknown.
    await context.publish(
      publishBase(context, 'execution.accepted', { ref: 'example' }),
    );
    await context.publish(
      publishBase(context, 'execution.completed', { ref: 'example', ok: true }),
    );
  }
}

/** Registers the example in-process agents once, before the host starts. */
export function registerExampleAgents(): void {
  if (!AgentClasses.has('DialogueAgent')) {
    AgentClasses.register('DialogueAgent', new ExampleDialogueAgent());
  }
  if (!AgentClasses.has('ExampleExecutorAgent')) {
    AgentClasses.register('ExampleExecutorAgent', new ExampleExecutorAgent());
  }
}
