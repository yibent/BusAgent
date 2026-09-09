import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { planGoal } from '../src/apps/desktop-robot/intelligence/planning.js';
import { validateVisualReferences } from '../src/apps/desktop-robot/intelligence/planning-context.js';
import { clearModelCooldowns } from '../src/apps/desktop-robot/intelligence/model-routing.js';
import {
  applyResult,
  executablePlan,
} from '../src/apps/desktop-robot/intelligence/task-engine.js';
import {
  retryByPolicy,
  physicalVerdict,
  supervisionUnavailableVerdict,
  mergePhysicalVisualVerdict,
} from '../src/apps/desktop-robot/intelligence/execution-policy.js';
import {
  decisionSchema,
  emptyQueue,
  type Goal,
  type QueueStep,
} from '../src/apps/desktop-robot/intelligence/types.js';
import type { ModelProfile } from '../src/apps/desktop-robot/intelligence/model-config.js';
import type { ModelAnswer } from '../src/apps/desktop-robot/intelligence/model-client.js';
import { randomUUID } from 'node:crypto';
const profile = {
  id: 'mastra-test',
  name: 'test',
  provider: 'gemini',
  model: 'test',
  baseUrl: 'https://example.test/v1',
  apiKey: 'fake',
  vision: true,
  thinking: false,
  enabled: true,
} as ModelProfile;
const action = {
  title: 'pick',
  skill: 'grasp',
  params: { target: 'red block' },
  review_after: false,
  execution: {
    loop: 'fast_only' as const,
    max_attempts: 2,
    supervision: { kind: 'physical' as const },
  },
};
const step = (): QueueStep => ({
  ...action,
  id: 's',
  state: 'running',
  attempt: 1,
  task_id: 'task',
  command_id: 'cmd',
});
const goal = (): Goal => ({
  id: 'g',
  conversation_id: 'c',
  input_event_id: 'evt',
  source: 'pick and place',
  state: 'running',
  mode: 'complex',
  summary: '',
  completion: '',
  message: '',
  review_reason: '',
  recovery_count: 0,
  created_at: '',
  updated_at: '',
  model_calls: 0,
  revision: 1,
  steps: [step()],
});
const answer = (calls: [string, unknown][]): ModelAnswer => ({
  model: 'test',
  usage: {},
  elapsed_ms: 1,
  message: {
    role: 'assistant',
    content: null,
    tool_calls: calls.map(([name, args]) => ({
      id: randomUUID(),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })),
  },
});
afterEach(() => clearModelCooldowns());
describe('Mastra owns the decision loop', () => {
  it.each([
    {
      name: 'simple',
      mode: 'simple',
      scope: 'complete',
      review: undefined,
      final: false,
    },
    {
      name: 'legacy finite batch',
      mode: undefined,
      scope: undefined,
      review: undefined,
      final: false,
    },
    {
      name: 'complex stage',
      mode: 'complex',
      scope: 'stage',
      review: undefined,
      final: true,
    },
    {
      name: 'explicit simple review',
      mode: 'simple',
      scope: 'complete',
      review: true,
      final: true,
    },
  ])(
    'accepts a $name decision and the whole sequence in one response',
    async ({ mode, scope, review, final }) => {
      const call = vi.fn().mockResolvedValue(
        answer([
          [
            'submit_plan',
            {
              ...(mode ? { mode } : {}),
              ...(scope ? { plan_scope: scope } : {}),
              ...(review === undefined ? {} : { final_review: review }),
              outcome: 'continue',
              actions: [
                { title: '拿起', skill: 'grasp', params: { target: 'cylinder' } },
                {
                  title: '放下',
                  skill: 'place_held',
                  params: { destination: { label: 'table', selection: 'free_space' } },
                },
                { title: '回位', skill: 'home', params: {} },
              ],
            },
          ],
        ]),
      );
      const readState = vi.fn().mockResolvedValue({
        holding: { verified: false },
        capabilities: { skills: ['grasp', 'place_held', 'home'] },
      });
      const readImage = vi.fn(),
        observe = vi.fn();
      const result = await planGoal(
        profile,
        'planner',
        {
          ...goal(),
          id: randomUUID(),
          steps: [],
          source: '拿起一个圆柱放到桌面空处，再回位',
        },
        emptyQueue(),
        {
          persistBrain: true,
          images: true,
          readState,
          readImage,
          observe,
          record: vi.fn(),
        },
        AbortSignal.timeout(5000),
        call,
      );
      expect(result.mode).toBe(mode ?? 'simple');
      expect(result.final_review).toBe(final);
      expect(result.plan_scope).toBe(scope);
      expect(result.actions.map((a) => a.skill)).toEqual([
        'grasp',
        'place_held',
        'home',
      ]);
      expect(result.actions.every((a) => !a.review_after)).toBe(true);
      expect(result.actions.every((a) => a.execution?.loop === 'fast_then_slow')).toBe(
        true,
      );
      expect(call).toHaveBeenCalledOnce();
      expect(readState).toHaveBeenCalledOnce();
      expect(readImage).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
    },
  );
  it('accepts the stable cell identity actually returned by the geometry tool', () => {
    const decision = decisionSchema.parse({
      outcome: 'continue',
      actions: [
        {
          ...action,
          skill: 'place_held',
          params: { destination: { cell_ref: `grid:${'c'.repeat(32)}:2:3` } },
        },
      ],
    });
    expect(() => validateVisualReferences(decision)).not.toThrow();
  });
  it('deduplicates identical observations and executes independent tools concurrently, then commits a batch without another call', async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const observe = vi.fn(async () => {
      await barrier;
      return { ok: true, request_id: 'a'.repeat(32) };
    });
    const readHistory = vi.fn(() => {
      release!();
      return Promise.resolve({ entries: [] });
    });
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        answer([
          ['observe_objects', { category: 'part' }],
          ['observe_objects', { category: 'part' }],
          ['read_history', {}],
        ]),
      )
      .mockResolvedValueOnce(
        answer([
          [
            'submit_plan',
            {
              outcome: 'continue',
              actions: [
                action,
                {
                  ...action,
                  title: 'place',
                  skill: 'place_held',
                  params: { destination: { label: 'table', selection: 'free_space' } },
                },
              ],
              plan_scope: 'complete',
            },
          ],
        ]),
      );
    const result = await planGoal(
      profile,
      'planner',
      { ...goal(), steps: [] },
      emptyQueue(),
      {
        images: false,
        readState: () =>
          Promise.resolve({ capabilities: { skills: ['grasp', 'place_held'] } }),
        readImage: vi.fn(),
        observe,
        readHistory,
        record: vi.fn(),
      },
      AbortSignal.timeout(3000),
      call,
    );
    expect(result.actions).toHaveLength(2);
    expect(call).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(call.mock.calls[0]?.[2])).toContain(
      '"enum":["grasp","place_held"]',
    );
  });
  it('forces a structured decision after two tool rounds without losing current execution facts', async () => {
    const recovery = goal();
    recovery.steps[0]!.state = 'failed';
    recovery.steps[0]!.result = { failure: { code: 'NO_FREE_SPACE' } };
    recovery.steps.push({
      ...step(),
      id: 'pending-home',
      state: 'pending',
      skill: 'home',
    });
    let count = 0;
    const call = vi.fn(
      (
        _profile,
        messages: import('../src/apps/desktop-robot/intelligence/model-client.js').Message[],
        _tools,
        _signal,
        options,
      ) => {
        expect(JSON.stringify(messages)).toContain('retain-this-original-goal');
        const control = messages.filter(
          (m) =>
            m.role === 'system' &&
            typeof m.content === 'string' &&
            m.content.startsWith('当前执行事实'),
        );
        expect(control).toHaveLength(1);
        const content = control[0]!.content as string;
        expect(JSON.parse(content.slice(content.indexOf('{')))).toMatchObject({
          holding: { verified: true, object_id: 'object:held' },
          failed: [{ id: 's', failure: { code: 'NO_FREE_SPACE' } }],
          pending: [{ id: 'pending-home', skill: 'home' }],
        });
        const ids = messages
          .flatMap((m) => m.tool_calls ?? [])
          .map((c) => c.id)
          .sort();
        expect(
          messages
            .filter((m) => m.role === 'tool')
            .map((m) => m.tool_call_id)
            .sort(),
        ).toEqual(ids);
        const forced =
          typeof options?.toolChoice === 'object' &&
          options.toolChoice.function.name === 'submit_plan';
        count++;
        return Promise.resolve(
          forced
            ? answer([
                [
                  'submit_plan',
                  {
                    outcome: 'continue',
                    actions: [
                      {
                        ...action,
                        skill: 'place_held',
                        params: {
                          destination: { label: 'table', selection: 'free_space' },
                        },
                      },
                    ],
                    queue_update: 'replace_pending',
                  },
                ],
              ])
            : answer([['read_history', { query: `part-${count}` }]]),
        );
      },
    );
    const record = vi
      .fn<(event: Record<string, unknown>) => Promise<void>>()
      .mockResolvedValue();
    const result = await planGoal(
      profile,
      'planner',
      { ...recovery, source: 'retain-this-original-goal' },
      emptyQueue(),
      {
        images: false,
        contextBudgetTokens: 10000,
        toolResultBudgetTokens: 1000,
        toolRounds: 14,
        readState: () =>
          Promise.resolve({ holding: { verified: true, object_id: 'object:held' } }),
        readImage: vi.fn(),
        readHistory: ({ query }) =>
          Promise.resolve({
            query,
            evidence: Array.from({ length: 40 }, (_, i) => ({
              ref: `observed-${i}`,
              description: 'measured state '.repeat(12),
            })),
          }),
        record,
      },
      AbortSignal.timeout(6000),
      call,
    );
    expect(result.actions).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(3);
    expect(record.mock.calls.some(([e]) => e.kind === 'brain_stopped')).toBe(false);
    expect(call.mock.calls.at(-1)![1].length).toBeLessThan(12);
  });

  it('can enter recovery with a large physical report without exhausting the initial message budget', async () => {
    const g = goal();
    g.steps[0]!.state = 'failed';
    g.steps[0]!.result = {
      evaluation: {
        diagnostics: Array.from({ length: 2000 }, (_, i) => ({
          sample: i,
          position: [0.1, 0.2, 0.3],
        })),
      },
    };
    const call = vi
      .fn()
      .mockResolvedValue(
        answer([['submit_plan', { outcome: 'continue', actions: [action] }]]),
      );
    const result = await planGoal(
      profile,
      'planner',
      g,
      emptyQueue(),
      {
        images: false,
        conversation: {
          history: 'large conversation with many previous tasks '.repeat(2000),
        },
        readState: () => Promise.resolve({ holding: { verified: true } }),
        readImage: vi.fn(),
        record: vi.fn(),
      },
      AbortSignal.timeout(3000),
      call,
    );
    expect(result.actions).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('persists Mastra working memory across separate brain runs without a summarizer model call', async () => {
    vi.stubEnv(
      'BUSAGENT_MASTRA_DIR',
      mkdtempSync(join(tmpdir(), 'mastra-robot-memory-')),
    );
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        answer([
          [
            'updateWorkingMemory',
            { memory: '# Current task\nChosen container: observed-blue-tray-marker' },
          ],
        ]),
      )
      .mockResolvedValueOnce(
        answer([
          [
            'submit_plan',
            { outcome: 'continue', actions: [action], plan_scope: 'complete' },
          ],
        ]),
      );
    const context = {
      persistBrain: true,
      images: false,
      readState: () => Promise.resolve({}),
      readImage: vi.fn(),
      record: vi.fn(),
    };
    await planGoal(
      profile,
      'planner',
      { ...goal(), steps: [] },
      emptyQueue(),
      context,
      AbortSignal.timeout(5000),
      call,
    );
    expect(call).toHaveBeenCalledTimes(2);
    const follow = vi
      .fn()
      .mockResolvedValue(
        answer([
          [
            'submit_plan',
            { outcome: 'chat', actions: [], message: 'observed-blue-tray-marker' },
          ],
        ]),
      );
    await planGoal(
      profile,
      'planner',
      goal(),
      emptyQueue(),
      context,
      AbortSignal.timeout(5000),
      follow,
    );
    expect(JSON.stringify(follow.mock.calls[0]![1])).toContain(
      'observed-blue-tray-marker',
    );
    expect(JSON.stringify(follow.mock.calls[0]![1])).not.toContain('data:image');
    expect(follow).toHaveBeenCalledOnce();
    const unrelated = vi
      .fn()
      .mockResolvedValue(
        answer([
          ['submit_plan', { outcome: 'chat', actions: [], message: 'no history' }],
        ]),
      );
    await planGoal(
      profile,
      'planner',
      { ...goal(), id: 'unrelated' },
      emptyQueue(),
      context,
      AbortSignal.timeout(5000),
      unrelated,
    );
    expect(JSON.stringify(unrelated.mock.calls[0]![1])).not.toContain(
      'observed-blue-tray-marker',
    );
    vi.unstubAllEnvs();
  });
  it('carries execution policy as metadata and preserves the physical mode in the controller command', () => {
    const g = goal();
    const s = g.steps[0]!;
    const plan = executablePlan(g, s);
    expect(plan.steps[0]!.params).toMatchObject({
      mode: 'basic',
      execution_policy: action.execution,
    });
    s.execution = { loop: 'slow' };
    expect(executablePlan(g, s).steps[0]!.params.mode).toBe('enhanced');
  });
  it('creates exactly one asynchronous check for a completed command and leaves subsequent actions runnable', () => {
    const state = emptyQueue(),
      g = goal();
    state.goals = [g];
    const payload = { command_id: 'cmd', ok: true, holding: { verified: true } };
    applyResult(state, 'task', 'execution.completed', payload);
    applyResult(state, 'task', 'execution.completed', payload);
    expect(g.state).toBe('running');
    expect(g.checks).toHaveLength(1);
    expect(g.checks![0]!.state).toBe('pending');
  });
  it('retries a confirmed failure only to the configured limit; released or held objects are returned for a new decision', () => {
    const state = emptyQueue(),
      g = goal();
    state.goals = [g];
    g.steps[0]!.state = 'failed';
    g.state = 'review';
    const make = vi.fn((old: QueueStep) => ({
      ...old,
      id: 'retry',
      task_id: 'retry-task',
      command_id: 'retry-command',
      state: 'pending' as const,
    }));
    for (const result of [
      { error_type: 'FileNotFoundError' },
      { error_type: 'ValueError' },
      { failure: { code: 'REFERENCE_STALE' } },
      { failure: { code: 'TARGET_AMBIGUOUS' } },
      { failure: { code: 'TARGET_NOT_FOUND' } },
      { failure: { code: 'NO_FREE_SPACE' } },
      { failure: { code: 'NO_CANDIDATE' } },
    ]) {
      g.steps[0]!.result = result;
      expect(retryByPolicy(g, state, make)).toBe(false);
    }
    expect(make).not.toHaveBeenCalled();
    g.steps[0]!.result = {};
    expect(retryByPolicy(g, state, make)).toBe(true);
    const retry = g.steps[1]!;
    expect(retry.attempt).toBe(2);
    expect(g.steps[0]!.state).toBe('superseded');
    retry.state = 'failed';
    expect(retryByPolicy(g, state, make)).toBe(false);
    retry.attempt = 1;
    retry.result = { evaluation: { released: true } };
    expect(retryByPolicy(g, state, make)).toBe(false);
    retry.result = {};
    state.scene.holding = { verified: true };
    expect(retryByPolicy(g, state, make)).toBe(false);
    retry.skill = 'place_held';
    expect(retryByPolicy(g, state, make)).toBe(true);
  });
  it('requires release and physical evidence before a local visual presence check can establish placement', () => {
    expect(physicalVerdict({ ok: true }, 'place_held')).toBe('uncertain');
    expect(
      physicalVerdict(
        {
          ok: true,
          evaluation: { physical_success: true, released: true },
          holding: { verified: false },
        },
        'place_held',
      ),
    ).toBe('passed');
    expect(
      physicalVerdict({ ok: true, holding: { verified: true } }, 'place_held'),
    ).toBe('failed');
  });
  it('does not replay a physically completed action when optional visual supervision is unavailable', () => {
    expect(supervisionUnavailableVerdict('passed')).toBe('passed');
    expect(supervisionUnavailableVerdict('uncertain')).toBe('uncertain');
    expect(supervisionUnavailableVerdict('failed')).toBe('uncertain');
  });
  it('keeps physical success on visual uncertainty but respects a visual failure', () => {
    expect(mergePhysicalVisualVerdict('passed', 'uncertain')).toBe('passed');
    expect(mergePhysicalVisualVerdict('passed', 'failed')).toBe('failed');
    expect(mergePhysicalVisualVerdict('uncertain', 'passed')).toBe('uncertain');
  });
  it('retains batch append and final review controls in the machine-readable decision', () => {
    expect(
      decisionSchema.parse({
        actions: [action],
        queue_update: 'append',
        final_review: true,
      }),
    ).toMatchObject({
      queue_update: 'append',
      final_review: true,
      actions: [{ execution: action.execution }],
    });
  });
});
