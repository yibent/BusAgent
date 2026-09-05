// Read-only model check: this script never calls the robot controller.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HostConfig } from '../dist/config/host-config.js';
import {
  semanticFrame,
  understandSemantic,
} from '../dist/apps/desktop-robot/semantic-understanding.js';
const host = HostConfig.fromEnv();
const app = JSON.parse(readFileSync(host.appFile, 'utf8'));
const config = app.agents.find(
  (agent) => agent.agent_id === 'robot.instruction_understanding',
)?.config;
const { model, reasoning } = config;
assert.equal(reasoning, 'low');
assert.equal(
  typeof model,
  'string',
  'Must test the configured production semantic model',
);
console.log(JSON.stringify({ model, reasoning, mode: 'read-only' }));
let passed = 0;
async function understand(text, history) {
  const start = Date.now();
  const parsed = await understandSemantic(
    host,
    text,
    history,
    undefined,
    model,
    reasoning,
  );
  console.log(JSON.stringify({ model, text, elapsed_ms: Date.now() - start, parsed }));
  return parsed;
}
const history = [];
for (const [text, intent, skill] of [
  ['把机械臂复位', 'motion', 'home'],
  ['让它回到最开始那个姿势', 'motion', 'home'],
  ['先把手张开', 'motion', 'gripper'],
  ['看一下有没有黄色螺栓', 'find'],
  ['让夹爪去刚才那个东西上面十公分处', 'motion', 'move_cartesian'],
  ['好，现在向上挪五毫米', 'motion', 'move_cartesian'],
  ['场景里是否存在紫色五角星', 'find'],
]) {
  const parsed = await understand(text, history);
  assert.equal(parsed.intent, intent);
  assert.equal(parsed.needs_clarification, false);
  if (skill) assert.equal(parsed.motion?.skill, skill);
  if (text.includes('刚才')) {
    assert.equal(parsed.target.category, 'bolt');
    assert.equal(parsed.target.attributes.color, 'yellow');
    assert.deepEqual(parsed.object_goal?.offset_m, [0, 0, 0.1]);
  }
  if (text.includes('五毫米'))
    assert.deepEqual(parsed.motion.params.xyz_m, [0, 0, 0.005]);
  history.push(parsed);
  passed++;
}
// Include stale, wrong historical interpretation to ensure a fresh full instruction wins.
const stale = [
  semanticFrame(
    { intent: 'rotate', axis: 'z', degrees: 90, frame: 'base' },
    '底座旋转九十度',
  ),
];
const corrections = [
  ['呃，现在把底座顺时针。逆时针吧，逆时针旋转九十度。', -90],
  ['嗯，把底座逆时针去。顺时针旋转九十度。', 90],
];
for (const context of [[], stale, history.slice(-6)]) {
  for (const [text, degrees] of corrections) {
    const parsed = await understand(text, context);
    assert.equal(parsed.needs_clarification, false);
    assert.deepEqual(parsed.motion, {
      skill: 'move_joint',
      params: { joint: 'shoulder_pan', degrees, absolute: false },
    });
    passed++;
  }
}
for (const [text, expected] of [
  [
    '底座逆时针转三十度，不要顺时针',
    {
      skill: 'move_joint',
      params: { joint: 'shoulder_pan', degrees: -30, absolute: false },
    },
  ],
  [
    '末端绕基座坐标系Z轴顺时针旋转九十度',
    { skill: 'rotate', params: { axis: 'z', degrees: -90, frame: 'base' } },
  ],
  [
    '腕部顺时针转二十度',
    {
      skill: 'move_joint',
      params: { joint: 'wrist_roll', degrees: -20, absolute: false },
    },
  ],
  [
    '底座转到零度',
    {
      skill: 'move_joint',
      params: { joint: 'shoulder_pan', degrees: 0, absolute: true },
    },
  ],
]) {
  const parsed = await understand(text, stale);
  assert.equal(parsed.needs_clarification, false);
  assert.deepEqual(parsed.motion, expected);
  passed++;
}
const correctedGoal = await understand('移到黄色螺栓上方十厘米，不，五厘米', []);
assert.equal(correctedGoal.needs_clarification, false);
assert.deepEqual(correctedGoal.object_goal?.offset_m, [0, 0, 0.05]);
assert.equal(correctedGoal.motion?.params.xyz_m, undefined);
passed++;
const followup = await understand('改成顺时针，四十五度', [
  semanticFrame(
    { intent: 'move_joint', joint: 'shoulder_pan', degrees: -90 },
    corrections[0][0],
  ),
]);
assert.equal(followup.needs_clarification, false);
assert.deepEqual(followup.motion, {
  skill: 'move_joint',
  params: { joint: 'shoulder_pan', degrees: 45, absolute: false },
});
passed++;
const ambiguous = await understand('把机械臂旋转九十度', []);
assert.equal(ambiguous.needs_clarification, true);
passed++;
console.log(`LIVE SEMANTIC CHECK PASSED: ${passed} cases, model=${model}`);
