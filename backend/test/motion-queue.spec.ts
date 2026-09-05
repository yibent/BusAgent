import { afterEach, describe, expect, it, vi } from 'vitest';
import { RobotAdapterNode } from '../src/apps/desktop-robot/executor-agent.js';
import { buildPlan } from '../src/apps/desktop-robot/planner-agent.js';
import { parseInstruction } from '../src/apps/desktop-robot/instruction-agent.js';
import { makeEvent } from './helpers.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';

function setup() {
  vi.useFakeTimers();
  const node = new RobotAdapterNode();
  const commands: { command_id: string; skill: string; task_id: string }[] = [];
  const events: Parameters<InProcessEventContext['publish']>[0][] = [];
  const states = new Map<string, string>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(options.body as string);
        commands.push(body);
        if (['hold', 'stop', 'status'].includes(body.skill))
          return Response.json({ ok: true, state: 'completed', message: 'done' });
        states.set(body.command_id, 'started');
        return Response.json({
          ok: true,
          state: 'accepted',
          command_id: body.command_id,
          message: 'accepted',
        });
      }
      const id = decodeURIComponent(url.split('/').at(-1)!);
      const state = states.get(id);
      if (state === 'unavailable') throw new Error('connection lost');
      return Response.json({
        ok: state === 'started' || state === 'completed',
        state,
        message: state,
      });
    }),
  );
  const context = (
    id: string,
    text: string,
    conversation = 'one',
  ): InProcessEventContext => ({
    event: makeEvent({
      eventId: id,
      eventType: 'robot.execute.requested',
      correlationId: conversation,
      taskId: id,
      taskVersion: 1,
      payload: { plan: buildPlan(parseInstruction(text), id) },
    }),
    agentConfig: {
      appId: 'desktop-robot-assistant',
      agentId: 'robot.device_adapter',
      adapter: 'in-process',
      registrationKey: node.registrationKey,
      config: {},
    },
    publish: async (event) => {
      events.push(event);
    },
  });
  const complete = async (id: string, state = 'completed') => {
    states.set(`${id}:1`, state);
    await vi.advanceTimersByTimeAsync(200);
  };
  return { node, commands, events, context, complete };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('physical motion queue', () => {
  it('waits for measured completion, then starts the next arm action once', async () => {
    const t = setup();
    await t.node.handle(t.context('grip', '打开夹爪'));
    await t.node.handle(t.context('base', '底座顺时针转90度'));
    await t.node.handle(t.context('home', '归位'));
    expect(t.commands.map((c) => c.skill)).toEqual(['gripper']);
    expect(
      t.events.filter((e) => e.event_type === 'execution.queued').map((e) => e.task_id),
    ).toEqual(['base', 'home']);
    await t.complete('grip');
    expect(t.commands.map((c) => c.skill)).toEqual(['gripper', 'move_joint']);
    const completion = t.events.findIndex(
      (e) => e.event_type === 'execution.completed' && e.task_id === 'grip',
    );
    const nextAccepted = t.events.findIndex(
      (e) => e.event_type === 'execution.accepted' && e.task_id === 'base',
    );
    expect(nextAccepted).toBeGreaterThan(completion);
    await t.complete('base');
    expect(t.commands.map((c) => c.skill)).toEqual(['gripper', 'move_joint', 'home']);
    await t.complete('home');
  });
  it('shares the physical lane across browser conversations', async () => {
    const t = setup();
    await t.node.handle(t.context('one', '归位', 'browser-a'));
    await t.node.handle(t.context('two', '打开夹爪', 'browser-b'));
    expect(t.commands).toHaveLength(1);
    await t.complete('one');
    expect(t.commands).toHaveLength(2);
    await t.complete('two');
  });
  it('lets pause bypass the queue and cancels waiting actions without replay', async () => {
    const t = setup();
    await t.node.handle(t.context('grip', '打开夹爪'));
    await t.node.handle(t.context('base', '底座顺时针转90度'));
    await t.node.handle(t.context('pause', '暂停'));
    expect(t.commands.map((c) => c.skill)).toEqual(['gripper', 'hold']);
    expect(t.events).toContainEqual(
      expect.objectContaining({ event_type: 'execution.cancelled', task_id: 'base' }),
    );
    // A newly issued action after pause may run, but the old queue must not revive.
    await t.node.handle(t.context('new', '归位'));
    await t.complete('grip', 'cancelled');
    expect(t.commands.map((c) => c.task_id)).toEqual(['grip', 'pause', 'new']);
    await t.complete('new');
  });
  it.each(['failed', 'unavailable'])(
    'does not continue queued actions after %s',
    async (state) => {
      const t = setup();
      await t.node.handle(t.context('first', '归位'));
      await t.node.handle(t.context('second', '打开夹爪'));
      await t.complete('first', state);
      expect(t.commands).toHaveLength(1);
      expect(t.events).toContainEqual(
        expect.objectContaining({
          event_type: 'execution.cancelled',
          task_id: 'second',
        }),
      );
    },
  );
  it('allows status queries during a running action', async () => {
    const t = setup();
    await t.node.handle(t.context('first', '归位'));
    await t.node.handle(t.context('query', '查询状态'));
    expect(t.commands.map((c) => c.skill)).toEqual(['home', 'status']);
    await t.complete('first');
  });
});
