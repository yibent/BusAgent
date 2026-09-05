import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  semanticFrame,
  understandSemantic,
} from '../src/apps/desktop-robot/semantic-understanding.js';
import { HostConfig } from '../src/config/host-config.js';
import { cancelPendingIntent } from '../src/apps/desktop-robot/pending-intents.js';
import { buildPlan } from '../src/apps/desktop-robot/planner-agent.js';
import { validatePlan } from '../src/apps/desktop-robot/plan-validator-node.js';
import { summarizeCapabilities } from '../src/apps/desktop-robot/interaction-snapshot.js';
import { GroundingClarificationNode } from '../src/apps/desktop-robot/grounding-clarification-node.js';
import { makeEvent } from './helpers.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';

describe('semantic frames and RGB-D grounding', () => {
  it('routes a conversational retry to the existing grasp, not a fresh blind pick', () => {
    const retry = semanticFrame(
      { intent: 'pick', retry_last_grasp: true },
      '重新观察后再试一次',
    );
    const plan = buildPlan(retry, 'retry')!;
    expect(retry.needs_clarification).toBe(false);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      skill: 'grasp',
      params: { retry_last: true },
    });
    expect(validatePlan(plan)).toEqual([]);
    const fresh = buildPlan(
      semanticFrame({ intent: 'pick', category: 'block' }, '抓起方块'),
      'fresh',
    )!;
    expect(fresh.steps[0]?.params).not.toHaveProperty('retry_last');
    expect(() =>
      semanticFrame({ intent: 'pick', recovery_mode: 'active' }, '抓起方块'),
    ).toThrow();
  });
  it('advertises dual cameras and conversational retry only from live capability evidence', () => {
    const summary = summarizeCapabilities({
      skills: ['grasp'],
      grasp: { dual_camera_default: true, retry_via_dialogue: true },
    });
    expect(summary).toContain('默认双相机辅助');
    expect(summary).toContain('对话确认后恢复抓取');
    expect(summary).toContain('放置未实现');
    expect(summarizeCapabilities({ skills: ['grasp'] })).not.toContain('恢复抓取');
  });
  it('keeps a natural pick as one targeted grasp, not gripper closure', () => {
    const pick = semanticFrame(
      { intent: 'pick', category: 'block', color: 'green', selector: 'leftmost' },
      '拿起最左边的绿色小方块',
    );
    expect(pick.needs_clarification).toBe(false);
    expect(pick.intent).toBe('pick');
    expect(pick.target).toMatchObject({
      category: 'block',
      attributes: { color: 'green' },
      spatial_ref: 'leftmost',
    });
    expect(pick.motion).toBeUndefined();
    expect(semanticFrame({ intent: 'pick' }, '抓起来').needs_clarification).toBe(true);
    expect(
      semanticFrame({ intent: 'pick_place', category: 'block' }, '抓起并放下')
        .needs_clarification,
    ).toBe(true);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('does not dispatch a late object goal after interruption', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const published: unknown[] = [];
    const ctx: InProcessEventContext = {
      event: makeEvent({
        eventType: 'instruction.parsed',
        correlationId: 'interrupted-ground',
        payload: semanticFrame(
          { intent: 'target_move', category: 'block', offset_m: [0, 0, 0.1] },
          '方块上方',
        ),
      }),
      agentConfig: {
        appId: 'app',
        agentId: 'ground',
        config: { provider: 'rgbd' },
        adapter: 'in-process',
        registrationKey: 'ground',
      },
      publish: (input) => {
        published.push(input);
        return Promise.resolve();
      },
    };
    await new GroundingClarificationNode().handle(ctx);
    cancelPendingIntent('interrupted-ground');
    finish(
      new Response(
        JSON.stringify({
          ok: true,
          message: '定位成功',
          target_world_m: [1, 2, 3],
          observed_at: 3,
          cancel_epoch: 0,
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(published).toEqual([]);
  });
  it.each(['把机械臂复位', '让它回到最开始那个姿势', '恢复初始姿态'])(
    '%s maps to home without keyword dependency',
    (text) => {
      expect(semanticFrame({ intent: 'home' }, text).motion?.skill).toBe('home');
    },
  );
  it('keeps object offsets separate from current-tool relative motion', () => {
    const parsed = semanticFrame(
      {
        intent: 'target_move',
        category: 'bolt',
        color: 'yellow',
        offset_m: [0, 0, 0.1],
      },
      '移到黄色螺栓上方十厘米',
    );
    expect(parsed.object_goal?.offset_m).toEqual([0, 0, 0.1]);
    expect(parsed.motion?.params.xyz_m).toBeUndefined();
    expect(parsed.target.attributes.color).toBe('yellow');
  });
  it('requires missing distance and target instead of inventing coordinates', () => {
    expect(
      semanticFrame({ intent: 'target_move' }, '去它上面').needs_clarification,
    ).toBe(true);
    expect(() => semanticFrame({ intent: 'teleport' }, '瞬移')).toThrow();
    expect(() => semanticFrame({ intent: 'gripper', opening: 3 }, '打开')).toThrow();
  });
  it('routes observation questions as find, never a made-up observation', () => {
    expect(
      semanticFrame(
        { intent: 'find', category: 'star', color: 'purple' },
        '有没有紫色五角星',
      ).intent,
    ).toBe('find');
  });
  it('passes structured conversational context to the semantic provider', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          'data: {"choices":[{"delta":{"content":"{\\"intent\\":\\"home\\"}"}}]}\n\ndata: [DONE]\n',
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const prior = semanticFrame(
      { intent: 'find', category: 'bolt', color: 'yellow' },
      '看看黄色螺栓',
    );
    const result = await understandSemantic(
      HostConfig.fromEnv({ DASHSCOPE_API_KEY: 'test' }),
      '回到最开始那个姿势',
      [prior],
    );
    expect(result.motion?.skill).toBe('home');
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('recent_instructions');
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('qwen3.8-flash');
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('json_object');
    const body = JSON.parse(
      vi.mocked(fetch).mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      enable_thinking: true,
      reasoning_effort: 'low',
      preserve_thinking: false,
    });
    expect(body).not.toHaveProperty('thinking_budget');
  });
  it.each([-90, 90])(
    'preserves signed base joint motion (%s) without an IK rotation',
    (degrees) => {
      const parsed = semanticFrame(
        { intent: 'move_joint', joint: 'shoulder_pan', degrees },
        '底座改口旋转',
      );
      expect(parsed.motion).toEqual({
        skill: 'move_joint',
        params: { joint: 'shoulder_pan', degrees, absolute: false },
      });
      expect(parsed.needs_clarification).toBe(false);
    },
  );
  it('keeps a base-coordinate end-effector rotation distinct from the base joint', () => {
    const parsed = semanticFrame(
      { intent: 'rotate', axis: 'z', degrees: -90, frame: 'base' },
      '末端绕基座Z轴顺时针转90度',
    );
    expect(parsed.motion).toEqual({
      skill: 'rotate',
      params: { axis: 'z', degrees: -90, frame: 'base' },
    });
  });
  it('uses only camera-provided XYZ plus its freshness token for object movement', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              message: '定位完成',
              target_world_m: [0.3, 0.1, 1.2],
              observed_at: 50,
              cancel_epoch: 0,
            }),
          ),
        ),
      ),
    );
    const published: unknown[] = [];
    const ctx: InProcessEventContext = {
      event: makeEvent({
        eventType: 'instruction.parsed',
        payload: semanticFrame(
          { intent: 'target_move', category: 'bolt', offset_m: [0, 0, 0.1] },
          '去螺栓上方10cm',
        ),
      }),
      agentConfig: {
        appId: 'app',
        agentId: 'ground',
        config: { provider: 'rgbd' },
        adapter: 'in-process',
        registrationKey: 'ground',
      },
      publish: (input) => {
        published.push(input);
        return Promise.resolve();
      },
    };
    await new GroundingClarificationNode().handle(ctx);
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toMatchObject({
      event_type: 'command.grounded',
      payload: {
        instruction: {
          motion: {
            params: {
              xyz_m: [0.3, 0.1, 1.2],
              absolute: true,
              grounding: { observed_at: 50 },
            },
          },
        },
      },
    });
  });
});
