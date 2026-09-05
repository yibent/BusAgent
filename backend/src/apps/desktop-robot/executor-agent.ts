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
  state?: string | undefined;
  commandId?: string | undefined;
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
    case 'motion':
      return results.at(-1)?.message ?? '控制器未返回动作结果';
    case 'capabilities':
      return results.at(-1)?.message ?? '无法读取控制器能力';
    case 'unsupported':
      return '当前不支持该动作。';
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
  const motion = record.motion as Record<string, unknown> | undefined;
  const last = motion?.last_command as Record<string, unknown> | undefined;
  if (last)
    return `机械臂当前${motion?.mode === 'moving' ? '正在运动' : '保持位置'}。最近动作${String(last.skill)}，状态${String(last.state)}：${String(last.message)}。`;
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
    return {
      ok: response.ok && body.ok !== false,
      message,
      data: body,
      state: typeof body.state === 'string' ? body.state : undefined,
      commandId: typeof body.command_id === 'string' ? body.command_id : undefined,
    };
  }

  async result(commandId: string): Promise<ControlResult> {
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, '')}/api/commands/${encodeURIComponent(commandId)}`,
      { signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (!response.ok) throw new Error(`控制器命令状态不可用：HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    return {
      ok: body.ok !== false,
      message: typeof body.message === 'string' ? body.message : '',
      state: String(body.state),
      commandId,
      data: body,
    };
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
    const adapter = new HttpRobotAdapter(
      stringConfig(
        context.agentConfig.config,
        'controller_url',
        'http://127.0.0.1:7861',
      ),
      intConfig(context.agentConfig.config, 'request_timeout_ms', 10_000),
    );

    const results: ControlResult[] = [];
    for (const step of plan.steps) {
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
      await this.publishStatus(context, 'execution.accepted', {
        task_id: taskId,
        step_id: step.id,
        skill: step.skill,
        command_id: result.commandId,
      });
      if (result.state === 'accepted' || result.state === 'started') {
        // Release the adapter delivery queue so voice HOLD can reach the arm.
        // Finite motion plans currently contain exactly one controller command.
        void this.watchMotion(context, adapter, result, step);
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

  private async watchMotion(
    context: InProcessEventContext,
    adapter: HttpRobotAdapter,
    first: ControlResult,
    step: SkillStep,
  ): Promise<void> {
    try {
      if (!first.commandId) throw new Error('控制器未返回命令编号，结果未知');
      const deadline = Date.now() + 120_000;
      let started = false;
      while (Date.now() < deadline) {
        const result = await adapter.result(first.commandId);
        if (!started && result.state === 'started') {
          started = true;
          await this.publishStatus(context, 'execution.started', {
            skill: step.skill,
            step_id: step.id,
            command_id: first.commandId,
            message: result.message,
          });
        }
        if (['completed', 'failed', 'cancelled'].includes(result.state ?? '')) {
          await this.publishStatus(
            context,
            result.state === 'completed' && result.ok
              ? 'execution.completed'
              : 'execution.failed',
            {
              skill: step.skill,
              step_id: step.id,
              command_id: first.commandId,
              message: result.message,
              result: result.data,
            },
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error('等待运动结果超时，结果未知；请查询状态，不要自动重发');
    } catch (error) {
      await this.publishStatus(context, 'execution.unknown', {
        skill: step.skill,
        message: (error as Error).message,
      }).catch((e) => this.logger.error(String(e)));
    }
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
