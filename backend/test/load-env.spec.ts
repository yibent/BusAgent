import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { HostConfig } from '../src/config/host-config.js';

describe('dotenv HostConfig', () => {
  it('picks DASHSCOPE_API_KEY from a .env file merged into process.env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'busagent-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'DASHSCOPE_API_KEY=sk-from-dotenv\n');
    const env = { ...process.env };
    loadDotenv({ path: file, processEnv: env });
    const config = HostConfig.fromEnv(env);
    expect(config.dashscopeApiKey).toBe('sk-from-dotenv');
  });
});
