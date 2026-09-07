import { describe, expect, it } from 'vitest';
import {
  actionSchema,
  decisionSchema,
} from '../src/apps/desktop-robot/intelligence/types.js';
import { validateVisualReferences } from '../src/apps/desktop-robot/intelligence/planning-context.js';
import { actionParamsJsonSchema } from '../src/apps/desktop-robot/intelligence/action-params.js';

const ref = 'obs:fecd8a2f5c474109b56220bb7eb1452a:side_camera:0';
const parse = (params: Record<string, unknown>, skill = 'grasp') =>
  actionSchema.parse({ title: '执行用户要求', skill, params });

describe('planner to execution parameter contract', () => {
  it('uses an integer range accepted by the Gemini gateway for endpoint indices', () => {
    expect(actionParamsJsonSchema.properties.orientation.properties.endpoint).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 1,
    });
  });
  it('routes an observed reference as identity instead of a detector category', () => {
    expect(parse({ target: ref, mode: 'auto' }).params.target).toEqual({ ref });
    expect(parse({ destination: ref }, 'place_held').params.destination).toEqual({
      ref,
    });
    expect(parse({ target: 'metal cylinder' }).params.target).toBe('metal cylinder');
  });
  it('preserves the orientation emitted during the failed industrial run', () => {
    const action = parse(
      {
        axis_ref: ref,
        endpoint: 0,
        endpoint_direction: 'up',
        mode: 'auto',
        destination: { ref, selection: 'free_space', relation: 'inside' },
      },
      'place_held',
    );
    expect(action.params).toEqual({
      mode: 'auto',
      destination: { ref, selection: 'free_space' },
      relation: 'inside',
      orientation: { axis_ref: ref, endpoint: 0, direction: 'up' },
    });
  });
  it('does not silently execute after dropping incomplete or conflicting orientation', () => {
    expect(() => parse({ target: ref, orientation_axis_ref: ref })).toThrow(
      '完整 orientation',
    );
    expect(() =>
      parse({
        target: ref,
        orientation: { axis_ref: ref, endpoint: 0, direction: 'up' },
        endpoint: 1,
      }),
    ).toThrow('冲突');
    expect(() => parse({ target: ref, approach_angle: 90 })).toThrow('approach_angle');
  });
  it('ignores unfilled optional values and leaves other skill contracts alone', () => {
    expect(
      parse({ target: ref, orientation_axis_ref: null, approach_angle: null }).params,
    ).toEqual({ target: { ref } });
    expect(
      parse({ inspect: 'grid', ref, cameras: ['side_camera'] }, 'perceive').params
        .inspect,
    ).toBe('grid');
  });
  it('validates a normalized literal reference before execution', () => {
    const decision = decisionSchema.parse({
      actions: [{ title: '抓取', skill: 'grasp', params: { target: 'obs:truncated' } }],
    });
    expect(() => validateVisualReferences(decision)).toThrow('完整复制');
  });
});
