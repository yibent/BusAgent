import { describe, expect, it, vi } from 'vitest';
import { routeInitialRequest } from '../src/apps/desktop-robot/intelligence/request-routing.js';
import { planGoal } from '../src/apps/desktop-robot/intelligence/planning.js';
import { emptyQueue, type Goal } from '../src/apps/desktop-robot/intelligence/types.js';
import type { ModelProfile } from '../src/apps/desktop-robot/intelligence/model-config.js';
const profile = { id: 'test', model: 'gemini', vision: true } as ModelProfile;
const action = {
  title: '拿起红块',
  skill: 'grasp',
  params: { target: 'red block' },
  review_after: false,
};
const answer = (name: string, value: unknown) => ({
  model: 'test',
  elapsed_ms: 1,
  usage: {},
  message: {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 't',
        type: 'function',
        function: { name, arguments: JSON.stringify(value) },
      },
    ],
  },
});
const goal = {
  id: 'new',
  conversation_id: 'current',
  source: '还没有得到结果吗？',
  steps: [],
} as unknown as Goal;

describe('compact first planner request', () => {
  it('finishes a simple action in one call without images, old detections or a second planner', async () => {
    const call = vi
      .fn()
      .mockResolvedValue(
        answer('route_request', {
          kind: 'execute',
          summary: '拿起红块',
          actions: [action],
        }),
      );
    const readImage = vi.fn(),
      observe = vi.fn(),
      validate = vi.fn();
    const live = {
      holding: { verified: false },
      capabilities: { skills: ['grasp'] },
      visual_candidates: ['obsolete-ref'],
      world: { objects: [{ ref: 'old-geometry' }] },
    };
    const result = await planGoal(
      profile,
      'planner',
      { ...goal, source: '帮我拿起红块' },
      emptyQueue(),
      {
        routeRequests: true,
        images: true,
        readState: vi.fn().mockResolvedValue(live),
        readImage,
        observe,
        validate,
        record: vi.fn(),
      },
      new AbortController().signal,
      call,
    );
    expect(result.actions).toEqual([action]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(readImage).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledWith(result);
    expect(JSON.stringify(call.mock.calls[0])).not.toMatch(/obsolete-ref|old-geometry/);
  });
  it('drops action fields on a status result and never dispatches or revives an archived goal', async () => {
    const state = emptyQueue();
    state.goals = [
      {
        ...goal,
        id: 'old',
        source: '历史工业任务',
        state: 'blocked',
        conversation_id: 'other',
        created_at: '2026-09-06',
        interaction: false,
        steps: [action],
      } as unknown as Goal,
    ];
    const call = vi
      .fn()
      .mockResolvedValue(
        answer('route_request', { kind: 'status', actions: [action] }),
      );
    const result = await routeInitialRequest(
      [profile],
      goal,
      state,
      {},
      {},
      new AbortController().signal,
      vi.fn(),
      call,
    );
    expect(result.actions).toEqual([]);
    expect(JSON.stringify(call.mock.calls[0])).not.toContain('历史工业任务');
  });
  it('enforces query-only tools and rejects motion even if the full model invents it', async () => {
    const decision = { outcome: 'continue', mode: 'simple', actions: [action] };
    const call = vi
      .fn()
      .mockResolvedValueOnce(answer('route_request', { kind: 'query' }))
      .mockResolvedValueOnce(answer('submit_plan', decision))
      .mockResolvedValueOnce(
        answer('submit_plan', {
          outcome: 'chat',
          message: '目前没有完成记录。',
          actions: [],
        }),
      );
    const manageQueue = vi.fn();
    const result = await planGoal(
      profile,
      'planner',
      goal,
      emptyQueue(),
      {
        routeRequests: true,
        images: false,
        readState: vi.fn().mockResolvedValue({}),
        readImage: vi.fn(),
        manageQueue,
        record: vi.fn(),
      },
      new AbortController().signal,
      call,
    );
    expect(result.outcome).toBe('chat');
    expect(result.actions).toEqual([]);
    expect(manageQueue).not.toHaveBeenCalled();
    expect(JSON.stringify(call.mock.calls[1]?.[2])).not.toContain('manage_queue');
  });
});
