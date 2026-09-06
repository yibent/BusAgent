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
import { preparationContext, clearPreparation } from './grasp-preparation-context.js';
import { readInteractionSnapshot } from './interaction-snapshot.js';
import {
  MEMORY_TTL_MS,
  INSTRUCTION_MEMORY_LIMIT,
  recentOutcomes,
} from './control-history.js';

export const INSTRUCTION_UNDERSTANDING_REGISTRATION_KEY =
  'InstructionUnderstandingNode';

const CATEGORY_ALIASES: Array<[RegExp, string]> = [
  [/滚柱|滚子|roller/i, 'roller'],
  [/圆柱|cylinder/i, 'cylinder'],
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
  if (process.env.BUSAGENT_ROBOT === 'franka_panda' && /放下|放开手里的|把它放|把手里.*放|put\s+(it\s+)?down/i.test(text) && !/拿起|抓起|抓取|取出/.test(text))
    return 'place_held';
  if (/放到|放入|放进|摆到|放好|放在|放回|放下/.test(text)) return 'pick_place';
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
  if (process.env.BUSAGENT_ROBOT === 'franka_panda') {
    const label = /(?:放到|放入|放进|摆到|放在|放回)\s*(.+?)[。！!]?$/u.exec(text)?.[1]?.trim();
    const table = /桌子|桌面|工作台|台面|\btable\b|\bdesk\b|\bworkbench\b/i;
    if (table.test(label ?? '') || (!label && table.test(text) && /放/.test(text)))
      return { type: 'named_region', label: 'table', selection: 'free_space' };
    if (label)
      return {
        type: 'named_region',
        label: label.replace(/(?:的)?(?:上面|上方|顶部|上)$/u, '').trim(),
        ...(/随便|任意|空位|空闲|空处/.test(text) ? { selection: 'free_space' as const } : {}),
      };
    if (/放下|put\s+(it\s+)?down/i.test(text))
      return { type: 'named_region', label: 'table', selection: 'free_space' };
  }
  const cellText =
    /第?\s*(\d+|[一二两三四五六七八九十]{1,2})\s*(?:号|个)?格(?:子)?/.exec(text)?.[1];
  if (!cellText) return null;
  const cell = numberFromText(cellText);
  if (cell === null) return null;
  const bin = /(?:料箱|箱|区域?)\s*([A-Za-z])/i.exec(text)?.[1]?.toUpperCase() ?? 'A';
  return { type: 'bin_cell', bin_id: bin, cell_index: cell };
}

function clarificationFor(intent: RobotIntentName, target: TargetSpec): string | null {
  if (['find', 'pick', 'pick_place'].includes(intent) && !target.category) {
    return '你希望我处理哪个物体？';
  }
  if (intent === 'pick_place') {
    return '放置尚未接入；可以单独下达抓取指令。';
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
  const target = targetOf(
    ['pick_place', 'place_held'].includes(intent) ? source.split(/放到|放入|放进|摆到|放在|放回/u)[0]! : source,
  );
  const destination = destinationOf(source);
  if (process.env.BUSAGENT_ROBOT === 'franka_panda' && intent === 'pick_place' && !target.category)
    intent = 'place_held';
  const clarification =
    motion?.clarification_question ??
    (intent === 'unsupported'
      ? '当前无法将这条要求转换为已支持的动作。请使用关节转动、末端平移、归位、夹爪开合或查询能力等具体指令。'
      : intent === 'place_held'
        ? (destination ? null : '请说明放置到哪里。')
      : intent === 'pick_place' &&
          destination?.type === 'named_region' &&
          target.category
        ? null
        : clarificationFor(intent, target));
  return {
    intent,
    target,
    destination,
    constraints: { order: null, avoid: [] },
    needs_clarification: clarification !== null,
    clarification_question: clarification,
    source_text: source,
    ...(process.env.BUSAGENT_ROBOT === 'franka_panda'
      ? {
          manipulation: {
            mode: /增强|GraspGenX|AnyPlace/i.test(source)
              ? ('enhanced' as const)
              : ('auto' as const),
            precise: /精确|精准|整齐/.test(source),
            unfamiliar: /陌生|未知/.test(source),
            cluttered: /杂乱|堆叠/.test(source),
          },
        }
      : {}),
    ...(motion ? { motion: motion.motion } : {}),
  };
}

/** Continue the measured grasp, never infer holding from a historical request. */
export function routeHeldPlacement(parsed: ParsedInstruction, live: Record<string, unknown>): ParsedInstruction {
  const holding = live.holding as { verified?: boolean; label?: string } | undefined;
  if (holding?.verified !== true || parsed.intent !== 'pick_place' || !parsed.destination) return parsed;
  const target = parsed.target.category?.toLowerCase();
  const held = holding.label?.toLowerCase() ?? '';
  const color = parsed.target.attributes.color?.toLowerCase();
  if (color && !held.split(/\s+/).includes(color)) return parsed;
  if (!target || held === target || held.split(/\s+/).includes(target))
    return { ...parsed, intent: 'place_held', needs_clarification: false, clarification_question: null };
  return parsed;
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
    if (isImmediateInterrupt(textPayload(context.event.payload))) {
      cancelPendingIntent(context.event.correlationId);
      clearPreparation(context.event.correlationId);
    }
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
    let liveState: Record<string, unknown> = {};
    if (process.env.BUSAGENT_ROBOT === 'franka_panda' && parsed.intent !== 'cancel') {
      liveState = await readInteractionSnapshot(context.agentConfig.config, AbortSignal.timeout(500));
      parsed = routeHeldPlacement(parsed, liveState);
    }
    if (
      this.host?.dashscopeApiKey &&
      (parsed.intent !== 'cancel' ||
        (context.event.payload as { source?: string }).source === 'stt')
    ) {
      // Voice stop has already used the immediate lane. Still interpret the
      // complete utterance, e.g. "stop, then move above the red block".
      const remembered = this.history.get(context.event.correlationId);
      try {
        if (process.env.BUSAGENT_ROBOT !== 'franka_panda')
          liveState = await readInteractionSnapshot(context.agentConfig.config, AbortSignal.timeout(500));
        parsed = await understandSemantic(
          this.host,
          text,
          remembered && Date.now() - remembered.at < MEMORY_TTL_MS
            ? remembered.entries
            : [],
          undefined,
          typeof context.agentConfig.config.model === 'string'
            ? context.agentConfig.config.model
            : this.host.qwenChatModel,
          context.agentConfig.config.reasoning === 'none' ? 'none' : 'low',
          preparationContext(context.event.correlationId),
          {
            live_state: liveState,
            task_outcomes: recentOutcomes(context.event.correlationId),
          },
        );
      } catch (error) {
        this.logger.warn(
          `semantic understanding unavailable: ${(error as Error).message}`,
        );
        // The deterministic parser already produced a task. Keep it when the
        // optional language service is unavailable; missing fields still clarify.
      }
    }
    if (process.env.BUSAGENT_ROBOT === 'franka_panda')
      parsed = routeHeldPlacement(parsed, liveState);
    if (version !== intentVersion(context.event.correlationId)) return;
    if (
      parsed.retry_last_grasp &&
      (liveState.grasp_status as { retry_available?: boolean } | undefined)
        ?.retry_available !== true
    ) {
      parsed.needs_clarification = true;
      parsed.clarification_question =
        '当前没有可恢复的抓取。是否重新发起一次新的抓取？';
    }
    if (parsed.prepare_last_grasp) {
      const proposal = preparationContext(context.event.correlationId);
      if (proposal) parsed.grasp_preparation_id = proposal.id;
      else {
        parsed.needs_clarification = true;
        parsed.clarification_question =
          '目前没有待确认的初始准备建议，未执行移动。请重新评估抓取。';
      }
    }
    if (!['chat', 'capabilities', 'status_query'].includes(parsed.intent))
      clearPreparation(context.event.correlationId);
    const remembered = this.history.get(context.event.correlationId);
    this.history.set(context.event.correlationId, {
      at: Date.now(),
      entries: [
        ...(remembered && Date.now() - remembered.at < MEMORY_TTL_MS
          ? remembered.entries
          : []),
        parsed,
      ].slice(-INSTRUCTION_MEMORY_LIMIT),
    });
    for (const [id, memory] of this.history)
      if (Date.now() - memory.at > MEMORY_TTL_MS) this.history.delete(id);
    while (this.history.size > 500)
      this.history.delete(this.history.keys().next().value!);
    if (
      parsed.intent === 'cancel' &&
      isImmediateInterrupt(text) &&
      (context.event.payload as { source?: string }).source === 'stt'
    ) {
      await context.publish({
        event_type: 'interaction.classified',
        correlation_id: context.event.correlationId,
        causation_id: context.event.eventId,
        payload: { instruction_id: context.event.eventId, intent: 'cancel' },
      });
      return;
    }
    if (parsed.intent === 'cancel' && !isImmediateInterrupt(text))
      cancelPendingIntent(context.event.correlationId);
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
