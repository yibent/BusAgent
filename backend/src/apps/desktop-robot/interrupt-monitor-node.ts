import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import { intelligenceEnabled } from './intelligence/types.js';
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
  return /停一下|停下来|停下|停止|中断|等一下|先别动|别动|保持|暂停|中止|取消|不(?:再)?(?:抓取|抓|移动|执行)了|^停[，。！？,.!?]?$/.test(
    text.trim(),
  );
}

export function isPandaImmediateInterrupt(text: string): boolean {
  // Partial ASR may interrupt only an explicit request to stop now. Mentions
  // of holding an object or cancelling a waiting task belong to the planner.
  return /^(?:请|先|立即|马上|快)?(?:停一下|停下来|停下|停止|暂停|急停|中断|中止|别动|先别动|等一下|停)(?:$|[，。！？,.!?\s]|当前|机械臂|机器人|执行|运动|任务|动作)/.test(
    text.trim(),
  );
}

/** Fast deterministic interrupt detection; it never waits for the NLU node. */
@Injectable()
export class InterruptMonitorNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = INTERRUPT_MONITOR_REGISTRATION_KEY;
  private readonly logger = new Logger(InterruptMonitorNode.name);
  private readonly interrupted = new Map<string, number>();
  private readonly legacyLatch = new Set<string>();

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (!['transcript.delta', 'transcript.final'].includes(context.event.eventType))
      return;
    const payload = context.event.payload as {
      hypothesis?: string;
      utterance_id?: string;
      stream_id?: string;
    };
    const text = payload?.hypothesis ?? textPayload(context.event.payload);
    const conversation = `${context.event.correlationId}:${payload?.stream_id ?? 'legacy'}`;
    const key = payload?.utterance_id
      ? `${conversation}:${payload.utterance_id}`
      : conversation;
    const final = context.event.eventType === 'transcript.final';
    const alreadySent = payload?.utterance_id
      ? this.interrupted.has(key)
      : this.legacyLatch.has(key);
    // The ASR tail changes on every token. Latch the speech turn, not its text;
    // unrelated chunks must not re-arm a stop, and final must not duplicate it.
    if (final && !payload?.utterance_id) this.legacyLatch.delete(key);
    if (
      !(intelligenceEnabled()
        ? isPandaImmediateInterrupt(text)
        : isImmediateInterrupt(text)) ||
      alreadySent
    )
      return;
    if (payload?.utterance_id) {
      this.interrupted.set(key, Date.now());
      if (this.interrupted.size > 2000)
        this.interrupted.delete(this.interrupted.keys().next().value!);
    } else if (!final) {
      this.legacyLatch.add(key);
      if (this.legacyLatch.size > 2000)
        this.legacyLatch.delete(this.legacyLatch.values().next().value!);
    }
    await context.publish({
      event_type: 'interrupt.requested',
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      task_id: `task_interrupt_${payload?.utterance_id ?? context.event.eventId}`,
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
