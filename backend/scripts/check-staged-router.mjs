// Read-only production smoke test: calls only the fast task model and never the robot.
import { readFile } from 'node:fs/promises';
import { routeTask } from '../dist/apps/desktop-robot/intelligence/staged-planning.js';
const settings = JSON.parse(await readFile('.local/intelligence.json', 'utf8'));
const taskId = settings.roles.task || settings.roles.planner;
const fallbackPolicy = settings.fallbackPolicies?.task || 'ordered_compatible';
const ids = [taskId, ...(fallbackPolicy === 'disabled' ? [] : (settings.fallbacks.task || settings.fallbacks.planner || []))];
const profiles = ids.flatMap(id => {
  const profile = settings.profiles.find(item => item.id === id && item.enabled && item.apiKey);
  return profile ? [{
    ...profile,
    timeoutMs: settings.nodeTimeouts?.task || profile.timeoutMs || settings.performance.requestTimeoutMs,
    firstTokenTimeoutMs: settings.nodeFirstTokenTimeouts?.task || profile.firstTokenTimeoutMs || settings.performance.firstTokenTimeoutMs || 8000,
    cooldownEnabled: false,
  }] : [];
});
if (!profiles.length) throw new Error('No configured task profile');
const source = process.argv.slice(2).join(' ') || '把红色方块放到黄色托盘';
const events = [];
const result = await routeTask({
  settings,
  taskProfiles: profiles,
  plannerProfiles: [],
  goal: {
    id: 'router-smoke', conversation_id: 'router-smoke', input_event_id: 'router-smoke',
    source, interaction: true, state: 'planning', mode: 'simple', summary: '', completion: '',
    steps: [], message: '', review_reason: '', recovery_count: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), model_calls: 0, revision: 1,
  },
  queue: { revision: 0, paused: false, goals: [], scene: {}, receipts: [] },
  live: { holding: { verified: false }, capabilities: { skills: ['pick_place', 'grasp', 'place_held', 'home', 'perceive'] } },
  readImage: async () => { throw new Error('router must not read images'); },
  observeScene: async () => { throw new Error('router must not observe the scene'); },
  record: async event => { events.push(event); },
}, AbortSignal.timeout(settings.performance.planningBudgetMs || 60000));
console.log(JSON.stringify({
  source,
  disposition: result.disposition,
  summary: result.summary,
  action_count: result.actions.length,
  actions: result.actions.map(action => ({ skill: action.skill, loop: action.execution?.loop })),
  model_calls: events.filter(event => event.kind === 'model').length,
}, null, 2));
