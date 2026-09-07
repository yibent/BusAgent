// Offline payload replay. Both model functions are stubs: no API or robot commands.
// Run after build: node scripts/benchmark-intelligence-context.mjs <Q8 repair.json> <output.json>
import { readFile, writeFile, mkdtemp, symlink, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { planGoal as currentPlan } from '../dist/apps/desktop-robot/intelligence/planning.js';
import { inferenceSize } from '../dist/apps/desktop-robot/intelligence/context-window.js';

const input = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const fixture = JSON.parse(await readFile(input, 'utf8'));
const goal = fixture.goal;
const rows = goal.steps.flatMap((s) => (s.result ? [s.result.result ?? s.result] : []));
const observed = rows.filter((r) => r.vision?.references?.length);
if (!observed.length) throw new Error('Fixture has no observed evidence');
const live = {
  available: true,
  runtime_id: 'offline-fixture',
  phase: 'idle',
  holding: rows.at(-1)?.holding ?? { verified: false },
  capabilities: { skills: ['perceive', 'grasp', 'place_held', 'pick_place'] },
  observation: observed.at(-1).vision,
  recent_observations: observed.map((r) => r.vision),
};
const profile = {
  id: 'offline',
  name: 'Offline stub',
  provider: 'openai-compatible',
  model: 'stub',
  baseUrl: 'http://unused.invalid/v1',
  apiKey: 'unused',
  vision: false,
  enabled: true,
  thinking: false,
};
const temporary = await mkdtemp(resolve('.context-benchmark-'));
const baseline = execFileSync('git', ['rev-parse', process.argv[4] ?? 'c0ed3e7'], {
  encoding: 'utf8',
}).trim();
try {
  for (const name of ['planning', 'planning-context']) {
    const source = execFileSync(
      'git',
      ['show', `${baseline}:backend/src/apps/desktop-robot/intelligence/${name}.ts`],
      { encoding: 'utf8' },
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    await writeFile(join(temporary, `${name}.js`), compiled.outputText);
  }
  for (const name of [
    'model-routing',
    'model-client',
    'model-config',
    'types',
    'visual-grounding',
  ])
    await symlink(
      resolve(`dist/apps/desktop-robot/intelligence/${name}.js`),
      join(temporary, `${name}.js`),
    );
  const { planGoal: previousPlan } = await import(
    pathToFileURL(join(temporary, 'planning.js')).href
  );
  const comparison = [];
  for (const role of ['planner', 'supervisor']) {
    for (const [version, plan] of [
      ['before', previousPlan],
      ['after', currentPlan],
    ]) {
      const requests = [];
      const events = [];
      let callIndex = 0,
        observedIndex = 0;
      const call = async (_profile, messages, tools) => {
        requests.push(inferenceSize(messages, tools));
        const observing = callIndex++ < 8;
        const name = observing
          ? 'observe_objects'
          : version === 'after' && role === 'supervisor'
            ? 'submit_review'
            : 'submit_plan';
        const actions = [
          {
            title: '继续观察',
            skill: 'perceive',
            params: { category: 'part' },
            review_after: true,
          },
        ];
        const args = observing
          ? { category: 'part' }
          : name === 'submit_review'
            ? {
                verdict: 'repair',
                reason: '离线协议测试',
                evidence_refs: [],
                actions,
                plan_scope: 'stage',
              }
            : {
                mode: 'complex',
                summary: '离线协议测试',
                completion: goal.completion,
                outcome: 'continue',
                message: '',
                actions,
                plan_scope: 'stage',
              };
        return {
          model: 'offline-stub',
          elapsed_ms: 0,
          usage: {},
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `call-${callIndex}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        };
      };
      await plan(
        profile,
        role,
        structuredClone(goal),
        { revision: 1, paused: false, goals: [goal], scene: {}, receipts: [] },
        {
          images: false,
          toolRounds: 8,
          readState: async () => structuredClone(live),
          readImage: async () => {
            throw new Error('Images disabled in offline replay');
          },
          observe: async () => ({
            ...structuredClone(observed[observedIndex++ % observed.length]),
            replay_observation: observedIndex,
          }),
          record: async (event) => {
            events.push(event);
          },
        },
        new AbortController().signal,
        call,
      );
      const totals = requests.map(
        (r) => r.text_tokens + r.tool_tokens + r.image_reserve_tokens,
      );
      comparison.push({
        role,
        version,
        inference_calls: requests.length,
        estimated_input_total: totals.reduce((a, b) => a + b, 0),
        estimated_input_peak: Math.max(...totals),
        estimated_input_by_call: totals,
        compaction_rounds: events
          .filter((e) => e.kind === 'context_budget')
          .reduce((n, e) => n + e.compacted_rounds, 0),
      });
    }
  }
  const report = {
    kind: 'offline_payload_replay',
    baseline_commit: baseline,
    fixture: input,
    api_calls: 0,
    robot_commands: 0,
    budget_tokens: 12000,
    comparison,
    limitation:
      '同一Q8证据的固定工具序列，估算输入量；不代表模型决策质量、实测API计费或端到端成功率。',
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
