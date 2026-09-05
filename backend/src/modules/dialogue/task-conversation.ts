import type { InProcessEventContext } from '../../adapters/in-process/agent-classes.js';
import type { ParsedInstruction } from '../../apps/desktop-robot/instruction-types.js';

export type TaskStage =
  | 'understanding'
  | 'grounding'
  | 'planning'
  | 'queued'
  | 'submitted'
  | 'executing'
  | 'clarification'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'conversation';
export interface ConversationTask {
  id: string;
  conversationId: string;
  source: string;
  stage: TaskStage;
  instruction?: ParsedInstruction;
  feedback?: string;
  interactionReply?: string;
  classifiedIntent?: string;
  progressSpoken?: boolean;
  waitingFor?: string;
  afterTask?: string;
  queuePosition?: number;
  graspProgress?: unknown;
  updatedAt: number;
  version?: number;
  muted?: boolean;
  startedOrder?: number;
  commandId?: string;
  requestOrder?: number;
}
const ranks: Record<TaskStage, number> = {
  understanding: 0,
  grounding: 1,
  planning: 2,
  queued: 3,
  submitted: 4,
  executing: 5,
  clarification: 6,
  completed: 6,
  failed: 6,
  cancelled: 6,
  unknown: 6,
  conversation: 6,
};
export function taskFinished(task: ConversationTask): boolean {
  return ranks[task.stage] === 6;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/** Read-only conversational memory, never a command router or execution authority. */
export class TaskConversation {
  private readonly tasks = new Map<string, ConversationTask>();
  private startedOrder = 0;
  private requestOrder = 0;

  silenceOpen(conversation: string): string[] {
    const ids: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.conversationId === conversation && !taskFinished(task)) {
        task.muted = true;
        ids.push(task.id);
      }
    }
    return ids;
  }

  canReport(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.muted) return false;
    return ![...this.tasks.values()].some(
      (other) =>
        other.conversationId === task.conversationId &&
        other.startedOrder !== undefined &&
        (other.requestOrder ?? 0) > (task.requestOrder ?? 0),
    );
  }

  observe(context: InProcessEventContext): ConversationTask | undefined {
    const event = context.event;
    const payload = record(event.payload);
    const id =
      event.taskId ??
      (event.eventType === 'intent.created'
        ? `task_${event.eventId}`
        : event.eventType === 'interaction.classified' &&
            typeof payload.instruction_id === 'string'
          ? `task_${payload.instruction_id}`
          : undefined);
    if (!id) return undefined;
    const task = this.tasks.get(id) ?? {
      id,
      conversationId: event.correlationId,
      source: '',
      stage: 'understanding' as TaskStage,
      updatedAt: Date.now(),
      requestOrder: ++this.requestOrder,
    };
    if (task.conversationId !== event.correlationId) return undefined;
    const version = event.taskVersion ?? 1;
    if (version < (task.version ?? 1)) return undefined;
    if (event.eventType.startsWith('execution.')) {
      if (taskFinished(task) && task.stage !== 'unknown') return undefined;
      if (
        task.commandId &&
        typeof payload.command_id === 'string' &&
        task.commandId !== payload.command_id
      )
        return undefined;
      if (typeof payload.command_id === 'string') task.commandId = payload.command_id;
    }
    task.version = version;
    const instruction = record(
      event.eventType === 'instruction.parsed' ? payload : payload.instruction,
    );
    if (typeof instruction.intent === 'string' && instruction.target) {
      task.instruction = instruction as unknown as ParsedInstruction;
      task.source = task.instruction.source_text;
    }
    let stage: TaskStage | undefined;
    switch (event.eventType) {
      case 'intent.created':
        task.source = String(payload.text ?? '');
        break;
      case 'interaction.classified':
        stage = 'conversation';
        task.classifiedIntent = String(payload.intent ?? 'chat');
        break;
      case 'instruction.parsed':
        stage =
          task.instruction?.object_goal || task.instruction?.intent === 'find'
            ? 'grounding'
            : 'planning';
        break;
      case 'command.grounded':
        stage = 'planning';
        break;
      case 'execution.queued':
        stage = 'queued';
        if (typeof payload.waiting_for === 'string') {
          task.waitingFor = payload.waiting_for;
          task.afterTask = payload.waiting_for;
        }
        if (typeof payload.queue_position === 'number')
          task.queuePosition = payload.queue_position;
        break;
      case 'execution.accepted':
        stage = 'submitted';
        delete task.waitingFor;
        delete task.queuePosition;
        break;
      case 'execution.started':
      case 'execution.progress':
        stage = 'executing';
        task.startedOrder ??= ++this.startedOrder;
        if (payload.grasp) task.graspProgress = payload.grasp;
        break;
      case 'clarification.requested':
        stage = 'clarification';
        break;
      case 'observation.ready':
      case 'execution.completed':
        stage = 'completed';
        break;
      case 'execution.cancelled':
        stage = 'cancelled';
        break;
      case 'execution.failed':
      case 'plan.rejected':
      case 'plan.failed':
        stage = 'failed';
        break;
      case 'execution.unknown':
        stage = 'unknown';
        break;
    }
    // Fan-out deliveries may arrive out of order; a late parse cannot revive a result.
    if (
      stage &&
      ranks[stage] >= ranks[task.stage] &&
      (!taskFinished(task) || task.stage === 'unknown')
    )
      task.stage = stage;
    task.updatedAt = Date.now();
    this.tasks.set(id, task);
    for (const [key, entry] of this.tasks)
      if (Date.now() - entry.updatedAt > 120 * 60_000) this.tasks.delete(key);
    while (this.tasks.size > 500) this.tasks.delete(this.tasks.keys().next().value!);
    return task;
  }

  snapshot(conversationId: string): unknown[] {
    const conversation = [...this.tasks.values()].filter(
      (t) => t.conversationId === conversationId,
    );
    // Keep running/waiting tasks even after many status questions or chat turns.
    return [
      ...new Set([
        ...conversation.filter((t) => !taskFinished(t) && !t.muted),
        ...conversation.slice(-24),
      ]),
    ].map((t) => ({
      task_id: t.id,
      user_request: t.source,
      stage: t.stage,
      feedback_suppressed: t.muted === true,
      action: actionName(t.instruction),
      feedback: t.feedback,
      grasp_progress: t.graspProgress,
      waiting_for: t.waitingFor,
      after_task: t.afterTask,
      queue_position: t.queuePosition,
      instruction: t.instruction
        ? {
            intent: t.instruction.intent,
            target: t.instruction.target,
            motion: t.instruction.motion,
            object_goal: t.instruction.object_goal,
          }
        : undefined,
      updated_at: new Date(t.updatedAt).toISOString(),
    }));
  }

  focus(conversationId: string, currentTaskId: string): Record<string, unknown> {
    const tasks = [...this.tasks.values()].filter(
      (t) => t.conversationId === conversationId,
    );
    const compact = (t: ConversationTask) => ({
      task_id: t.id,
      action: actionName(t.instruction),
      source: t.source,
      stage: t.stage,
      feedback: t.feedback,
      waiting_for: t.waitingFor,
    });
    return {
      current_request: tasks.find((t) => t.id === currentTaskId)
        ? compact(tasks.find((t) => t.id === currentTaskId)!)
        : null,
      executing: tasks
        .filter(
          (t) =>
            t.id !== currentTaskId &&
            !t.muted &&
            ['executing', 'submitted'].includes(t.stage),
        )
        .map(compact),
      waiting: tasks
        .filter((t) => t.id !== currentTaskId && !t.muted && t.stage === 'queued')
        .map(compact),
      recently_finished: tasks.filter(taskFinished).slice(-3).map(compact),
      rule: '新请求尚未开始；先记住当前正在执行的动作，再承接新要求。真实排队只以execution.queued为证据，真实开始只以execution.started为证据。',
    };
  }
}

const colors: Record<string, string> = {
  yellow: '黄色',
  green: '绿色',
  red: '红色',
  blue: '蓝色',
  white: '白色',
  black: '黑色',
  purple: '紫色',
};
const categories: Record<string, string> = {
  bolt: '螺栓',
  nut: '螺母',
  block: '方块',
  gear: '齿轮',
  cup: '杯子',
  wrench: '扳手',
  roller: '滚柱',
  power_drill: '电钻',
};
export function targetName(instruction?: ParsedInstruction): string {
  const target = instruction?.target;
  if (!target?.category) return '目标物体';
  const color = target.attributes?.color ?? '';
  return `${colors[color] ?? color}${categories[target.category] ?? target.category}`;
}

export function actionName(instruction?: ParsedInstruction): string {
  if (instruction?.prepare_last_grasp) return '确认后回到初始准备姿态（不抓取）';
  if (instruction?.retry_last_grasp) return '重新观察并重试上次抓取';
  if (instruction?.intent === 'pick') return `抓取${targetName(instruction)}`;
  if (instruction?.object_goal) {
    const [x, y, z] = instruction.object_goal.offset_m;
    const offset =
      x === 0 && y === 0 && z !== 0
        ? `${z > 0 ? '上' : '下'}方${Number((Math.abs(z) * 100).toFixed(1))}厘米`
        : '指定偏移位置';
    return `移动到${targetName(instruction)}${offset}`;
  }
  const motion = instruction?.motion;
  const skill = motion?.skill;
  if (skill === 'home') return '复位';
  if (skill === 'move_joint') {
    const names: Record<string, string> = {
      shoulder_pan: '底座',
      shoulder_lift: '第二关节',
      elbow_flex: '第三关节',
      wrist_flex: '腕部俯仰关节',
      wrist_roll: '腕部旋转关节',
    };
    return `${names[String(motion?.params.joint)] ?? '关节'}转动`;
  }
  return (
    (
      {
        gripper: '夹爪开合',
        move_cartesian: '末端移动',
        rotate: '末端旋转',
        rotate_end_effector: '末端旋转',
        hold: '暂停',
        stop: '停止',
        resume: '继续动作',
        set_speed: '调速',
      } as Record<string, string>
    )[skill ?? ''] ?? (instruction?.intent === 'track' ? '目标跟随' : '动作')
  );
}

export function progressText(task: ConversationTask): string {
  if (task.stage === 'grounding') return `正在定位${targetName(task.instruction)}。`;
  if (task.stage === 'planning') return '正在准备动作，还未收到开始反馈。';
  if (task.stage === 'queued') return '动作仍在等待队列，尚未下发控制器。';
  if (task.stage === 'submitted') return '动作已提交，等待控制器开始。';
  if (
    task.stage === 'executing' &&
    (task.instruction?.prepare_last_grasp ||
      record(task.graspProgress).preparation_only === true)
  )
    return '正在回到初始准备姿态，尚未确认到位；没有执行抓取。';
  if (task.stage === 'executing')
    return task.instruction?.intent === 'pick'
      ? '抓取仍在进行，尚未确认夹持与抬升成功。'
      : `${actionName(task.instruction)}仍在进行，尚未确认到位。`;
  return '还在确认这条指令，尚未收到执行反馈。';
}
