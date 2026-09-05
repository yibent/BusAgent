// Real LLM, synthetic task/status events. Does not connect to the robot or play audio.
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
const hub = new ConversationHub();
const agent = new DialogueAgent(host, hub, { startTurn() {}, append() {}, async finishTurn() {}, cancel() {}, interrupt() {} }, new ConversationInterruptions(hub));
const conversation = `busy-memory-${randomUUID()}`;
const realFetch = globalThis.fetch;
let motion = { mode: 'moving', active_command_id: 'grip-command', simulation_playing: true, last_command: { skill: 'gripper', state: 'started', message: '夹爪正在张开，尚未确认到位' } };
globalThis.fetch = (url, options) => String(url).startsWith('http://busy-controller.test')
  ? Promise.resolve(Response.json({ motion, capabilities: { skills: ['gripper', 'move_joint', 'home', 'hold'] } })) : realFetch(url, options);
let resolveReply;
const context = (eventType, payload, task = 'grip') => ({
  event: { eventId: eventType === 'intent.created' ? task : randomUUID(), eventType, correlationId: conversation, taskId: `task_${task}`, taskVersion: 1, payload },
  agentConfig: { config: { parallel_interaction: true, model: 'qwen-flash', reasoning: 'none', controller_url: 'http://busy-controller.test' } },
  publish: async event => { if (event.event_type === 'reply.created') resolveReply?.(event.payload.text); },
});
async function reply(eventType, payload, task) {
  let timer;
  const done = new Promise((resolve, reject) => { resolveReply = resolve; timer = setTimeout(() => reject(new Error('Reply timeout')), 12000); });
  try {
    await agent.handle(context(eventType, payload, task));
    const text = await done;
    console.log(JSON.stringify({ event: eventType, reply: text }));
    return text;
  } finally { clearTimeout(timer); resolveReply = undefined; }
}
try {
  const grip = parseInstruction('把爪子张开');
  const base = parseInstruction('底座顺时针旋转90度');
  await agent.handle(context('instruction.parsed', grip));
  await reply('execution.started', { message: '夹爪张开轨迹已开始，尚未到位。' }, 'grip');
  const acknowledgement = await reply('intent.created', { text: '嗯，底座旋转九十度。' }, 'base');
  assert.ok(/等|尚未|还在|未完成/.test(acknowledgement), 'Must remember existing motion');
  assert.ok(!/正在执行底座|正在旋转底座|底座正在旋转|开始旋转底座/.test(acknowledgement), 'New input is not execution evidence');
  await agent.handle(context('instruction.parsed', base, 'base'));
  const queued = await reply('execution.queued', { instruction: base, active_instruction: grip, waiting_for: 'task_grip', queue_position: 1, message: '夹爪仍在张开，底座动作已排队，尚未下发控制器。' }, 'base');
  assert.ok(/等|排队/.test(queued));
  await reply('execution.completed', { message: '夹爪张开完成，实测关节已到位并停稳' }, 'grip');
  const started = await reply('execution.started', { message: '底座旋转轨迹已开始' }, 'base');
  assert.ok(/底座/.test(started) && /开始|正在/.test(started));
  console.log('BUSY TASK MEMORY PASSED (synthetic state, no motion)');
} finally { agent.onModuleDestroy(); globalThis.fetch = realFetch; }
