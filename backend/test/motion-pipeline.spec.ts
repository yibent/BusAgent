import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  InstructionUnderstandingNode,
  parseInstruction,
} from '../src/apps/desktop-robot/instruction-agent.js';
import { buildPlan } from '../src/apps/desktop-robot/planner-agent.js';
import { RobotAdapterNode } from '../src/apps/desktop-robot/executor-agent.js';
import { validatePlan } from '../src/apps/desktop-robot/plan-validator-node.js';
import { makeEvent } from './helpers.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';

type PublishedEvent = Parameters<InProcessEventContext['publish']>[0];

function context(
  text: string,
  events: PublishedEvent[],
  id = 'event',
): InProcessEventContext {
  return {
    event: makeEvent({
      eventId: id,
      eventType: 'intent.created',
      correlationId: 'motion-session',
      payload: { text },
    }),
    agentConfig: {
      appId: 'desktop-robot-assistant',
      agentId: 'test',
      config: {},
      adapter: 'in-process',
      registrationKey: 'test',
    },
    publish: (input) => {
      events.push(input);
      return Promise.resolve();
    },
  };
}
describe('motion language and execution truth', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it.each([
    ['底座顺时针旋转九十度', 'move_joint', { joint: 'shoulder_pan', degrees: 90 }],
    [
      '第二关节转到负二十度',
      'move_joint',
      { joint: 'shoulder_lift', degrees: -20, absolute: true },
    ],
    ['手腕逆时针转15度', 'move_joint', { joint: 'wrist_roll', degrees: 15 }],
    [
      '末端绕工具Z轴顺时针旋转10度',
      'rotate',
      { axis: 'z', degrees: -10, frame: 'tool' },
    ],
    ['向上移动两厘米', 'move_cartesian', { xyz_m: [0, 0, 0.02] }],
    ['沿X轴负方向移动10毫米', 'move_cartesian', { xyz_m: [-0.01, 0, 0] }],
    [
      '移动到世界坐标X0.2，Y0.1，Z1.3米',
      'move_cartesian',
      { xyz_m: [0.2, 0.1, 1.3], absolute: true },
    ],
    ['归位', 'home', {}],
    ['打开夹爪', 'gripper', { opening: 1 }],
    ['夹爪开度百分之五十', 'gripper', { opening: 0.5 }],
    ['向上五毫米', 'move_cartesian', { xyz_m: [0, 0, 0.005] }],
    ['闭合夹爪', 'gripper', { opening: 0 }],
    ['继续执行', 'resume', {}],
    ['速度每秒20度', 'set_speed', { degrees_per_second: 20 }],
  ])('%s produces a validated skill', (text, skill, params) => {
    const parsed = parseInstruction(text);
    expect(parsed.needs_clarification).toBe(false);
    expect(parsed.motion).toMatchObject({ skill, params });
    expect(validatePlan(buildPlan(parsed, 'test')!)).toEqual([]);
  });
  it('completes the reported three-turn rotation clarification without chat', async () => {
    const node = new InstructionUnderstandingNode();
    const events: PublishedEvent[] = [];
    for (const [i, text] of ['旋转九十度', '绕绕z轴旋转', '顺时针旋转'].entries())
      await node.handle(context(text, events, String(i)));
    expect(events.map((e) => e.event_type)).toEqual([
      'instruction.parsed',
      'instruction.parsed',
      'instruction.parsed',
    ]);
    expect(events[2]?.payload).toMatchObject({
      needs_clarification: false,
      motion: { skill: 'rotate', params: { axis: 'z', degrees: -90 } },
    });
    expect(new Set(events.map((e) => e.task_id)).size).toBe(3);
  });
  it('keeps unsupported requests and capability/status questions out of ordinary chat', () => {
    expect(parseInstruction('你有什么能力').intent).toBe('capabilities');
    expect(parseInstruction('我没有看到执行效果').intent).toBe('status_query');
    expect(parseInstruction('机械臂跳个舞').intent).toBe('unsupported');
  });
  it('routes the web pause button and voice pause through the same interrupt vocabulary', async () => {
    for (const text of ['停一下', '等一下', '停', '暂停', '停止', '不抓取了'])
      expect(parseInstruction(text).intent).toBe('cancel');
    const events: PublishedEvent[] = [];
    const node = new InstructionUnderstandingNode();
    await node.handle(context('停一下', events, 'typed-pause'));
    expect(events[0]).toMatchObject({ payload: { intent: 'cancel' } });
    const spoken = context('停一下', events, 'voice-pause');
    spoken.event.payload = { text: '停一下', source: 'stt' };
    await node.handle(spoken);
    expect(events.filter((e) => e.event_type === 'instruction.parsed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      event_type: 'interaction.classified',
      payload: { intent: 'cancel' },
    });
  });
  it('does not complete an accepted command until measured result, and frees delivery for stop', async () => {
    vi.useFakeTimers();
    let phase = 'started';
    const events: PublishedEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              options?.method === 'POST'
                ? { ok: true, state: 'accepted', command_id: 'cmd', message: 'queued' }
                : { ok: true, state: phase, message: 'measured arrival' },
            ),
            { status: 200 },
          ),
        ),
      ),
    );
    const ctx = context('', events);
    ctx.event = makeEvent({
      eventType: 'robot.execute.requested',
      payload: { plan: buildPlan(parseInstruction('归位'), 'home') },
    });
    await new RobotAdapterNode().handle(ctx);
    await vi.advanceTimersByTimeAsync(200);
    expect(events.some((e) => e.event_type === 'execution.started')).toBe(true);
    expect(events.some((e) => e.event_type === 'execution.completed')).toBe(false);
    phase = 'completed';
    await vi.advanceTimersByTimeAsync(200);
    expect(events.at(-1)).toMatchObject({
      event_type: 'execution.completed',
      payload: { message: 'measured arrival' },
    });
  });
  it('treats HTTP 200 with ok:false as failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: false, message: 'BUSY' }))),
      ),
    );
    const events: PublishedEvent[] = [];
    const ctx = context('', events);
    ctx.event = makeEvent({
      eventType: 'robot.execute.requested',
      payload: { plan: buildPlan(parseInstruction('归位'), 'home') },
    });
    await new RobotAdapterNode().handle(ctx);
    expect(events.at(-1)).toMatchObject({
      event_type: 'execution.failed',
      payload: { message: 'BUSY' },
    });
  });
});
