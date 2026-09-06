import { describe, expect, it, vi } from 'vitest';
import {
  summarizeVision,
  readInteractionSnapshot,
} from '../src/apps/desktop-robot/interaction-snapshot.js';

it('keeps previous perception answers out of the parallel acknowledgement context', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        vision: { request_id: 'old', label: 'yellow block', ok: true },
        motion: {
          mode: 'hold',
          last_command: {
            skill: 'perceive',
            state: 'completed',
            message: 'yellow block seen',
          },
        },
        capabilities: { skills: ['perceive'] },
      }),
    ),
  );
  try {
    const snapshot = await readInteractionSnapshot({}, new AbortController().signal);
    expect(snapshot.available).toBe(true);
    expect(snapshot).not.toHaveProperty('visual_evidence');
    expect(JSON.stringify(snapshot)).not.toContain('yellow block');
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('visual evidence in text context', () => {
  it('includes a detected target while excluding image and mask payloads', () => {
    const result = summarizeVision({
      sequence: 12,
      vision: {
        request_id: 'obs',
        label: 'red block',
        ok: true,
        image: 'secret-image',
        views: [
          {
            camera: 'scene',
            status: 'observed',
            sequence: 10,
            rgb: 'pixels',
            mask: [1, 0],
          },
        ],
      },
    });
    expect(result).toMatchObject({
      available: true,
      target: 'red block',
      result: 'observed',
      exhaustive_inventory: false,
    });
    expect(result.views).toEqual([
      { camera: 'scene', status: 'observed', sequence: 10 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret-image|pixels|"mask"/);
  });
  it('does not turn a destination catalog failure into an absent object', () => {
    const result = summarizeVision({
      vision: null,
      last_result: { message: "Target is absent: red block. Available: ['blue pad']" },
    });
    expect(result).toMatchObject({
      available: false,
      result: 'unknown',
      exhaustive_inventory: false,
    });
    expect(result.target).toBeUndefined();
  });
});

import { readFileSync } from 'node:fs';
import { buildPlan } from '../src/apps/desktop-robot/planner-agent.js';
import type { ParsedInstruction } from '../src/apps/desktop-robot/instruction-types.js';
import { semanticFrame } from '../src/apps/desktop-robot/semantic-understanding.js';

it('observes the whole scene without asking for a target', () => {
  const instruction = semanticFrame(
    { intent: 'find', scope: 'scene' },
    '现在场景里有什么？',
  );
  expect(instruction.needs_clarification).toBe(false);
  expect(instruction.target.category).toBeNull();
  const plan = buildPlan(instruction, 'scene-query', 1, true);
  expect(plan?.steps).toHaveLength(1);
  expect(plan?.steps[0]).toMatchObject({
    skill: 'perceive',
    params: { scope: 'scene', category: null },
  });
});

it('summarizes fresh scene detections without leaking nested image data or candidate vocabulary', () => {
  const summary = summarizeVision({
    sequence: 30,
    prompt: 'red block',
    vision: {
      scope: 'scene',
      request_id: 'fresh-scene',
      label: 'scene',
      ok: true,
      observed_at: 123,
      queries: ['absent object'],
      views: [
        {
          camera: 'side',
          sequence: 29,
          status: 'described',
          objects: [
            { label: 'yellow cylinder', mask: 'mask-bytes', image: 'image-bytes' },
          ],
          regions: [{ description: 'toy', rgb: 'rgb-bytes' }],
        },
      ],
    },
  });
  expect(summary).toMatchObject({
    source: 'last_scene_observation',
    observed_at: 123,
    detected_objects: ['yellow cylinder'],
    region_descriptions: ['toy'],
    exhaustive_inventory: false,
  });
  expect(JSON.stringify(summary)).not.toMatch(
    /red block|absent object|mask-bytes|image-bytes|rgb-bytes/,
  );
});

it('routes Panda find requests to one parameterized Arena observation', () => {
  const app = JSON.parse(
    readFileSync('backend-config/apps/desktop-robot.app.json', 'utf8'),
  );
  const grounding = app.agents.find(
    (a: { agent_id: string }) => a.agent_id === 'robot.grounding_clarification',
  );
  const planner = app.agents.find(
    (a: { agent_id: string }) => a.agent_id === 'robot.task_planner',
  );
  expect(grounding.config.provider).toBe('semantic_passthrough');
  const instruction = {
    intent: 'find',
    target: { category: 'block', attributes: { color: 'red' } },
  } as ParsedInstruction;
  const plan = buildPlan(
    instruction,
    'query',
    1,
    planner.config.perception_selects_target,
  );
  expect(plan?.steps).toEqual([
    expect.objectContaining({
      skill: 'perceive',
      params: expect.objectContaining({
        category: 'block',
        attributes: { color: 'red' },
      }),
    }),
  ]);
});
