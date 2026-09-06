import { trackBackground } from '../../observability/execution-span.js';
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
import { readInteractionSnapshot } from '../../apps/desktop-robot/interaction-snapshot.js';
import { isImmediateInterrupt } from '../../apps/desktop-robot/interrupt-monitor-node.js';
import {
  rememberPreparation,
  clearPreparation,
} from '../../apps/desktop-robot/grasp-preparation-context.js';
import { onIntentCancellation } from '../../apps/desktop-robot/pending-intents.js';
import {
  TaskConversation,
  taskFinished,
  progressText,
  type ConversationTask,
} from './task-conversation.js';

export const DIALOGUE_REGISTRATION_KEY = 'DialogueAgent';

const DEFAULT_SYSTEM_PROMPT =
  '你是 BusAgent 中严谨的工程机械臂操作助手，机械臂型号以实时控制器状态为准。使用简洁、明确、专业的中文口语回答，不使用 markdown。严格区分指令已收到、计划已生成、正在执行、执行完成、执行失败和结果未知；只依据系统事件陈述事实，在收到 execution.completed 前绝不能声称动作已经完成。信息不足时只询问当前最关键的一项。';

const MAX_TURNS = 32;
// Suppress incomplete speech prefaces, not operational intent classification.
export function isSpeechPreface(text: string): boolean {
  return (
    /^(?:(?:好|好的|嗯|呃|对|那|那么|现在|接下来)[\s，,。.!！]*)+$/.test(text.trim()) &&
    /现在|接下来/.test(text)
  );
}
const FAST_INTERACTION_PROMPT = `你现在负责与语义理解并行的快速交互，不等待解析、规划或机械臂完成。
用户问“场景有什么/看到什么/某物体可见吗”是在请求新的视觉观测：此阶段只承接“我看一下当前画面”，等待本次观测完成事件再列举。禁止把最近一次单目标观测说成“当前仅有/仅识别到这个物体”；未被查询的物体不等于未检测到。历史观测不证明其他物体不存在。
当前输入只代表收到用户的话，不代表已解析或已执行。
短期任务记忆中的executing是上一条仍在执行的动作，waiting是等待项，不要把它们移植到新要求上。上一动作未完成时，自然说明先等它完成再处理新要求；尚未收到execution.queued时只能说需要等待，不能声称已排队。严禁用“正在执行底座旋转”等话抢先确认新动作。
用户请求动作、观察场景、补充方向/角度或修改任务：自然地用一句短话承接，说明你在处理请求，不要每次机械回复“收到”。不要宣称动作已开始、复述未核实参数、选择关节方向或自行澄清；后续真实事件会提供进展与结果。
你与执行系统是同一个助手，不把任务推给“后台”或“其他agent”。结合任务上下文承接追问，记住刚才的澄清和实际结果。语气词和附和不当作新操作。
闲聊、问候、致谢、身份问题：直接极简回答，不要求用户改口，也不引导查询能力。
查询能力：根据提供的实时 capability_summary 简短回答，最多两句；不主动展开 supported_skills 全表。抓取与放置分别以实时支持状态为准，不得把未实现的放置扩展为抓取也未实现。问候后带有能力/状态问题时优先回答实际问题，不只问候或自我介绍。只有用户要求详细列举时才展开。
查询当前状态（现在在做什么、动了吗、好了没）：直接采用 status_summary 的结论。last_command 是历史记录，其 skill=home 不表示正在复位；mode=hold/idle 且 active_command_id=null 时绝不能说正在执行。比如 status_summary=“当前保持位置；上次复位已完成。”就原样回答这句。该已完成结论来自控制器实测状态，可以汇报，不需要等待另一个总线事件。
查询失败原因：依据 robot_state.last_command.message，失败就是失败。available=false时明确无法确认，不编造。
查询任务进度时还要结合任务上下文：控制器保持位置不代表待理解或待定位的新任务已完成；说清当前等待环节。没有新任务时采用实时控制器结论。失败原因或刚才的澄清优先对应用户追问的那项任务，不套用另一条历史动作。
不能把上下文中的历史助手回复当作动作证据，不推测当前场景中的物体。没有执行工具，不输出动作计划。`;
const TASK_FEEDBACK_PROMPT = `你是操作人一直在交流的同一个机械臂助手。现在收到真实任务事件，请接着前面的对话，用自然、简短的一句中文主动反馈，不使用固定模板，不只说收到，不暴露节点、总线、agent等内部结构。
事件事实是唯一执行证据；用户要求和历史回复不是执行证据。结合本次任务明确反馈在做什么，或完成/失败的是哪个动作，避免孤立的“完成了”。不要重复播报已经说过的进度，不额外询问是否需要帮助。
理解/准备/定位不等于动作开始；accepted只是提交，started才表示开始，completed才表示完成。跟随已启用不等于任务结束，夹爪闭合不等于抓取成功。仅有到位证据时不要额外声称停稳。
clarification只问事件指定的缺失项，保留必要选项；observation只说实测结果，不补造物体。failed/rejected说明未完成与具体原因，unknown或等待超时只说尚无确认，不能擅自判失败、重试或停机。数值、否定、方向与约束不可改写成相反含义。正常回复优先口语解释错误，必要数字必须保留。
任务上下文仅供关联前文，当前反馈必须以本次事件为准。输出只包含要说给操作人听的话，通常10到35个汉字，信息不足不能为简短而省略原因。`;

function feedbackBoundary(eventType: string): string {
  const boundaries: Record<string, string> = {
    'execution.completed':
      '只报告本任务实测完成内容。若result.result.preparation_only=true，只说已到初始准备姿态、尚未抓取；可重新下达抓取进行评估，绝不能说抓取成功或保证下次能抓取。',
    'execution.progress':
      '这是控制器当前阶段的实测反馈。简短说明正在做什么；attempt是本次任务尝试次数，退让、重新定位、侧向观察均非抓取成功。只有恢复事件才可说正在重试；持物不确定时说明保持夹爪，不建议松爪。不要暴露内部节点，不重复历史阶段。',
    'execution.started':
      '这是控制器确认的本动作开始事件，应明确开始的是哪个动作。若该动作之前排队，且after_task对应任务已完成，可简短衔接上一动作结束、本动作现在开始，不要孤立地说轨迹开始。',
    'execution.queued':
      '本次新动作确实已加入等待队列，但尚未下发控制器。结合active_instruction说明前一个动作仍在进行，要等它成功结束；不能说新动作正在执行。',
    'execution.cancelled':
      '本任务已取消，不会继续执行；说明当前事件给出的取消原因，不自动重试，不说已完成。',
    'clarification.requested':
      '本轮处理已经结束，需要澄清或报告失败。没有正在进行的自动重试、重新采集、重新识别或移动；不得增加这些后续动作。若目标未确认，就明确没有确认目标。',
    'execution.unknown':
      '是否开始执行、是否完成均未获得确认。必须明确无法确认是否执行，绝不能说已执行、执行中、已到位。',
    'execution.failed':
      '本次动作未完成。用当前任务的部件名称说明原因，shoulder_pan是底座，不是肩臂。若事实result.result.preparation.requires_confirmation=true，须说明当前无法抓取、建议先回初始准备姿态并保持夹爪开度，再询问是否同意；这是已检查的准备路径，不保证能抓取，未获同意不得说已开始移动。可用两句简短表达，不能为简短漏掉确认问题。无preparation不得编造回位建议。仅当result.result.retry_available=true时可询问是否重新观察后再试一次；否则不建议自动重试，尤其持物不确定时保持夹爪。',
    'observation.ready':
      '只有本次感知结果，未因此发出机械臂移动或抓取。不能说正在靠近或开始移动。',
    'task.progress':
      '只有当前记录的阶段，不能提前宣布下一阶段。定位阶段尚未获得目标结果，不能说已定位或开始靠近。',
    'task.feedback_delayed':
      '只有等待过久的事实，没有最终结果；未停机或自动重试，不能宣告成功或失败。',
  };
  return (
    boundaries[eventType] ??
    '没有列在本次事实中的动作和后续安排均未获确认，不得自行补充。'
  );
}
const CONCISE_REPLY_PROMPT =
  '极简回复：默认只说一句，目标不超过30个汉字。直接回答，不自我介绍、不复述问题、不加寒暄、解释、建议或结尾追问。问候只答“你好。”，致谢只答“不客气。”。不主动说“请下达指令”“需要我帮你吗”“可以查询能力”。必要澄清只问缺失的一项，保留失败原因、否定和结果未知。用户明确要求详细解释时才可用最多三句。不要为了简短而改变事实。';

function payloadText(payload: unknown): string {
  if (payload !== null && typeof payload === 'object' && 'text' in payload) {
    return String((payload as { text: unknown }).text).trim();
  }
  return '';
}

function arenaEvaluationReply(payload: unknown): string | null {
  const result = (
    payload as {
      result?: { skill?: string; evaluation?: Record<string, unknown> };
    } | null
  )?.result;
  const evaluation = result?.evaluation;
  if (evaluation?.evaluation_source !== 'arena_task_simulation_ground_truth')
    return null;
  if (evaluation.physical_success === true)
    return evaluation.released === true
      ? result?.skill === 'place_held'
        ? '持物放置完成，物理验证通过。'
        : '抓取与放置完成，物理验证通过。'
      : '物体已抬起，抓取验证通过。';
  if (evaluation.physical_success !== false) return null;
  if (evaluation.lifted === true && evaluation.released === true)
    return '物体已抓起并释放，但最终放置未通过物理验证。';
  if (evaluation.lifted === true) return '物体已抬起，后续操作未完成。';
  return '未能稳定抬起物体，抓取验证未通过。';
}

function factualReply(eventType: string, payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  if (['execution.completed', 'execution.failed'].includes(eventType)) {
    const measured = arenaEvaluationReply(payload);
    if (measured) return measured;
  }
  const record = payload as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  if (eventType === 'observation.ready') return message || '未获得有效感知结果。';
  if (eventType === 'clarification.requested') {
    const question = typeof record.question === 'string' ? record.question.trim() : '';
    return question || '目标物体和位置是什么？';
  }
  if (eventType === 'execution.completed') {
    return message || '已完成。';
  }
  if (eventType === 'execution.started') return '正在执行。';
  if (eventType === 'execution.progress') return message || '动作仍在进行。';
  if (eventType === 'execution.queued' || eventType === 'execution.cancelled')
    return message || '当前动作尚未执行。';
  if (eventType === 'execution.failed') {
    return message ? `未完成：${message}` : '未完成，控制端未提供原因。';
  }
  if (eventType === 'execution.unknown') {
    return '结果未知，控制端未确认。';
  }
  if (eventType === 'plan.rejected' || eventType === 'plan.failed') {
    return message ? `无法执行：${message}` : '无法生成执行计划。';
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
 * Independent interaction lane; task execution still belongs to the NLU pipeline.
 */
@Injectable()
export class DialogueAgent implements InProcessAgent, OnModuleInit, OnModuleDestroy {
  readonly registrationKey = DIALOGUE_REGISTRATION_KEY;
  private readonly logger = new Logger(DialogueAgent.name);
  private readonly histories = new Map<string, ChatMessage[]>();
  private readonly generation = new Map<string, number>();
  private readonly abort = new Map<string, AbortController>();
  private readonly taskFeedback = new Set<string>();
  private readonly tasks = new TaskConversation();
  private readonly watches = new Map<
    string,
    { progress: ReturnType<typeof setTimeout>; timeout: ReturnType<typeof setTimeout> }
  >();
  private readonly seenFacts = new Set<string>();
  private readonly latestInput = new Map<string, string>();
  private readonly quietUntil = new Map<string, number>();
  private unsubscribeInterruptions: (() => void) | undefined;
  private unsubscribeCancellation: (() => void) | undefined;

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
    this.unsubscribeCancellation ??= onIntentCancellation((conversationId) => {
      for (const id of this.tasks.silenceOpen(conversationId)) this.clearWatch(id);
      clearPreparation(conversationId);
      this.interrupt(conversationId);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeInterruptions?.();
    this.unsubscribeInterruptions = undefined;
    this.unsubscribeCancellation?.();
    this.unsubscribeCancellation = undefined;
    for (const controller of this.abort.values()) controller.abort();
    for (const id of this.watches.keys()) this.clearWatch(id);
  }

  private interrupt(conversationId: string): void {
    this.quietUntil.set(conversationId, Date.now() + 2500);
    this.abort.get(conversationId)?.abort();
    this.abort.delete(conversationId);
    this.generation.set(conversationId, (this.generation.get(conversationId) ?? 0) + 1);
    this.tts.interrupt(conversationId);
    this.logger.info(`reply interrupted by user conv=${conversationId}`);
  }

  async handle(context: InProcessEventContext): Promise<void> {
    const parallel = context.agentConfig.config.parallel_interaction === true;
    const task = parallel ? this.tasks.observe(context) : undefined;
    if (
      parallel &&
      context.event.taskId &&
      context.event.eventType.startsWith('execution.') &&
      !task
    )
      return;
    if (task && taskFinished(task)) this.clearWatch(task.id);
    if (context.event.eventType === 'interaction.classified') {
      if (task) await this.resolveInteraction(context, task);
      return;
    }
    if (
      task &&
      ['instruction.parsed', 'command.grounded', 'execution.accepted'].includes(
        context.event.eventType,
      )
    ) {
      if (!taskFinished(task)) this.watch(context, task);
      return;
    }
    const fixed = factualReply(context.event.eventType, context.event.payload);
    if (fixed !== null) {
      if (this.seenFacts.has(context.event.eventId)) return;
      this.seenFacts.add(context.event.eventId);
      if (this.seenFacts.size > 2000)
        this.seenFacts.delete(this.seenFacts.values().next().value!);
      if (
        task &&
        context.event.eventType === 'execution.started' &&
        task.stage !== 'executing'
      )
        return;
      if (task) {
        task.feedback = fixed;
        if (!this.tasks.canReport(task.id)) {
          this.clearWatch(task.id);
          return;
        }
        if (context.event.eventType === 'execution.queued') {
          task.progressSpoken = true;
          this.clearWatch(task.id);
          this.watch(context, task);
        }
        if (task.stage === 'executing') {
          this.clearWatch(task.id);
          this.watch(context, task);
        }
      }
      if (
        context.event.eventType === 'execution.progress' &&
        (context.event.payload as Record<string, unknown>).announce === false
      )
        return;
      if (context.event.taskId) {
        this.taskFeedback.add(context.event.taskId);
        if (this.taskFeedback.size > 2000)
          this.taskFeedback.delete(this.taskFeedback.values().next().value!);
      }
      const work = this.replyWithFact(context, fixed);
      if (context.agentConfig.config.parallel_interaction === true)
        void work.catch((error) => this.logger.error(String(error)));
      else await work;
      return;
    }
    if (context.event.eventType === 'intent.created') {
      if (
        context.agentConfig.config.parallel_interaction !== true ||
        isImmediateInterrupt(payloadText(context.event.payload))
      )
        return;
      if (this.taskFeedback.has(`task_${context.event.eventId}`)) return;
      this.latestInput.set(
        context.event.correlationId,
        `task_${context.event.eventId}`,
      );
      if (isSpeechPreface(payloadText(context.event.payload))) return;
      if (task && !taskFinished(task)) this.watch(context, task);
      // Release the conversation delivery lane; task feedback can preempt a slow reply.
      void trackBackground(() => this.startReply(context)).catch((error) =>
        this.logger.error(String(error)),
      );
      return;
    }
    if (context.event.eventType !== 'conversation.requested') return;
    await this.startReply(context);
  }

  private clearWatch(id: string): void {
    const watch = this.watches.get(id);
    if (watch) {
      clearTimeout(watch.progress);
      clearTimeout(watch.timeout);
    }
    this.watches.delete(id);
  }

  private watch(context: InProcessEventContext, task: ConversationTask): void {
    if (this.watches.has(task.id)) return;
    const report = (text: string, eventType: string) => {
      if (
        taskFinished(task) ||
        !this.tasks.canReport(task.id) ||
        this.latestInput.get(task.conversationId) !== task.id ||
        Date.now() < (this.quietUntil.get(task.conversationId) ?? 0)
      )
        return;
      task.feedback = text;
      const progressContext = {
        ...context,
        event: {
          ...context.event,
          eventType,
          taskId: task.id,
          payload: { message: text, stage: task.stage },
        },
      };
      void trackBackground(() => this.replyWithFact(progressContext, text)).catch(
        (error) => this.logger.error(String(error)),
      );
    };
    const progress = setTimeout(
      () => {
        if (
          this.latestInput.get(task.conversationId) !== task.id ||
          Date.now() < (this.quietUntil.get(task.conversationId) ?? 0) ||
          task.progressSpoken
        )
          return;
        task.progressSpoken = true;
        report(progressText(task), 'task.progress');
      },
      context.event.eventType === 'execution.started' ? 12_000 : 6_000,
    );
    const timeout = setTimeout(
      () => {
        this.clearWatch(task.id);
        report(
          '这项请求还没有最终结果，暂时无法确认完成；有结果后会继续反馈。',
          'task.feedback_delayed',
        );
      },
      context.event.eventType === 'execution.started' ? 35_000 : 25_000,
    );
    progress.unref();
    timeout.unref();
    this.watches.set(task.id, { progress, timeout });
  }

  private async resolveInteraction(
    context: InProcessEventContext,
    task: ConversationTask,
  ): Promise<void> {
    if (
      !task.interactionReply ||
      !task.classifiedIntent ||
      this.latestInput.get(task.conversationId) !== task.id
    )
      return;
    // This recognizes an empty acknowledgement, not the user's operation intent.
    if (
      !/^(?:(?:收到|已收到|好的?|明白了?|我(?:先|来)?(?:处理|确认|看看)(?:一下)?|正在(?:处理|确认))[。！!，,\s]*)+$/.test(
        task.interactionReply,
      )
    )
      return;
    delete task.interactionReply;
    const fact =
      task.classifiedIntent === 'chat'
        ? '语义理解将本句判为普通交流，没有为本句下发动作。请结合原话自然回应；如果原话实际要求操作，说明尚未形成可执行指令，只询问缺失项。'
        : `用户在查询${task.classifiedIntent === 'capabilities' ? '能力' : '状态'}，不是要求执行动作。请根据实时只读上下文回答，不只确认收到。`;
    const snapshot = await readInteractionSnapshot(
      context.agentConfig.config,
      AbortSignal.timeout(500),
    );
    if (this.latestInput.get(task.conversationId) !== task.id) return;
    void trackBackground(() =>
      this.replyWithFact(
        {
          ...context,
          event: {
            ...context.event,
            eventType: 'interaction.resolved',
            taskId: task.id,
            payload: { message: fact, snapshot },
          },
        },
        '这句话未形成新的操作指令。',
      ),
    ).catch((error) => this.logger.error(String(error)));
  }

  private async startReply(context: InProcessEventContext): Promise<void> {
    const text = payloadText(context.event.payload);
    if (text.length === 0) {
      return;
    }
    const conversationId = context.event.correlationId;
    const canReport = () =>
      context.agentConfig.config.parallel_interaction !== true ||
      !context.event.taskId ||
      this.tasks.canReport(context.event.taskId);
    if (!canReport()) return;
    this.abort.get(conversationId)?.abort();
    if (context.event.eventType === 'intent.created')
      this.hub.publish(conversationId, { type: 'speech.interrupted' });
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
    synthesize = context.agentConfig.config.parallel_interaction === true &&
      this.hostConfig.dashscopeApiKey !== undefined,
  ): Promise<void> {
    // Arena already supplies measured outcomes; another LLM pass can invert
    // grasp/placement failures or invent the legacy preparation confirmation.
    if (arenaEvaluationReply(context.event.payload)) synthesize = false;
    const conversationId = context.event.correlationId;
    const canReport = () =>
      context.agentConfig.config.parallel_interaction !== true ||
      !context.event.taskId ||
      this.tasks.canReport(context.event.taskId);
    if (!canReport()) return;
    this.abort.get(conversationId)?.abort();
    if (context.agentConfig.config.parallel_interaction === true)
      this.hub.publish(conversationId, { type: 'speech.interrupted' });
    this.tts.cancel(conversationId);
    const gen = (this.generation.get(conversationId) ?? 0) + 1;
    this.generation.set(conversationId, gen);
    const controller = new AbortController();
    this.abort.set(conversationId, controller);
    this.hub.publish(conversationId, { type: 'reply.start', turn: gen });
    this.tts.startTurn(conversationId, gen);
    if (synthesize) {
      let full = '';
      try {
        for await (const delta of streamQwenChat({
          apiKey: this.hostConfig.dashscopeApiKey!,
          url: this.hostConfig.qwenChatUrl,
          model: asString(
            context.agentConfig.config.model,
            this.hostConfig.qwenChatModel,
          ),
          reasoning: 'none',
          temperature: 0.1,
          maxTokens: 192,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6_000)]),
          messages: [
            {
              role: 'system',
              content:
                TASK_FEEDBACK_PROMPT +
                '\n本次事实边界：' +
                feedbackBoundary(context.event.eventType) +
                '\n本次事件的权威事实摘要（不是输出模板）：' +
                text +
                '\n' +
                JSON.stringify({
                  current_event: context.event.eventType,
                  facts: context.event.payload,
                  task_id: context.event.taskId,
                  task_context: this.tasks
                    .snapshot(conversationId)
                    .filter(
                      (item) =>
                        (item as { task_id: string }).task_id === context.event.taskId,
                    ),
                }),
            },
            {
              role: 'user',
              content:
                '请依据刚收到的系统事件，向操作人简短反馈本次任务的真实进展或结果。以本次事实为准，即使与你先前的说法不同，也必须纠正。' +
                feedbackBoundary(context.event.eventType),
            },
          ],
        })) {
          if (this.generation.get(conversationId) !== gen || !canReport()) return;
          full += delta;
          this.hub.publish(conversationId, {
            type: 'reply.delta',
            text: delta,
            turn: gen,
          });
          this.tts.append(conversationId, gen, delta);
        }
        if (!full.trim()) throw new Error('Empty task feedback');
        text = full;
      } catch (error) {
        if (controller.signal.aborted || this.generation.get(conversationId) !== gen)
          return;
        this.logger.warn(`task feedback model unavailable: ${String(error)}`);
        await this.replyWithFact(context, text, false);
        return;
      }
    } else {
      this.hub.publish(conversationId, { type: 'reply.delta', text, turn: gen });
      this.tts.append(conversationId, gen, text);
    }
    if (this.generation.get(conversationId) !== gen || !canReport()) return;
    this.abort.delete(conversationId);
    const history = this.histories.get(conversationId) ?? [];
    history.push({ role: 'assistant', content: text });
    this.histories.set(conversationId, history.slice(-MAX_TURNS * 2));
    this.hub.publish(conversationId, { type: 'reply.final', text, turn: gen });
    if (context.event.eventType === 'execution.failed')
      rememberPreparation(conversationId, context.event.payload, text);
    // Persist feedback independently of TTS readiness; audio failure must not erase it.
    await context.publish({
      event_type: 'reply.created',
      correlation_id: conversationId,
      causation_id: context.event.eventId,
      ...(context.event.taskId ? { task_id: context.event.taskId } : {}),
      payload: {
        text,
        factual: true,
        phase: 'task_feedback',
        source_event: context.event.eventType,
      },
    });
    await this.tts.finishTurn(conversationId, gen);
  }

  private async reply(
    context: InProcessEventContext,
    conversationId: string,
    userText: string,
    gen: number,
    signal: AbortSignal,
  ): Promise<void> {
    const receivedAt = Date.now();
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
    const parallel = context.event.eventType === 'intent.created';
    const snapshot = parallel
      ? await readInteractionSnapshot(context.agentConfig.config, signal)
      : undefined;
    if (signal.aborted || this.generation.get(conversationId) !== gen) return;
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          system +
          '\n' +
          CONCISE_REPLY_PROMPT +
          '\n' +
          (parallel
            ? FAST_INTERACTION_PROMPT +
              '\n实时只读上下文：' +
              JSON.stringify(snapshot) +
              '\n本次会话任务上下文：' +
              JSON.stringify(this.tasks.snapshot(conversationId)) +
              '\n短期任务记忆（区分当前动作与新要求）：' +
              JSON.stringify(
                this.tasks.focus(conversationId, `task_${context.event.eventId}`),
              )
            : '你在普通交流分支，没有执行工具或任何动作事件。不能承诺执行、报告进度或列举未核验能力。操作请求应提示用户给出具体指令；能力问题应提示用户说“查询能力”。仅以实时控制器能力为准。'),
      },
      ...history.slice(-MAX_TURNS * 2),
    ];

    this.logger.info(`replying to ${JSON.stringify(userText)} conv=${conversationId}`);
    this.hub.publish(conversationId, { type: 'reply.start', turn: gen });
    this.tts.startTurn(conversationId, gen);
    let full = '';
    let firstTextMs: number | undefined;
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
        temperature: 0.2,
        reasoning: context.agentConfig.config.reasoning === 'low' ? 'low' : 'none',
        maxTokens: 192,
      })) {
        if (this.generation.get(conversationId) !== gen) {
          return;
        }
        full += delta;
        firstTextMs ??= Date.now() - receivedAt;
        // Ordinary chat is already separated from execution/observation events.
        // Publish immediately; buffering for a whole-answer regex defeats streaming.
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
        if (this.generation.get(conversationId) === gen)
          this.tts.cancel(conversationId);
        return;
      }
      const message = (error as Error).message;
      this.logger.error(`Qwen chat failed: ${message}`);
      if (parallel) {
        await this.replyWithFact(context, '已收到，快速回复暂不可用。');
        return;
      }
      this.hub.publish(conversationId, { type: 'error', message });
      this.dropLastUser(history, userText);
      this.tts.cancel(conversationId);
      return;
    }

    if (this.generation.get(conversationId) !== gen) {
      return;
    }
    if (full.trim().length === 0) {
      this.logger.warn('Qwen chat returned empty reply');
      this.dropLastUser(history, userText);
      this.tts.cancel(conversationId);
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
      payload: {
        text: full,
        ...(parallel
          ? {
              phase: 'interaction',
              instruction_id: context.event.eventId,
              first_text_ms: firstTextMs,
            }
          : {}),
      },
    });
    this.logger.info(`replied ${full.length} chars conv=${conversationId}`);
    if (parallel) {
      const task = this.tasks.observe(context);
      if (task) {
        task.interactionReply = full.trim();
        await this.resolveInteraction(context, task);
      }
    }
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
