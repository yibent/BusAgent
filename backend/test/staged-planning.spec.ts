import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyQueue, type Goal } from '../src/apps/desktop-robot/intelligence/types.js';
import type {
  ModelProfile,
  ModelSettings,
} from '../src/apps/desktop-robot/intelligence/model-config.js';
import { runStagedPlanning } from '../src/apps/desktop-robot/intelligence/staged-planning.js';

const profile = (fields: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'test',
  name: 'Test',
  provider: 'openai-compatible',
  baseUrl: 'https://model.test/v1',
  model: 'test-model',
  apiKey: 'test-key',
  vision: false,
  thinking: false,
  enabled: true,
  timeoutMs: 2000,
  firstTokenTimeoutMs: 500,
  ...fields,
});
const settings = {
  architecture: { mode: 'staged', stageRetryLimit: 2, finalReview: true },
} as ModelSettings;
const goal = (): Goal => ({
  id: 'goal-1',
  conversation_id: 'conversation-1',
  input_event_id: 'event-1',
  source: '把红色方块放到黄色托盘',
  interaction: true,
  state: 'planning',
  mode: 'simple',
  summary: '',
  completion: '',
  steps: [],
  message: '',
  review_reason: '',
  recovery_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model_calls: 0,
  revision: 1,
});

function toolResponse(name: string, value: unknown) {
  const encoder = new TextEncoder();
  const payload = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name, arguments: JSON.stringify(value) },
            },
          ],
        },
      },
    ],
  });
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${payload}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function sentBody(request: ReturnType<typeof vi.fn>, index: number) {
  return JSON.parse((request.mock.calls[index]![1] as RequestInit).body as string) as {
    messages: unknown[];
  };
}

describe('staged task architecture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a complete simple sequence with one task-model request', async () => {
    const request = vi.fn().mockResolvedValue(
      toolResponse('submit_task_route', {
        disposition: 'simple',
        summary: '放置红色方块',
        completion: '红色方块位于黄色托盘内',
        requirement: '',
        actions: [
          {
            title: '抓放红色方块',
            skill: 'pick_place',
            params: { target: 'red block', destination: 'yellow tray' },
            execution: { loop: 'fast_then_slow', supervision: { kind: 'physical' } },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', request);
    const result = await runStagedPlanning(
      {
        settings,
        taskProfiles: [profile()],
        plannerProfiles: [profile({ id: 'advanced' })],
        goal: goal(),
        queue: emptyQueue(),
        live: { capabilities: { skills: ['pick_place'] }, holding: {} },
        readImage: vi.fn(),
        observeScene: vi.fn(),
        record: vi.fn().mockResolvedValue(undefined),
      },
      AbortSignal.timeout(3000),
    );
    expect(result.mode).toBe('simple');
    expect(result.actions).toHaveLength(1);
    expect(result.architecture).toBe('staged');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sends a frozen image only to a box-capable advanced model', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        toolResponse('submit_task_route', {
          disposition: 'complex',
          summary: '整理零件',
          completion: '零件已放入托盘',
          requirement: '选择一个倾倒圆柱并直立放入托盘',
          actions: [],
        }),
      )
      .mockResolvedValueOnce(
        toolResponse('submit_plan', {
          outcome: 'continue',
          summary: '整理零件',
          completion: '圆柱直立在托盘内',
          actions: [
            {
              title: '放置倾倒圆柱',
              skill: 'pick_place',
              params: {
                target: {
                  label: 'fallen cylinder',
                  grounding: {
                    snapshot_ref: 'a'.repeat(32),
                    camera: 'scene_camera',
                    box_2d: [100, 200, 400, 350],
                  },
                },
                destination: {
                  label: 'blue tray',
                  grounding: {
                    snapshot_ref: 'a'.repeat(32),
                    camera: 'scene_camera',
                    box_2d: [500, 500, 900, 900],
                  },
                  selection: 'free_space',
                },
              },
              execution: { loop: 'slow' },
              stage: {
                id: 'stage-1',
                number: 1,
                title: '直立放置圆柱',
                depends_on: [],
                expected_state: '圆柱直立在蓝色托盘内',
              },
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', request);
    const image = vi.fn().mockResolvedValue({
      bytes: Buffer.from('image'),
      metadata: { snapshot_ref: 'a'.repeat(32), camera: 'scene' },
    });
    const observe = vi.fn();
    const result = await runStagedPlanning(
      {
        settings,
        taskProfiles: [profile()],
        plannerProfiles: [
          profile({ id: 'advanced', vision: true, boxGrounding: true }),
        ],
        goal: goal(),
        queue: emptyQueue(),
        live: { capabilities: { skills: ['pick_place'] }, holding: {} },
        readImage: image,
        observeScene: observe,
        record: vi.fn().mockResolvedValue(undefined),
      },
      AbortSignal.timeout(3000),
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(image).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    expect(JSON.stringify(sentBody(request, 1).messages)).toContain(
      'data:image/jpeg;base64',
    );
    expect(result.actions[0]?.execution?.supervision).toMatchObject({
      kind: 'florence',
      region_label: 'blue tray',
      wait: false,
    });
  });

  it('uses local YOLOE/SAM3/Florence evidence for a non-visual advanced model', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        toolResponse('submit_task_route', {
          disposition: 'complex',
          summary: '整理零件',
          completion: '零件已归类',
          requirement: '按类别整理桌面零件',
          actions: [],
        }),
      )
      .mockResolvedValueOnce(
        toolResponse('submit_plan', {
          outcome: 'continue',
          actions: [
            {
              title: '放置齿轮',
              skill: 'pick_place',
              params: { target: 'gear', destination: 'parts tray' },
              execution: { loop: 'fast_then_slow' },
              stage: {
                id: 'stage-1',
                number: 1,
                title: '归类齿轮',
                depends_on: [],
                expected_state: '齿轮位于零件托盘内',
              },
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', request);
    const image = vi.fn();
    const observe = vi.fn().mockResolvedValue({
      vision: {
        views: [
          {
            camera: 'scene_camera',
            objects: [{ label: 'gear', semantic_status: 'detected' }],
            regions: [{ description: 'gear beside parts tray' }],
          },
        ],
      },
    });
    await runStagedPlanning(
      {
        settings,
        taskProfiles: [profile()],
        plannerProfiles: [profile({ id: 'deepseek', vision: false })],
        goal: goal(),
        queue: emptyQueue(),
        live: { capabilities: { skills: ['pick_place'] }, holding: {} },
        readImage: image,
        observeScene: observe,
        record: vi.fn().mockResolvedValue(undefined),
      },
      AbortSignal.timeout(3000),
    );
    expect(image).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledOnce();
    expect(JSON.stringify(sentBody(request, 1).messages)).toContain(
      'gear beside parts tray',
    );
  });
});
