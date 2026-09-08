import { describe, expect, it, vi } from 'vitest';
import {
  groundPrimitive,
  needsPrimitiveGrounding,
} from '../src/apps/desktop-robot/intelligence/primitive-grounding.js';
import type { Action } from '../src/apps/desktop-robot/intelligence/types.js';
const request: Action = {
  title: '任选一个零件放入任一料箱空位',
  skill: 'pick_place',
  review_after: false,
  params: {
    target: { label: 'metal cylinder', selection: 'any' },
    destination: { label: 'bin', selection: 'free_space', instance_selection: 'any' },
  },
};
describe('late binding for ordinary manipulations', () => {
  it('relocalizes a learned reference before using it and avoids another VLM call', async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce({ collection: { instances: [{ ref: 'part' }] } })
      .mockResolvedValueOnce({ collection: { instances: [] } })
      .mockResolvedValueOnce({
        vision: { references: [{ ref: 'fresh-bin', kind: 'object' }] },
      })
      .mockResolvedValueOnce({
        geometry: { kind: 'grid', cells: [{ ref: 'cell', occupancy: 'empty' }] },
      });
    const recover = vi.fn();
    const result = await groundPrimitive(request, observe, recover, [
      { label: 'bin', ref: 'stale-bin', current: false },
    ]);
    expect(observe).toHaveBeenCalledWith({
      ref: 'stale-bin',
      selection: 'one',
      vision_mode: 'auto',
    });
    expect(result.params.destination).toMatchObject({
      ref: 'fresh-bin',
      cell_ref: 'cell',
    });
    expect(recover).not.toHaveBeenCalled();
  });
  it('falls back only the missing selection, then returns to local geometry', async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce({ collection: { instances: [{ ref: 'part' }] } })
      .mockResolvedValueOnce({ collection: { instances: [] } })
      .mockResolvedValueOnce({
        geometry: { kind: 'grid', cells: [{ occupancy: 'empty', ref: 'cell' }] },
      });
    const recover = vi.fn().mockResolvedValue({
      vision: { references: [{ ref: 'grounded-container', kind: 'object' }] },
    });
    const result = await groundPrimitive(request, observe, recover);
    expect(recover).toHaveBeenCalledExactlyOnceWith('bin', 'destination');
    expect(result.params.destination).toMatchObject({
      ref: 'grounded-container',
      cell_ref: 'cell',
    });
  });
  it('uses fresh visual instances and grid evidence without a planning model or configured assets', async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce({
        collection: {
          instances: [
            { ref: 'current-part', score: 0.8 },
            { ref: 'other-part', score: 0.6 },
          ],
        },
      })
      .mockResolvedValueOnce({
        collection: { instances: [{ ref: 'current-bin', score: 0.9 }] },
      })
      .mockResolvedValueOnce({
        geometry: {
          kind: 'grid',
          cells: [
            { ref: 'occupied', occupancy: 'occupied' },
            { ref: 'unknown', occupancy: 'unknown' },
            { ref: 'empty-cell', occupancy: 'empty' },
          ],
        },
      });
    const result = await groundPrimitive(request, observe);
    expect(result.params.target).toEqual({
      label: 'metal cylinder',
      ref: 'current-part',
    });
    expect(result.params.destination).toEqual({
      label: 'bin',
      ref: 'current-bin',
      selection: 'free_space',
      cell_ref: 'empty-cell',
    });
    expect(needsPrimitiveGrounding(result)).toBe(false);
    expect(needsPrimitiveGrounding(request)).toBe(true);
    expect(observe).toHaveBeenCalledTimes(3);
  });
  it('tries another permitted container when the first grid is full', async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce({ collection: { instances: [{ ref: 'part' }] } })
      .mockResolvedValueOnce({
        collection: {
          instances: [
            { ref: 'full-bin', score: 0.9 },
            { ref: 'free-bin', score: 0.8 },
          ],
        },
      })
      .mockResolvedValueOnce({
        geometry: { kind: 'grid', cells: [{ ref: 'busy', occupancy: 'occupied' }] },
      })
      .mockResolvedValueOnce({
        geometry: { kind: 'grid', cells: [{ ref: 'free', occupancy: 'empty' }] },
      });
    const result = await groundPrimitive(request, observe);
    expect(result.params.destination).toMatchObject({
      ref: 'free-bin',
      cell_ref: 'free',
    });
  });
  it('preserves an explicitly selected object and destination instead of choosing another', async () => {
    const explicit = {
      ...request,
      params: {
        target: { ref: 'explicit-object' },
        destination: { cell_ref: 'explicit-cell' },
      },
    };
    const observe = vi.fn();
    expect(await groundPrimitive(explicit, observe)).toEqual(explicit);
    expect(observe).not.toHaveBeenCalled();
  });
  it('keeps ordinary free-space placement if the geometry is not a grid', async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce({ collection: { instances: [{ ref: 'part' }] } })
      .mockResolvedValueOnce({ collection: { instances: [{ ref: 'plate' }] } })
      .mockResolvedValueOnce({ geometry: { kind: 'unknown' } });
    expect((await groundPrimitive(request, observe)).params.destination).toMatchObject({
      ref: 'plate',
      selection: 'free_space',
    });
  });
  it('does not manufacture a reference when the detector finds no object', async () => {
    const observe = vi.fn().mockResolvedValue({ collection: { instances: [] } });
    await expect(groundPrimitive(request, observe)).rejects.toThrow('未下发机械动作');
  });
  it('turns a model box into same-snapshot SAM2 grounding before manipulation', async () => {
    const boxed: Action = {
      title: '抓取框选零件',
      skill: 'grasp',
      review_after: false,
      params: {
        target: {
          label: 'unknown metal part',
          grounding: {
            snapshot_ref: 'a'.repeat(32),
            camera: 'scene_camera',
            box_2d: [100, 200, 500, 700],
          },
        },
      },
    };
    const observe = vi.fn().mockResolvedValue({
      vision: {
        references: [
          { ref: 'grounded-part', kind: 'object', semantic_status: 'candidate' },
        ],
      },
    });
    const result = await groundPrimitive(boxed, observe);
    expect(observe).toHaveBeenCalledWith({
      scope: 'target',
      category: 'unknown metal part',
      selection: 'one',
      grounding: {
        snapshot_ref: 'a'.repeat(32),
        camera: 'scene_camera',
        box_normalized: [0.2, 0.1, 0.7, 0.5],
      },
    });
    expect(result.params.target).toEqual({
      label: 'unknown metal part',
      ref: 'grounded-part',
    });
    expect(needsPrimitiveGrounding(result)).toBe(false);
  });
});
