// Real feedback LLM with synthetic controller facts. No controller or audio writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { DialogueAgent } from '../dist/modules/dialogue/dialogue-agent.js';
import { ConversationHub } from '../dist/modules/conversation/conversation-hub.js';
import { ConversationInterruptions } from '../dist/modules/conversation/conversation-interruptions.js';
import { HostConfig } from '../dist/config/host-config.js';
import { parseInstruction } from '../dist/apps/desktop-robot/instruction-agent.js';

const host = HostConfig.fromEnv({ ...process.env, ...dotenv.parse(readFileSync('.env')) });
const scenarios = [
  { input: '找黄色螺栓', event: 'clarification.requested', payload: { question: '未获得确定的感知结果：当前相机未获得黄色螺栓的新鲜检测，不能确认存在。', reason: 'GROUNDING_UNAVAILABLE' }, check: text => /未|没|无法|不能/.test(text) && !/已找到|已定位|正在靠近|正在移动|正在重新|重试中/.test(text) },
  { input: '找黄色螺栓', event: 'observation.ready', payload: { message: '检测到1个黄色螺栓，位于工作台中央。' }, check: text => /黄色螺栓/.test(text) && !/正在靠近|正在移动/.test(text) },
  { input: '机械臂归位', event: 'execution.started', payload: { message: '控制器已开始执行home，尚未到位。' }, check: text => /复位|归位|初始/.test(text) && !/已到位|复位完成/.test(text) },
  { input: '机械臂归位', event: 'execution.completed', payload: { message: '动作完成，实测关节已到位并停稳' }, check: text => /已|完成/.test(text) && /复位|归位|初始/.test(text) },
  { input: '底座顺时针旋转180度', event: 'execution.failed', payload: { message: 'JOINT_LIMIT：shoulder_pan目标超出[-110,110]度；未执行运动。' }, check: text => /未|没|无法|不能|超出/.test(text) && !/已转动|正在转动|已经转/.test(text) },
  { input: '机械臂归位', event: 'execution.unknown', payload: { message: '控制端未确认执行结果。' }, check: text => /未|无法|不能|不确定|未知/.test(text) && !/复位完成|已到位|已执行|正在复位/.test(text) },
];
for (const scenario of scenarios) {
  const hub = new ConversationHub();
  const tts = { startTurn() {}, append() {}, async finishTurn() {}, cancel() {}, interrupt() {} };
  const agent = new DialogueAgent(host, hub, tts, new ConversationInterruptions(hub));
  const id = `feedback-model-${randomUUID()}`;
  let resolveReply, timer;
  const response = new Promise((resolve, reject) => { resolveReply = resolve; timer = setTimeout(() => reject(new Error('Feedback timeout')), 12000); });
  const context = (eventType, payload) => ({
    event: { eventId: randomUUID(), eventType, correlationId: id, taskId: id, taskVersion: 1, payload },
    agentConfig: { config: { parallel_interaction: true, model: 'qwen-flash', reasoning: 'none' } },
    publish: async event => { if (event.event_type === 'reply.created') resolveReply(event.payload.text); },
  });
  try {
    await agent.handle(context('instruction.parsed', parseInstruction(scenario.input)));
    const start = Date.now();
    await agent.handle(context(scenario.event, scenario.payload));
    const text = await response;
    console.log(JSON.stringify({ event: scenario.event, input: scenario.input, reply: text, total_ms: Date.now() - start }));
    assert.ok(scenario.check(text), `Feedback contradicts fixture: ${text}`);
  } finally { clearTimeout(timer); agent.onModuleDestroy(); }
}
console.log('REAL FEEDBACK MODEL PASSED (synthetic facts, no motion)');
