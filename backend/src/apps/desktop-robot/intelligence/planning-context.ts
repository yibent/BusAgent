import { semanticEvidence, type Decision, type Goal } from './types.js';
const text = (x: unknown) => (typeof x === 'string' ? x : '');
const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const pick = (row: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));

function collection(value: unknown): unknown {
  const row = object(value);
  return {
    ...pick(row, [
      'label',
      'count',
      'complete',
      'count_basis',
      'grouping',
      'unlocalized_count',
      'observed_at',
      'observation_ref',
      'groups',
    ]),
    instances: (Array.isArray(row.instances) ? row.instances : []).map((raw) =>
      pick(object(raw), [
        'ref',
        'track_id',
        'score',
        'semantic_status',
        'position_m',
        'extent_m',
        'camera',
        'box_normalized',
      ]),
    ),
  };
}

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
    'collection',
    'geometry',
  ]);
  // A box/ref must appear once per observation, not in references, candidates,
  // views and again in every past execution result.
  const hasReferences = Array.isArray(row.references) && row.references.length > 0;
  if (hasReferences) summary.references = row.references;
  if (row.collection) {
    summary.collection = collection(row.collection);
    delete summary.references;
  }
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
        ...(hasReferences ? [] : ['objects', 'regions', 'candidates']),
      ]),
    );
  return summary;
}

/** Small control facts that must survive native history trimming at every step. */
export function executionBrief(goal: Goal, live: Record<string, unknown>) {
  const pending = goal.steps.filter((s) => s.state === 'pending');
  const holding = object(live.holding);
  return {
    goal_id: goal.id,
    continuation: goal.steps.length > 0,
    holding: {
      verified: typeof holding.verified === 'boolean' ? holding.verified : null,
      object_id: text(holding.object_id).slice(0, 128) || undefined,
      label: text(holding.label).slice(0, 96) || undefined,
    },
    failed: goal.steps
      .filter((s) => s.state === 'failed')
      .slice(-2)
      .map((s) => {
        const wrapper = object(s.result);
        const result = object(wrapper.result ?? wrapper);
        return {
          id: s.id,
          skill: s.skill,
          failure: pick(object(result.failure), ['code', 'phase']),
        };
      }),
    pending: pending.slice(0, 8).map((s) => ({ id: s.id, skill: s.skill })),
    pending_count: pending.length,
    completed_count: goal.steps.filter((s) => s.state === 'completed').length,
  };
}

export function planningGoal(goal: Goal): unknown {
  const active = goal.steps.filter((s) =>
    ['pending', 'running', 'dispatching', 'unknown', 'failed'].includes(s.state),
  );
  const recent = goal.steps.filter((s) => s.state === 'completed').slice(-3);
  const selected = [...new Set([...recent, ...active.slice(0, 8)])];
  return {
    ...(planningEvidence({
      id: goal.id,
      state: goal.state,
      revision: goal.revision,
      mode: goal.mode,
      plan_scope: goal.plan_scope,
      review_kind: goal.review_kind,
      checks: goal.checks,
      final_review: goal.final_review,
      review_reason: goal.review_reason,
      recovery_count: goal.recovery_count,
      skipped_targets: goal.skipped_targets,
      steps: selected.map((step) => {
        const wrapper = object(step.result);
        const result = object(wrapper.result ?? wrapper);
        return {
          id: step.id,
          title: step.title,
          skill: step.skill,
          execution: step.execution,
          attempt: step.attempt,
          state: step.state,
          params: step.state === 'completed' ? undefined : step.params,
          command_id: step.command_id,
          result: pick(result, [
            'ok',
            'state',
            'failure',
            'holding',
            'evaluation',
            'postconditions',
            'review_required',
            'review_reason',
            'command_id',
            'elapsed_s',
            'physical_attempted',
          ]),
          result_message: text(result.message).slice(0, 400),
          observation_ref: object(result.vision).request_id,
        };
      }),
      omitted_step_count: Math.max(0, goal.steps.length - selected.length),
      completed_step_count: goal.steps.filter((step) => step.state === 'completed')
        .length,
    }) as Record<string, unknown>),
    // Never truncate/compact user constraints through semanticEvidence's generic string limit.
    source: goal.source,
    summary: goal.summary,
    completion: goal.completion,
  };
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
        if (key === 'collection') return [[key, collection(v)]];
        if (key === 'world') {
          const world = object(v);
          return [
            [
              key,
              {
                ...pick(world, ['revision', 'complete', 'source', 'stale_means']),
                objects: (Array.isArray(world.objects) ? world.objects : []).map(
                  (raw) =>
                    pick(object(raw), [
                      'track_id',
                      'ref',
                      'label',
                      'labels',
                      'references',
                      'current',
                      'state',
                      'association_candidates',
                      'position_m',
                      'extent_m',
                      'placement',
                      'observation_ref',
                      'observed_at',
                    ]),
                ),
                collections: (Array.isArray(world.collections)
                  ? world.collections
                  : []
                ).map((raw) => {
                  const c = object(raw);
                  return Array.isArray(world.objects)
                    ? {
                        ...pick(c, [
                          'label',
                          'count',
                          'complete',
                          'observed_at',
                          'observation_ref',
                          'groups',
                        ]),
                        members: (Array.isArray(c.instances) ? c.instances : []).map(
                          (i) => object(i).track_id,
                        ),
                      }
                    : collection(c);
                }),
              },
            ],
          ];
        }
        if (key === 'vision' && object(x).collection)
          return [
            [
              key,
              pick(object(v), ['request_id', 'label', 'observed_at', 'ok', 'scope']),
            ],
          ];
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
          // Historical observations identify available evidence; the current
          // observation/world carries the actual candidate list.
          return [
            [
              key,
              [...byTarget.values()]
                .slice(-8)
                .map((raw) =>
                  pick(object(raw), [
                    'request_id',
                    'label',
                    'scope',
                    'observed_at',
                    'ok',
                    'error',
                    'semantic_status',
                  ]),
                ),
            ],
          ];
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
    for (const [field, ref] of Object.entries({
      ref: params.ref,
      'target.ref': object(params.target).ref,
      'destination.ref': destination.ref,
      'destination.region_ref': destination.region_ref,
      'destination.cell_ref': destination.cell_ref,
      'orientation.axis_ref': object(params.orientation).axis_ref,
    })) {
      const stableCell =
        field === 'destination.cell_ref' &&
        typeof ref === 'string' &&
        /^grid:[a-f0-9]{32}:\d+:\d+$/.test(ref);
      if (
        ref !== undefined &&
        !stableCell &&
        (typeof ref !== 'string' || !pattern.test(ref))
      ) {
        throw new Error(
          `${field}=${JSON.stringify(ref)}：视觉 ref 必须完整复制 references/visual_candidates 中的 ref（含相机与序号）；格位也接受实际cell_id。request_id/result_ref不能当作对象引用。普通托盘找空位可用label+selection=free_space。`,
        );
      }
    }
  }
}
