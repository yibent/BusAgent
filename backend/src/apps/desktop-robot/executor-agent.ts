import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from '../../common/logger.js';
import {
  AgentClasses,
  type InProcessAgent,
  type InProcessEventContext,
} from '../../adapters/in-process/agent-classes.js';
import type { RobotPlan, SkillStep } from './instruction-types.js';

export const ROBOT_ADAPTER_REGISTRATION_KEY = 'RobotAdapterNode';

type ControlResult = {
  ok: boolean;
  message: string;
  data?: unknown;
};

function stringConfig(
  config: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = config[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function intConfig(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function readPlan(payload: unknown): RobotPlan | null {
  if (payload === null || typeof payload !== 'object') return null;
  const plan = (payload as { plan?: unknown }).plan;
  if (plan === null || typeof plan !== 'object') return null;
  const candidate = plan as Partial<RobotPlan>;
  if (!Array.isArray(candidate.steps) || candidate.intent === undefined) return null;
  return candidate as RobotPlan;
}

function completionMessage(plan: RobotPlan, results: ControlResult[]): string {
  const target = plan.intent.target.category ?? '目标';
  switch (plan.intent.intent) {
    case 'find':
      return `已开始识别${target}。`;
    case 'track':
      return `已开始跟踪${target}。`;
    case 'status_query':
      return statusMessage(results.at(-1)?.data);
    case 'cancel':
      return '已停止机械臂跟随。';
    case 'pick':
      return `已完成${target}抓取。`;
    case 'pick_place':
      return `已完成${target}抓取与放置。`;
    case 'chat':
      return '指令处理完成。';
  }
}

function statusMessage(data: unknown): string {
  if (data === null || typeof data !== 'object') return '已获取机械臂与视觉系统状态。';
  const status = (data as Record<string, unknown>).status;
  if (status === null || typeof status !== 'object')
    return '已获取机械臂与视觉系统状态。';
  const record = status as Record<string, unknown>;
  const following = record.follow_enabled === true ? '正在跟随' : '当前已停止跟随';
  const prompt =
    typeof record.prompt === 'string' ? `，识别目标是${record.prompt}` : '';
  const error =
    typeof record.error === 'string' && record.error
      ? `，视觉错误：${record.error}`
      : '';
  return `机械臂${following}${prompt}${error}。`;
}

export interface RobotAdapter {
  execute(
    commandId: string,
    step: SkillStep,
    taskId: string,
    taskVersion: number,
  ): Promise<ControlResult>;
}

/** HTTP provider for the RobotAdapter capability; MCP/ROS providers can replace it. */
export class HttpRobotAdapter implements RobotAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async execute(
    commandId: string,
    step: SkillStep,
    taskId: string,
    taskVersion: number,
  ): Promise<ControlResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command_id: commandId,
          skill: step.skill,
          params: step.params,
          task_id: taskId,
          task_version: taskVersion,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`controller connection failed: ${(error as Error).message}`);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : `controller HTTP ${response.status}`;
    return { ok: response.ok, message, data: body };
  }
}

@Injectable()
export class RobotAdapterNode implements InProcessAgent, OnModuleInit {
  readonly registrationKey = ROBOT_ADAPTER_REGISTRATION_KEY;
  private readonly logger = new Logger(RobotAdapterNode.name);

  onModuleInit(): void {
    if (!AgentClasses.has(this.registrationKey)) {
      AgentClasses.register(this.registrationKey, this);
    }
  }

  async handle(context: InProcessEventContext): Promise<void> {
    if (context.event.eventType !== 'robot.execute.requested') return;
    const plan = readPlan(context.event.payload);
    if (plan === null)
      throw new Error('robot.execute.requested payload has no valid plan');
    const taskId = context.event.taskId ?? `task_${context.event.correlationId}`;
    const taskVersion = context.event.taskVersion ?? plan.task_version;
    const adapter: RobotAdapter = new HttpRobotAdapter(
      stringConfig(
        context.agentConfig.config,
        'controller_url',
        'http://127.0.0.1:7861',
      ),
      intConfig(context.agentConfig.config, 'request_timeout_ms', 10_000),
    );

    await this.publishStatus(context, 'execution.accepted', {
      task_id: taskId,
      steps: plan.steps.length,
    });

    const results: ControlResult[] = [];
    for (const step of plan.steps) {
      await this.publishStatus(context, 'execution.started', {
        task_id: taskId,
        step_id: step.id,
        skill: step.skill,
      });
      let result: ControlResult;
      try {
        result = await adapter.execute(
          `${context.event.eventId}:${step.id}`,
          step,
          taskId,
          taskVersion,
        );
      } catch (error) {
        const message = (error as Error).message;
        await this.publishStatus(context, 'execution.unknown', {
          task_id: taskId,
          step_id: step.id,
          skill: step.skill,
          message,
        });
        this.logger.error(message);
        return;
      }
      if (!result.ok) {
        await this.publishStatus(context, 'execution.failed', {
          task_id: taskId,
          step_id: step.id,
          skill: step.skill,
          message: result.message,
        });
        this.logger.warn(`skill ${step.skill} failed: ${result.message}`);
        return;
      }
      results.push(result);
    }

    const message = completionMessage(plan, results);
    await this.publishStatus(context, 'execution.completed', {
      task_id: taskId,
      intent: plan.intent.intent,
      message,
      ok: true,
      results: results.map((result, index) => ({
        step_id: plan.steps[index]?.id,
        skill: plan.steps[index]?.skill,
        data: result.data,
      })),
    });
    this.logger.info(`completed task=${taskId} intent=${plan.intent.intent}`);
  }

  private async publishStatus(
    context: InProcessEventContext,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await context.publish({
      event_type: eventType,
      correlation_id: context.event.correlationId,
      causation_id: context.event.eventId,
      ...(context.event.taskId ? { task_id: context.event.taskId } : {}),
      ...(context.event.taskVersion ? { task_version: context.event.taskVersion } : {}),
      payload,
    });
  }
}
