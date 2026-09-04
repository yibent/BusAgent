import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import { HostConfig } from '../../config/host-config.js';
import { isPathInside } from '../../common/path-safety.js';
import { ConversationHub } from '../conversation/conversation-hub.js';
import { ConversationInterruptions } from '../conversation/conversation-interruptions.js';
import { TtsAgent } from '../tts/tts-agent.js';
import { streamQwenChat, type ChatMessage } from './qwen-chat.js';

export const DIALOGUE_REGISTRATION_KEY = 'DialogueAgent';

const DEFAULT_SYSTEM_PROMPT =
  '你是 BusAgent 中严谨的工程机械臂操作助手，服务于 SO-101 与 Isaac Sim 工作单元。使用简洁、明确、专业的中文口语回答，不使用 markdown。严格区分指令已收到、计划已生成、正在执行、执行完成、执行失败和结果未知；只依据系统事件陈述事实，在收到 execution.completed 前绝不能声称动作已经完成。信息不足时只询问当前最关键的一项。';

const MAX_TURNS = 12;

function payloadText(payload: unknown): string {
  if (payload !== null && typeof payload === 'object' && 'text' in payload) {
    return String((payload as { text: unknown }).text).trim();
  }
  return '';
}

function factualReply(eventType: string, payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  if (eventType === 'clarification.requested') {
    const question = typeof record.question === 'string' ? record.question.trim() : '';
    return question || '请再说明一下要处理的物体和目标位置。';
  }
  if (eventType === 'execution.completed') {
    return message || '任务已经完成。';
  }
  if (eventType === 'execution.failed') {
    return message ? `任务没有完成：${message}` : '任务没有完成，请检查控制端状态。';
  }
  if (eventType === 'execution.unknown') {
    return '控制端没有返回确定结果，请查看机械臂当前状态。';
  }
  if (eventType === 'plan.rejected') {
    return '这条指令暂时无法生成可执行步骤，请换一种说法或补充目标位置。';
  }
  return null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Text dialogue agent. On a finished user utterance (`intent.created`) it
 * streams a Qwen reply to the live session and publishes `reply.created`.
 */
@Injectable()
export class DialogueAgent implements InProcessAgent, OnModuleInit, OnModuleDestroy {
  readonly registrationKey = DIALOGUE_REGISTRATION_KEY;
  private readonly logger = new Logger(DialogueAgent.name);
  private readonly histories = new Map<string, ChatMessage[]>();
  private readonly generation = new Map<string, number>();
  private readonly abort = new Map<string, AbortController>();
  private unsubscribeInterruptions: (() => void) | undefined;

  constructor(
    private readonly hostConfig: HostConfig,
    private readonly hub: ConversationHub,
    private readonly tts: TtsAgent,
    private readonly interruptions: ConversationInterruptions,
  ) {}

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
    this.unsubscribeInterruptions ??= this.interruptions.subscribe((conversationId) => {
      this.interrupt(conversationId);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeInterruptions?.();
    this.unsubscribeInterruptions = undefined;
  }

  private interrupt(conversationId: string): void {
    this.abort.get(conversationId)?.abort();
    this.abort.delete(conversationId);
    this.generation.set(conversationId, (this.generation.get(conversationId) ?? 0) + 1);
    this.tts.interrupt(conversationId);
    this.logger.info(`reply interrupted by user conv=${conversationId}`);
  }

  async handle(context: InProcessEventContext): Promise<void> {
    const fixed = factualReply(context.event.eventType, context.event.payload);
    if (fixed !== null) {
      await this.replyWithFact(context, fixed);
      return;
    }
    const text = payloadText(context.event.payload);
    if (context.event.eventType !== 'intent.created') {
      this.logger.debug(`skip ${context.event.eventType} id=${context.event.eventId}`);
      return;
    }
    if (text.length === 0) {
      return;
    }
    const conversationId = context.event.correlationId;
    this.abort.get(conversationId)?.abort();
    this.tts.cancel(conversationId);
    const controller = new AbortController();
    this.abort.set(conversationId, controller);
    const gen = (this.generation.get(conversationId) ?? 0) + 1;
    this.generation.set(conversationId, gen);
    try {
      await this.reply(context, conversationId, text, gen, controller.signal);
    } finally {
      if (this.generation.get(conversationId) === gen) {
        this.abort.delete(conversationId);
      }
    }
  }

  private async replyWithFact(
    context: InProcessEventContext,
    text: string,
  ): Promise<void> {
    const conversationId = context.event.correlationId;
    this.abort.get(conversationId)?.abort();
    this.tts.cancel(conversationId);
    const gen = (this.generation.get(conversationId) ?? 0) + 1;
    this.generation.set(conversationId, gen);
    this.hub.publish(conversationId, { type: 'reply.start', turn: gen });
    this.hub.publish(conversationId, { type: 'reply.delta', text, turn: gen });
    this.tts.startTurn(conversationId, gen);
    this.tts.append(conversationId, gen, text);
    this.hub.publish(conversationId, { type: 'reply.final', text, turn: gen });
    await this.tts.finishTurn(conversationId, gen);
    await context.publish({
      event_type: 'reply.created',
      correlation_id: conversationId,
      causation_id: context.event.eventId,
      payload: { text, factual: true },
    });
  }

  private async reply(
    context: InProcessEventContext,
    conversationId: string,
    userText: string,
    gen: number,
    signal: AbortSignal,
  ): Promise<void> {
    const apiKey = this.hostConfig.dashscopeApiKey;
    if (apiKey === undefined) {
      this.hub.publish(conversationId, {
        type: 'error',
        message: 'DASHSCOPE_API_KEY is required for dialogue',
      });
      return;
    }

    const history = this.histories.get(conversationId) ?? [];
    history.push({ role: 'user', content: userText });
    this.histories.set(conversationId, history);
    const system = await this.systemPrompt(context.agentConfig.config);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...history.slice(-MAX_TURNS * 2),
    ];

    this.logger.info(`replying to ${JSON.stringify(userText)} conv=${conversationId}`);
    this.hub.publish(conversationId, { type: 'reply.start', turn: gen });
    this.tts.startTurn(conversationId, gen);
    let full = '';
    try {
      for await (const delta of streamQwenChat({
        apiKey,
        url: this.hostConfig.qwenChatUrl,
        model: asString(
          context.agentConfig.config.model,
          this.hostConfig.qwenChatModel,
        ),
        messages,
        signal,
      })) {
        if (this.generation.get(conversationId) !== gen) {
          this.tts.cancel(conversationId);
          return;
        }
        full += delta;
        this.hub.publish(conversationId, {
          type: 'reply.delta',
          text: delta,
          turn: gen,
        });
        this.tts.append(conversationId, gen, delta);
      }
    } catch (error) {
      if (isAbortError(error) || this.generation.get(conversationId) !== gen) {
        this.logger.debug(`reply aborted conv=${conversationId}`);
        this.tts.cancel(conversationId);
        return;
      }
      const message = (error as Error).message;
      this.logger.error(`Qwen chat failed: ${message}`);
      this.hub.publish(conversationId, { type: 'error', message });
      this.dropLastUser(history, userText);
      this.tts.cancel(conversationId);
      return;
    }

    if (this.generation.get(conversationId) !== gen) {
      this.tts.cancel(conversationId);
      return;
    }
    if (full.trim().length === 0) {
      this.logger.warn('Qwen chat returned empty reply');
      this.dropLastUser(history, userText);
      return;
    }
    history.push({ role: 'assistant', content: full });
    this.histories.set(conversationId, history.slice(-MAX_TURNS * 2));
    this.hub.publish(conversationId, { type: 'reply.final', text: full, turn: gen });
    await this.tts.finishTurn(conversationId, gen);
    await context.publish({
      event_type: 'reply.created',
      correlation_id: conversationId,
      causation_id: context.event.eventId,
      payload: { text: full },
    });
    this.logger.info(`replied ${full.length} chars conv=${conversationId}`);
  }

  private dropLastUser(history: ChatMessage[], userText: string): void {
    const last = history.at(-1);
    if (last?.role === 'user' && last.content === userText) {
      history.pop();
    }
  }

  private async systemPrompt(config: Record<string, unknown>): Promise<string> {
    const relative = config.prompt_file;
    if (typeof relative !== 'string' || relative.length === 0) {
      return DEFAULT_SYSTEM_PROMPT;
    }
    const appDir = dirname(this.hostConfig.appFile);
    const full = resolve(appDir, relative);
    if (!isPathInside(appDir, full)) {
      return DEFAULT_SYSTEM_PROMPT;
    }
    try {
      const text = (await readFile(full, 'utf8')).trim();
      return text.length > 0 ? text : DEFAULT_SYSTEM_PROMPT;
    } catch {
      return DEFAULT_SYSTEM_PROMPT;
    }
  }
}
