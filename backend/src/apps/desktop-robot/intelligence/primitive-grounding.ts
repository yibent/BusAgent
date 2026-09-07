import type { Action } from './types.js';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function observedCandidates(packet: Record<string, unknown>) {
  if (packet.ok === false) return [];
  const vision = object(packet.vision ?? packet);
  const collection = object(packet.collection ?? vision.collection);
  const rows = Array.isArray(collection.instances)
    ? collection.instances
    : Array.isArray(vision.references)
      ? vision.references
      : [];
  return rows
    .map(object)
    .filter(
      (row) =>
        typeof row.ref === 'string' &&
        row.semantic_status !== 'unknown' &&
        (row.kind === undefined || row.kind === 'object'),
    );
}

export const needsPrimitiveGrounding = (action: Action) =>
  ['grasp', 'pick_place', 'place_held'].includes(action.skill) &&
  (object(action.params.target).selection === 'any' ||
    object(action.params.destination).instance_selection === 'any');

/** Resolve user-permitted choices immediately before dispatch. No LLM or asset
 * catalogue is involved; explicit refs, cells and orientation are preserved. */
export async function groundPrimitive(
  action: Action,
  observe: (params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  recover?: (
    label: string,
    field: 'target' | 'destination',
  ) => Promise<Record<string, unknown>>,
  remembered: unknown[] = [],
): Promise<Action> {
  const result = structuredClone(action);
  for (const field of ['target', 'destination'] as const) {
    const choice = object(result.params[field]);
    const permitted =
      field === 'target'
        ? choice.selection === 'any'
        : choice.instance_selection === 'any';
    if (!permitted || choice.ref || choice.cell_ref || choice.region_ref) continue;
    if (typeof choice.label !== 'string' || !choice.label.trim())
      throw new Error('任选目标仍需指定视觉类别。');
    const packet = await observe({
      scope: 'target',
      category: choice.label,
      selection: 'all',
      vision_mode: 'auto',
    });
    // Instance collections already merge views of the same physical object.
    let candidates = observedCandidates(packet);
    if (!candidates.length) {
      // Recall learned visual identity, then re-localize it in a fresh frame.
      // A remembered/stale box is never sent directly to physical execution.
      for (const known of remembered.map(object)) {
        const labels = [
          known.label,
          ...(Array.isArray(known.labels) ? (known.labels as unknown[]) : []),
        ];
        if (!labels.includes(choice.label) || typeof known.ref !== 'string') continue;
        const current = await observe({
          ref: known.ref,
          selection: 'one',
          vision_mode: 'auto',
        });
        candidates.push(...observedCandidates(current));
      }
    }
    if (!candidates.length && recover)
      candidates = observedCandidates(await recover(choice.label, field));
    candidates.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
    const selected = candidates[0];
    if (!selected)
      throw new Error(`本次观察未定位到可选择的 ${choice.label}；未下发机械动作。`);
    const bound: Record<string, unknown> = { ...choice, ref: selected.ref };
    if (field === 'target') {
      delete bound.selection;
    }
    delete bound.instance_selection;
    result.params[field] = bound;
    if (
      field !== 'destination' ||
      choice.selection !== 'free_space' ||
      result.params.orientation
    )
      continue;
    // A gridded tray needs a cell interior, not the rim's planar free surface.
    // The geometry node can decline grid recognition; ordinary trays then keep
    // their free-space destination and are handled by the existing controller.
    let found = false;
    for (const candidate of candidates) {
      const inspected = await observe({
        ref: candidate.ref,
        inspect: 'grid',
        selection: 'one',
      });
      const grid = object(inspected.geometry ?? object(inspected.vision).geometry);
      if (grid.kind !== 'grid' || !Array.isArray(grid.cells)) {
        result.params.destination = { ...bound, ref: candidate.ref };
        found = true;
        break;
      }
      const cell = grid.cells
        .map(object)
        .find((row) => row.occupancy === 'empty' && typeof row.ref === 'string');
      if (!cell) continue; // A full tray does not exhaust the user's allowed destinations.
      result.params.destination = { ...bound, ref: candidate.ref, cell_ref: cell.ref };
      found = true;
      break;
    }
    if (!found)
      throw new Error(
        '允许选择的容器中尚未观测到空格位，需要重新观察或整理；未下发机械动作。',
      );
  }
  return result;
}
