import { describe, expect, it } from 'vitest';
import {
  latestReferences,
  planningEvidence,
  validateVisualReferences,
} from '../src/apps/desktop-robot/intelligence/planning-context.js';
import { decisionSchema } from '../src/apps/desktop-robot/intelligence/types.js';
const ref = (id: string, index = 0) => `obs:${id.repeat(32)}:scene_camera:${index}`;

describe('planning observation context', () => {
  it('drops old duplicate frames without merging different instances', () => {
    const rows = [
      { label: 'nut', camera: 'scene_camera', ref: ref('a') },
      { label: 'nut', camera: 'scene_camera', ref: ref('b', 0) },
      { label: 'nut', camera: 'scene_camera', ref: ref('b', 1) },
      { label: 'gear', camera: 'scene_camera', ref: ref('c') },
    ];
    expect(latestReferences(rows)).toEqual(rows.slice(1));
  });
  it('keeps observed references, uncertainty and physical outcome while excluding tracking history', () => {
    const row = {
      label: 'nut',
      ok: false,
      semantic_status: 'ambiguous',
      references: [{ ref: ref('b') }],
      physical_witness: { votes: { entity_01: 99 } },
      views: [
        {
          camera: 'scene_camera',
          status: 'ambiguous',
          candidates: [{ box: [1, 2, 3, 4], ref: ref('b') }],
          stages: Array.from({ length: 100 }, () => ({ model: 'lk' })),
        },
      ],
    };
    const raw = {
      recent_observations: Array.from({ length: 32 }, () => row),
      result: { evaluation: { physical_success: false }, vision: row },
    };
    const compact = planningEvidence(raw);
    expect(JSON.stringify(compact).length).toBeLessThan(
      JSON.stringify(raw).length / 10,
    );
    expect(JSON.stringify(compact)).toContain(ref('b'));
    expect(JSON.stringify(compact)).toContain('ambiguous');
    expect(JSON.stringify(compact)).not.toContain('entity_01');
    expect(compact).toMatchObject({
      result: { evaluation: { physical_success: false } },
    });
  });
  it('returns malformed observation references to the model before physical dispatch', () => {
    const decision = decisionSchema.parse({
      actions: [
        {
          title: 'place',
          skill: 'place_held',
          params: {
            destination: { label: 'tray', region_ref: `obs:${'a'.repeat(32)}` },
          },
        },
      ],
    });
    expect(() => validateVisualReferences(decision)).toThrow('完整复制');
    decision.actions[0]!.params.destination = { label: 'tray', region_ref: ref('a') };
    expect(() => validateVisualReferences(decision)).not.toThrow();
    decision.actions[0]!.params.destination = {
      label: 'unfamiliar thing',
      selection: 'free_space',
    };
    expect(() => validateVisualReferences(decision)).not.toThrow();
  });
});
