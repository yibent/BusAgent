import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from '../src/app/app-loader.js';

function writeApp(dir: string, content: unknown): string {
  mkdirSync(join(dir, 'apps'), { recursive: true });
  const file = join(dir, 'apps', 'test.app.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const validApp = {
  schema_version: '1',
  app: { id: 'a', version: '1' },
  agents: [{ agent_id: 'x', required: true, config: { prompt_file: 'prompts/p.md' } }],
  routes: [{ event: 'e', to: ['x'] }],
};

describe('loadApp', () => {
  it('loads a valid app with its relative prompt file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'busagent-'));
    mkdirSync(join(dir, 'apps', 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'prompts', 'p.md'), 'hello prompt');
    const resolved = await loadApp(writeApp(dir, validApp));
    expect(resolved.appId).toBe('a');
    expect(resolved.resolvedFiles.get('x')?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a prompt_file that escapes the app directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'busagent-'));
    const app = {
      ...validApp,
      agents: [
        { agent_id: 'x', required: true, config: { prompt_file: '../secret.md' } },
      ],
    };
    await expect(loadApp(writeApp(dir, app))).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
  });

  it('rejects a missing prompt_file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'busagent-'));
    const app = {
      ...validApp,
      agents: [
        { agent_id: 'x', required: true, config: { prompt_file: 'prompts/nope.md' } },
      ],
    };
    await expect(loadApp(writeApp(dir, app))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});
