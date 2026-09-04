import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseInstruction } from '../src/apps/desktop-robot/instruction-agent.js';
import { buildPlan } from '../src/apps/desktop-robot/planner-agent.js';
import { validatePlan } from '../src/apps/desktop-robot/plan-validator-node.js';
import { ExecutionCoordinatorNode } from '../src/apps/desktop-robot/execution-coordinator-agent.js';
import { RobotAdapterNode } from '../src/apps/desktop-robot/executor-agent.js';
import { GroundingClarificationNode } from '../src/apps/desktop-robot/grounding-clarification-node.js';
import {
  InterruptMonitorNode,
  isImmediateInterrupt,
} from '../src/apps/desktop-robot/interrupt-monitor-node.js';
import { selectLoopProfiles } from '../src/apps/desktop-robot/loop-router-node.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';
import { makeEvent } from './helpers.js';

function agentContext(
  eventType: string,
  payload: unknown,
  published: Array<Record<string, unknown>>,
  config: Record<string, unknown> = {},
): InProcessEventContext {
  return {
    event: makeEvent({
      eventType,
      sourceAgentId: 'test.source',
      correlationId: 'corr_robot',
      taskId: 'task_robot',
      taskVersion: 1,
      payload,
    }),
    agentConfig: {
      appId: 'desktop-robot-assistant',
      agentId: 'test.agent',
      config,
      adapter: 'in-process',
      registrationKey: 'TestAgent',
    },
    publish: (input) => {
      published.push(input as Record<string, unknown>);
      return Promise.resolve();
    },
  };
}

describe('robot instruction understanding and planning', () => {
  it('parses a pick-place command into the report schema', () => {
    const parsed = parseInstruction('把左侧的红色滚柱放到三号格');
    expect(parsed).toMatchObject({
      intent: 'pick_place',
      target: {
        category: 'roller',
        attributes: { color: 'red' },
        spatial_ref: '左侧',
      },
      destination: { type: 'bin_cell', bin_id: 'A', cell_index: 3 },
      needs_clarification: false,
    });
  });

  it('requests clarification when a required slot is absent', () => {
    const parsed = parseInstruction('把左边的扳手放好');
    expect(parsed.intent).toBe('pick_place');
    expect(parsed.needs_clarification).toBe(true);
    expect(parsed.clarification_question).toContain('哪个料箱格');

    const missingTarget = parseInstruction('帮我找一下');
    expect(missingTarget.needs_clarification).toBe(true);
    expect(missingTarget.clarification_question).toContain('哪个物体');
  });

  it('does not silently execute an unresolved spatial reference', async () => {
    const published: Array<Record<string, unknown>> = [];
    await new GroundingClarificationNode().handle(
      agentContext(
        'instruction.parsed',
        parseInstruction('找左边的红色滚柱'),
        published,
      ),
    );
    expect(published[0]).toMatchObject({
      event_type: 'clarification.requested',
      payload: { reason: 'SCENE_GRAPH_UNAVAILABLE' },
    });
  });

  it('expands pick-place into parameterized skills', () => {
    const parsed = parseInstruction('把滚柱放到3号格');
    const plan = buildPlan(parsed, 'ins_1');
    expect(plan?.steps.map((step) => step.skill)).toEqual([
      'perceive',
      'select_target',
      'plan_grasp',
      'move_to',
      'grasp',
      'transport',
      'place',
      'verify_placement',
    ]);
    expect(validatePlan(plan!)).toEqual([]);
  });

  it('detects immediate hold phrases without semantic-model processing', () => {
    expect(isImmediateInterrupt('等一下，先别动')).toBe(true);
    expect(isImmediateInterrupt('继续找红色方块')).toBe(false);
  });

  it('routes a spoken interruption directly into a hold execution plan', async () => {
    const interruptEvents: Array<Record<string, unknown>> = [];
    await new InterruptMonitorNode().handle(
      agentContext(
        'transcript.delta',
        { text: '停一下', source: 'stt' },
        interruptEvents,
      ),
    );

    expect(interruptEvents).toHaveLength(1);
    expect(interruptEvents[0]).toMatchObject({
      event_type: 'interrupt.requested',
      priority: 0,
      payload: { source: 'voice', text: '停一下' },
    });

    const executionEvents: Array<Record<string, unknown>> = [];
    await new ExecutionCoordinatorNode().handle(
      agentContext('interrupt.requested', interruptEvents[0]?.payload, executionEvents),
    );

    expect(executionEvents[0]).toMatchObject({
      event_type: 'robot.execute.requested',
      payload: {
        plan: {
          intent: { intent: 'cancel' },
          steps: [{ skill: 'hold' }],
        },
      },
    });
  });

  it('selects control loops from deployable configuration', () => {
    const plan = buildPlan(parseInstruction('拿起扳手'), 'ins_loop')!;
    const selected = selectLoopProfiles(plan, {
      profiles: {
        grasp: {
          primary: 'fine_grasp_visual_servo',
          fallbacks: ['fine_grasp_act', 'fine_grasp_vla'],
        },
      },
    });
    expect(selected.find((profile) => profile.skill === 'grasp')).toMatchObject({
      loop_profile: 'fine_grasp_visual_servo',
      fallbacks: ['fine_grasp_act', 'fine_grasp_vla'],
    });
  });
});

describe('execution coordination and controller adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds the minimal physical-event metadata before execution', async () => {
    const published: Array<Record<string, unknown>> = [];
    const plan = buildPlan(parseInstruction('跟踪红色方块'), 'corr_robot')!;
    await new ExecutionCoordinatorNode().handle(
      agentContext(
        'execution.profile.selected',
        { plan, validation: { status: 'approved' } },
        published,
      ),
    );
    expect(published[0]).toMatchObject({
      event_type: 'robot.execute.requested',
      task_id: 'task_robot',
      task_version: 1,
      idempotency_key: 'execute:task_robot:v1',
      payload: {
        execution_credential: 'gate:task_robot:v1',
        lane_key: 'arm-01',
      },
    });
  });

  it('executes each planned skill through the HTTP control adapter', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, message: 'accepted' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const intent = parseInstruction('跟踪红色方块');
    const plan = buildPlan(intent, 'ins_2')!;
    const published: Array<Record<string, unknown>> = [];
    await new RobotAdapterNode().handle(
      agentContext(
        'robot.execute.requested',
        { plan, execution_credential: 'local-desktop-robot' },
        published,
        { controller_url: 'http://robot.local:7861', request_timeout_ms: 1000 },
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(published.at(-1)).toMatchObject({
      event_type: 'execution.completed',
      payload: { intent: 'track', ok: true },
    });
  });

  it('reports unsupported controller skills instead of claiming success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: false, error: 'skill is not implemented' }),
            {
              status: 501,
              headers: { 'content-type': 'application/json' },
            },
          ),
        ),
      ),
    );
    const plan = buildPlan(parseInstruction('拿起扳手'), 'ins_3')!;
    const published: Array<Record<string, unknown>> = [];
    await new RobotAdapterNode().handle(
      agentContext('robot.execute.requested', { plan }, published),
    );
    expect(published.at(-1)).toMatchObject({
      event_type: 'execution.failed',
      payload: { message: 'skill is not implemented' },
    });
  });

  it('turns controller status into a factual completion message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              message: 'status returned',
              status: { follow_enabled: false, prompt: 'red block', error: null },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );
    const plan = buildPlan(parseInstruction('现在什么状态'), 'ins_4')!;
    const published: Array<Record<string, unknown>> = [];
    await new RobotAdapterNode().handle(
      agentContext('robot.execute.requested', { plan }, published),
    );
    expect(published.at(-1)).toMatchObject({
      event_type: 'execution.completed',
      payload: {
        message: '机械臂当前已停止跟随，识别目标是red block。',
        ok: true,
      },
    });
  });
});
