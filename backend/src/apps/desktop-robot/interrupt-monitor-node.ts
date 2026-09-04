import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';

export const INTERRUPT_MONITOR_REGISTRATION_KEY = 'InterruptMonitorNode';

function textPayload(payload: unknown): string {
  if (payload !== null && typeof payload === 'object' && 'text' in payload) {
    return String((payload as { text: unknown }).text).trim();
  }
  return '';
}

export function isImmediateInterrupt(text: string): boolean {
  return /停一下|停下来|停下|等一下|先别动|别动|暂停|中止|取消|^停[，。！？,.!?]?$/.test(
    text.trim(),
  );
}

/** Fast deterministic interrupt detection; it never waits for the NLU node. */
@Injectable()
export class InterruptMonitorNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = INTERRUPT_MONITOR_REGISTRATION_KEY;
  private readonly logger = new Logger(InterruptMonitorNode.name);
  private readonly lastText = new Map<string, string>();

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (!['transcript.delta', 'transcript.final'].includes(context.event.eventType))
      return;
    const text = textPayload(context.event.payload);
    if (!isImmediateInterrupt(text)) return;
    if (this.lastText.get(context.event.correlationId) === text) return;
    this.lastText.set(context.event.correlationId, text);
    await context.publish({
      event_type: 'interrupt.requested',
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      task_id: `task_${context.event.correlationId}`,
      task_version: 1,
      priority: 0,
      payload: {
        source: 'voice',
        confidence: 1,
        scope: 'arm-01',
        text,
      },
    });
    this.logger.info(`immediate interrupt requested text=${JSON.stringify(text)}`);
  }
}
