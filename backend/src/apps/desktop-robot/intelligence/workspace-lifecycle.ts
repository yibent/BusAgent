import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(
  process.env.BUSAGENT_WORKSPACE_ROOT ?? resolve(process.cwd(), '../..'),
);
const journal = resolve(root, 'output/system/workspace.json');
const catalogPath = resolve(root, 'configs/industrial_scenes.json');
const terminal = new Set(['completed', 'failed']);
let submitting = false;

interface Scene {
  id: string;
  name: string;
  description: string;
  kind: string;
  count?: number;
  examples?: string[];
  config: string;
}
interface Operation {
  id: string;
  scene_id: string;
  epoch: string;
  phase: string;
  message: string;
  started_at?: number;
  finished_at?: number;
}
interface Journal {
  epoch: string;
  operation: Operation | null;
}

const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T;

async function scenes(): Promise<Scene[]> {
  return json<Scene[]>(catalogPath);
}

async function activeScene(): Promise<string> {
  try {
    const profile = await json<{ config: string }>(
      resolve(root, 'output/services/arena-scene.json'),
    );
    const config = await json<{ scene?: { id?: string } }>(
      resolve(root, profile.config),
    );
    return config.scene?.id ?? 'sorting';
  } catch {
    return 'sorting';
  }
}

async function readJournal(): Promise<Journal> {
  try {
    return await json<Journal>(journal);
  } catch {
    return { epoch: 'initial', operation: null };
  }
}

async function saveJournal(value: Journal): Promise<void> {
  await mkdir(dirname(journal), { recursive: true, mode: 0o700 });
  const temporary = `${journal}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, journal);
}

export async function workspaceStatus() {
  const state = await readJournal();
  return { ...state, scene_id: await activeScene(), scenes: await scenes() };
}

export async function submitWorkspaceTransition(
  body: { scene_id?: unknown; request_id?: unknown },
) {
  if (submitting) throw new Error('场景切换请求正在提交，请稍候。');
  submitting = true;
  try {
    const sceneId = typeof body.scene_id === 'string' ? body.scene_id : '';
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    if (!/^[a-f0-9-]{32,40}$/.test(requestId)) throw new Error('请求编号无效。');
    const catalog = await scenes();
    if (!catalog.some((scene) => scene.id === sceneId))
      throw new Error('请选择已安装的场景。');
    const previous = await readJournal();
    if (previous.operation?.id === requestId) return workspaceStatus();
    if (previous.operation && !terminal.has(previous.operation.phase))
      throw new Error('另一个场景切换正在进行。');
    const epoch = randomUUID();
    const operation: Operation = {
      id: requestId,
      scene_id: sceneId,
      epoch,
      phase: 'stopping',
      message: '正在准备停止当前任务和仿真…',
      started_at: Date.now() / 1000,
    };
    await saveJournal({ epoch, operation });
    const child = spawn(
      '/usr/bin/python3',
      [
        resolve(root, 'ops/workspace_lifecycle_worker.py'),
        '--operation',
        requestId,
        '--scene',
        sceneId,
        '--epoch',
        epoch,
      ],
      {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: {
          PATH: '/usr/bin:/bin',
          BUSAGENT_RESET_DATABASE:
            process.env.BUSAGENT_RESET_DATABASE ?? 'busagent_arena',
        },
      },
    );
    child.unref();
    return workspaceStatus();
  } finally {
    submitting = false;
  }
}
