import { semanticEvidence, type Decision } from './types.js';
const text = (x: unknown) => (typeof x === 'string' ? x : '');
const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const pick = (row: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));

/** Keep all same-frame instances; discard older views of the same category. */
export function latestReferences(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const latest = new Map<string, unknown>();
  for (const raw of value) {
    const row = object(raw);
    const key = `${text(row.label)}:${text(row.camera)}`;
    const group = text(row.ref).split(':').slice(0, 3).join(':');
    latest.set(key, group);
  }
  return value
    .filter((raw) => {
      const row = object(raw);
      return (
        latest.get(`${text(row.label)}:${text(row.camera)}`) ===
        text(row.ref).split(':').slice(0, 3).join(':')
      );
    })
    .slice(-64);
}
function observation(value: unknown): unknown {
  const row = object(value);
  const summary = pick(row, [
    'request_id',
    'label',
    'scope',
    'observed_at',
    'elapsed_s',
    'ok',
    'error',
    'loop',
    'semantic_status',
    'fallback_reasons',
    'references',
  ]);
  if (Array.isArray(row.views))
    summary.views = row.views.map((v) =>
      pick(object(v), [
        'camera',
        'label',
        'status',
        'semantic_status',
        'origin',
        'score',
        'score_model',
        'box',
        'ref',
        'loop',
        'fallback_reason',
        'objects',
        'regions',
        'candidates',
      ]),
    );
  return summary;
}

/** The full evidence stays in Bus/MySQL. LLMs receive the facts needed to decide. */
export function planningEvidence(value: unknown): unknown {
  const visit = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(visit);
    if (!x || typeof x !== 'object') return x;
    return Object.fromEntries(
      Object.entries(object(x)).flatMap(([key, v]) => {
        if (key === 'physical_witness' || key === 'stages' || key === 'memory_id')
          return [];
        if (key === 'visual_candidates') return [[key, latestReferences(v)]];
        if (key === 'vision' || key === 'observation') return [[key, observation(v)]];
        if (key === 'recent_observations') {
          const byTarget = new Map<string, unknown>();
          for (const raw of Array.isArray(v) ? v : []) {
            const row = object(raw);
            const label = text(row.label) || text(row.scope) || 'scene';
            byTarget.delete(label);
            byTarget.set(label, observation(row));
          }
          return [[key, [...byTarget.values()].slice(-8)]];
        }
        return [[key, visit(v)]];
      }),
    );
  };
  return visit(semanticEvidence(value));
}

export function validateVisualReferences(decision: Decision): void {
  const pattern = /^obs:[a-f0-9]{32}:(scene_camera|side_camera|wrist_camera):\d+$/;
  for (const action of decision.actions) {
    const params = action.params;
    const destination = object(params.destination);
    for (const ref of [
      params.ref,
      object(params.target).ref,
      destination.ref,
      destination.region_ref,
    ]) {
      if (ref !== undefined && (typeof ref !== 'string' || !pattern.test(ref))) {
        throw new Error(
          '视觉 ref 必须完整复制 references/visual_candidates 中的 ref（含相机与序号）；request_id/result_ref 不能当作对象或区域引用。普通命名托盘找空位只需 label + selection=free_space，不需要 region_ref。',
        );
      }
    }
  }
}
