import { describe, expect, it } from 'vitest';
import { summarizeVision } from '../src/apps/desktop-robot/interaction-snapshot.js';

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
