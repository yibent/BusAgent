// Read-only production smoke test: plans from the current scene but never dispatches actions.
import { readFile } from 'node:fs/promises';
import { runStagedPlanning } from '../dist/apps/desktop-robot/intelligence/staged-planning.js';
import { observeScene } from '../dist/apps/desktop-robot/intelligence/observation-tools.js';
const settings = JSON.parse(await readFile('.local/intelligence.json', 'utf8'));
const resolveProfiles = role => {
  const primary = settings.roles[role] || settings.roles.planner;
  const policy = settings.fallbackPolicies?.[role] || (role === 'task' ? 'ordered_compatible' : 'same_capability');
  const ids = [primary, ...(policy === 'disabled' ? [] : (settings.fallbacks[role] || settings.fallbacks.planner || []))];
  const primaryProfile = settings.profiles.find(item => item.id === primary);
  return ids.flatMap(id => {
    const profile = settings.profiles.find(item => item.id === id && item.enabled && item.apiKey);
    const boxGrounding = profile?.boxGrounding ?? (profile?.provider === 'gemini' && profile?.vision);
    if (!profile || (policy === 'same_capability' &&
      (profile.vision !== primaryProfile?.vision || (primaryProfile?.boxGrounding && !boxGrounding)))) return [];
    const firstTokenTimeoutMs = settings.nodeFirstTokenTimeouts?.[role] || profile.firstTokenTimeoutMs ||
      (profile.vision && ['planner','supervisor','visual'].includes(role) ? 30000 : (settings.performance.firstTokenTimeoutMs || 8000));
    return profile ? [{
      ...profile,
      boxGrounding,
      timeoutMs: Math.max(firstTokenTimeoutMs, settings.nodeTimeouts?.[role] || profile.timeoutMs || settings.performance.requestTimeoutMs),
      firstTokenTimeoutMs,
      cooldownEnabled: false,
    }] : [];
  });
};
const source = process.argv.slice(2).join(' ') || '帮我收拾桌面，把零件按类别放到合适的料箱';
const goal = {
  id: 'planner-smoke', conversation_id: 'planner-smoke', input_event_id: 'planner-smoke',
  source, interaction: true, state: 'planning', mode: 'simple', summary: '', completion: '',
  steps: [], message: '', review_reason: '', recovery_count: 0,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), model_calls: 0, revision: 1,
};
const live = await (await fetch('http://127.0.0.1:7861/api/status')).json();
const events = [];
const result = await runStagedPlanning({
  settings,
  taskProfiles: resolveProfiles('task'),
  plannerProfiles: resolveProfiles('planner'),
  goal,
  queue: { revision: 0, paused: false, goals: [], scene: {}, receipts: [] },
  live,
  readImage: async () => {
    const snapshot = await (await fetch('http://127.0.0.1:7861/api/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camera: 'scene' }),
    })).json();
    const response = await fetch(`http://127.0.0.1:7861/api/observations/${snapshot.snapshot_ref}/frame/scene`);
    return { bytes: Buffer.from(await response.arrayBuffer()), metadata: snapshot };
  },
  observeScene: signal => observeScene('http://127.0.0.1:7861', {
    scope: 'scene', scene_mode: 'auto', cameras: ['scene_camera', 'side_camera'],
  }, 'planner-smoke', signal),
  record: async event => { events.push(event); },
}, AbortSignal.timeout(settings.performance.planningBudgetMs || 90000));
console.log(JSON.stringify({
  source,
  mode: result.mode,
  action_count: result.actions.length,
  actions: result.actions.map(action => ({
    stage: action.stage,
    skill: action.skill,
    target: action.params.target,
    destination: action.params.destination,
    loop: action.execution?.loop,
    supervision: action.execution?.supervision,
  })),
  model_events: events.filter(event => event.kind === 'model').map(event => ({
    role: event.role, model: event.model, elapsed_ms: event.elapsed_ms, first_token_ms: event.first_token_ms,
  })),
  provider_failures: events.filter(event => event.kind === 'provider_failure').map(event => ({
    model: event.model, reason: event.reason,
  })),
}, null, 2));
