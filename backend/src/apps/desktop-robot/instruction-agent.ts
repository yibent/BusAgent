import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { HostConfig } from '../../config/host-config.js';
import { understandSemantic } from './semantic-understanding.js';
import { intentVersion, cancelPendingIntent } from './pending-intents.js';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import type {
  DestinationSpec,
  ParsedInstruction,
  RobotIntentName,
  TargetSpec,
} from './instruction-types.js';
import { motionLanguage, isMotionSupplement } from './motion-language.js';
import { isImmediateInterrupt } from './interrupt-monitor-node.js';

export const INSTRUCTION_UNDERSTANDING_REGISTRATION_KEY =
  'InstructionUnderstandingNode';

const CATEGORY_ALIASES: Array<[RegExp, string]> = [
  [/滚柱|滚子|roller/i, 'roller'],
  [/扳手|wrench/i, 'wrench'],
  [/电钻|钻机|power\s*drill/i, 'power_drill'],
  [/积木|方块|block/i, 'block'],
  [/螺母|nut/i, 'nut'],
  [/螺栓|螺丝|bolt/i, 'bolt'],
  [/齿轮|gear/i, 'gear'],
  [/咖啡杯|杯子|cup/i, 'cup'],
];

const COLOR_ALIASES: Array<[RegExp, string]> = [
  [/红色?|红的|red/i, 'red'],
  [/绿色?|绿的|green/i, 'green'],
  [/蓝色?|蓝的|blue/i, 'blue'],
  [/黄色?|黄的|yellow/i, 'yellow'],
  [/黑色?|黑的|black/i, 'black'],
  [/白色?|白的|white/i, 'white'],
];

const CHINESE_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

function textPayload(payload: unknown): string {
  if (payload !== null && typeof payload === 'object' && 'text' in payload) {
    return String((payload as { text: unknown }).text).trim();
  }
  return '';
}

function numberFromText(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  return CHINESE_NUMBERS[value] ?? null;
}

function intentOf(text: string): RobotIntentName {
  if (/有什么能力|能做什么|会做什么|支持什么|支持哪些|功能|能力/.test(text))
    return 'capabilities';
  if (isImmediateInterrupt(text)) return 'cancel';
  if (/状态|进度|在做什么|做到哪|还剩|执行效果|执行了吗|动了吗/.test(text))
    return 'status_query';
  if (/放到|放入|放进|摆到|放好/.test(text)) return 'pick_place';
  if (/抓取|抓住|拿起|取出|递给|给我拿/.test(text)) return 'pick';
  if (/跟踪|追踪|跟随/.test(text)) return 'track';
  if (/寻找|查找|找到|识别|定位|看看|找/.test(text)) return 'find';
  return 'chat';
}

function categoryOf(text: string): string | null {
  for (const [pattern, category] of CATEGORY_ALIASES) {
    if (pattern.test(text)) return category;
  }

  const patterns = [
    /(?:寻找|查找|找到|识别|定位|跟踪|追踪|跟随|找)\s*(?:一下)?([^，。！？,.!?]{1,16})/,
    /把\s*(?:一个|一件|一把|一块|一根)?\s*([^，。！？,.!?]{1,16}?)(?:放到|放入|放进|摆到|移到|拿起|抓取|递给)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const candidate = match?.[1]
      ?.replace(
        /最左边|最右边|左侧|右侧|左边|右边|最近|离我最近|红色?|绿色?|蓝色?|黄色?|黑色?|白色?|一下|一个|东西|物体/g,
        '',
      )
      .trim();
    if (candidate) return candidate;
  }
  return null;
}

function targetOf(text: string): TargetSpec {
  const attributes: Record<string, string> = {};
  for (const [pattern, color] of COLOR_ALIASES) {
    if (pattern.test(text)) {
      attributes.color = color;
      break;
    }
  }
  const spatial =
    /(最左边|最右边|左侧|右侧|左边|右边|最近|离我最近|中间)/.exec(text)?.[1] ?? null;
  const ordinalText =
    /第\s*(\d+|[一二两三四五六七八九十]{1,2})\s*(?:个|件|把|块|根)?(?!格)/.exec(
      text,
    )?.[1];
  const quantityText = /(\d+|[一二两三四五六七八九十]{1,2})\s*(?:个|件|把|块|根)/.exec(
    text,
  )?.[1];
  return {
    category: categoryOf(text),
    attributes,
    spatial_ref: spatial,
    ordinal: ordinalText ? numberFromText(ordinalText) : null,
    quantity: quantityText ? (numberFromText(quantityText) ?? 1) : 1,
  };
}

function destinationOf(text: string): DestinationSpec | null {
  const cellText =
    /第?\s*(\d+|[一二两三四五六七八九十]{1,2})\s*(?:号|个)?格(?:子)?/.exec(text)?.[1];
  if (!cellText) return null;
  const cell = numberFromText(cellText);
  if (cell === null) return null;
  const bin = /(?:料箱|箱|区域?)\s*([A-Za-z])/i.exec(text)?.[1]?.toUpperCase() ?? 'A';
  return { type: 'bin_cell', bin_id: bin, cell_index: cell };
}

function clarificationFor(
  intent: RobotIntentName,
  target: TargetSpec,
  destination: DestinationSpec | null,
): string | null {
  if (['find', 'pick', 'pick_place'].includes(intent) && !target.category) {
    return '你希望我处理哪个物体？';
  }
  if (intent === 'pick_place' && destination === null) {
    return '你希望把它放到哪个料箱格？';
  }
  return null;
}

/**
 * Lightweight deterministic parser used until the report's fine-tuned NLU
 * model is connected. It keeps the exact structured output contract stable.
 */
export function parseInstruction(text: string): ParsedInstruction {
  const source = text.trim();
  let intent = intentOf(source);
  const motion = intent === 'chat' ? motionLanguage(source) : null;
  if (motion) intent = motion.intent;
  if (
    intent === 'chat' &&
    /机械臂|末端|执行|操作|运动|抓|放|转|移动|关节|夹爪/.test(source)
  )
    intent = 'unsupported';
  const target = targetOf(source);
  const destination = destinationOf(source);
  const clarification =
    motion?.clarification_question ??
    (intent === 'unsupported'
      ? '当前无法将这条要求转换为已支持的动作。请使用关节转动、末端平移、归位、夹爪开合或查询能力等具体指令。'
      : clarificationFor(intent, target, destination));
  return {
    intent,
    target,
    destination,
    constraints: { order: null, avoid: [] },
    needs_clarification: clarification !== null,
    clarification_question: clarification,
    source_text: source,
    ...(motion ? { motion: motion.motion } : {}),
  };
}

@Injectable()
export class InstructionUnderstandingNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = INSTRUCTION_UNDERSTANDING_REGISTRATION_KEY;
  private readonly logger = new Logger(InstructionUnderstandingNode.name);
  private readonly pending = new Map<string, { text: string; at: number }>();
  private readonly history = new Map<
    string,
    { at: number; entries: ParsedInstruction[] }
  >();

  constructor(@Optional() private readonly host?: HostConfig) {}

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (context.event.eventType !== 'intent.created') return;
    if (isImmediateInterrupt(textPayload(context.event.payload)))
      cancelPendingIntent(context.event.correlationId);
    const version = intentVersion(context.event.correlationId);
    if (
      this.host?.dashscopeApiKey &&
      !isImmediateInterrupt(textPayload(context.event.payload))
    ) {
      // Release the delivery lane while the language model works, so typed pause
      // is not queued behind a slow semantic request.
      void this.process(context, version).catch((error: unknown) =>
        this.logger.error(String(error)),
      );
    } else await this.process(context, version);
  }

  private async process(
    context: InProcessEventContext,
    version: number,
  ): Promise<void> {
    if (context.event.eventType !== 'intent.created') return;
    const text = textPayload(context.event.payload);
    if (!text) return;
    const previous = this.pending.get(context.event.correlationId);
    let parsed = parseInstruction(text);
    if (
      previous &&
      Date.now() - previous.at < 120_000 &&
      isMotionSupplement(text) &&
      !['cancel', 'status_query', 'capabilities'].includes(parsed.intent) &&
      (!parsed.motion || parsed.needs_clarification || parsed.intent === 'chat')
    ) {
      parsed = parseInstruction(previous.text + '，' + text);
    }
    this.pending.delete(context.event.correlationId);
    if (this.host?.dashscopeApiKey && parsed.intent !== 'cancel') {
      const remembered = this.history.get(context.event.correlationId);
      try {
        parsed = await understandSemantic(
          this.host,
          text,
          remembered && Date.now() - remembered.at < 120_000 ? remembered.entries : [],
          undefined,
          typeof context.agentConfig.config.model === 'string'
            ? context.agentConfig.config.model
            : this.host.qwenChatModel,
          context.agentConfig.config.reasoning === 'none' ? 'none' : 'low',
        );
      } catch (error) {
        this.logger.warn(
          `semantic understanding unavailable: ${(error as Error).message}`,
        );
        // Never send an unclassified operational/observation request to chat on failure.
        parsed = {
          ...parsed,
          intent: 'unsupported',
          needs_clarification: true,
          clarification_question:
            '语义理解服务暂时不可用，这条指令未执行。请稍后重试。',
        };
      }
    }
    if (version !== intentVersion(context.event.correlationId)) return;
    const remembered = this.history.get(context.event.correlationId);
    this.history.set(context.event.correlationId, {
      at: Date.now(),
      entries: [...(remembered?.entries ?? []), parsed].slice(-6),
    });
    for (const [id, memory] of this.history)
      if (Date.now() - memory.at > 120_000) this.history.delete(id);
    if (
      parsed.intent === 'cancel' &&
      (context.event.payload as { source?: string }).source === 'stt'
    )
      return;
    if (parsed.needs_clarification && parsed.motion) {
      this.pending.set(context.event.correlationId, {
        text: parsed.source_text,
        at: Date.now(),
      });
    }
    if (
      context.agentConfig.config.parallel_interaction === true &&
      ['chat', 'capabilities', 'status_query'].includes(parsed.intent)
    ) {
      // The independent interaction lane already answers these using read-only state.
      // Keep semantic classification auditable, without a second reply or arm plan.
      await context.publish({
        event_type: 'interaction.classified',
        correlation_id: context.event.correlationId,
        causation_id: context.event.eventId,
        payload: { instruction_id: context.event.eventId, intent: parsed.intent },
      });
      return;
    }
    if (parsed.intent === 'chat') {
      await context.publish({
        event_type: 'conversation.requested',
        correlation_id: context.event.correlationId,
        causation_id: context.event.eventId,
        payload: { text },
      });
      this.logger.debug(`conversation-only intent ${JSON.stringify(text)}`);
      return;
    }
    const taskId = `task_${context.event.eventId}`;
    await context.publish({
      event_type: 'instruction.parsed',
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      task_id: taskId,
      task_version: 1,
      payload: parsed,
    });
    this.logger.info(
      `parsed intent=${parsed.intent} target=${parsed.target.category ?? '-'}`,
    );
  }
}
