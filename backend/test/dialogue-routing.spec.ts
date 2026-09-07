import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConfig } from '../src/apps/desktop-robot/intelligence/model-config.js';
import type { HostConfig } from '../src/config/host-config.js';

describe('persistent dialogue channel selection', () => {
  let directory: string, models: ModelConfig, token: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dialogue-routing-'));
    vi.stubEnv('BUSAGENT_INTELLIGENCE_CONFIG', join(directory, 'settings.json'));
    vi.stubEnv('QWEN_CHAT_API_KEY', 'test-dialogue-key');
    vi.stubEnv('QWEN_CHAT_URL', 'https://example.test/v1');
    vi.stubEnv('GEMINI_PRIMARY_API_KEY', 'test-planning-key');
    vi.stubEnv('GEMINI_SECONDARY_API_KEY', 'test-planning-backup-key');
    models = new ModelConfig({} as HostConfig);
    await expect(models.authorize('wrong')).rejects.toThrow();
    token = await readFile(models.tokenPath, 'utf8');
    await models.save(await models.publicSettings(), token);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  const fail = async (models: ModelConfig, count = 1) => {
    for (let i = 0; i < count; i++)
      await models.recordDialogueResult(await models.dialogueAttempt(), false);
  };
  it('switches only on the third failure, keeps success reset and survives restart', async () => {
    await fail(models, 2);
    expect((await models.dialogueAttempt()).profile.model).toBe('qwen3.8-flash');
    models = new ModelConfig({} as HostConfig);
    expect((await models.publicSettings()).dialogueRouting.consecutiveFailures).toBe(2);
    await models.recordDialogueResult(await models.dialogueAttempt(), true);
    expect((await models.publicSettings()).dialogueRouting.consecutiveFailures).toBe(0);
    await fail(models, 3);
    expect((await models.dialogueAttempt()).profile.model).toBe('qwen3.7-flash');
    models = new ModelConfig({} as HostConfig);
    expect((await models.dialogueAttempt()).profile.model).toBe('qwen3.7-flash');
    expect((await models.settings()).roles.dialogue).toBe('qwen3-8-flash');
    await models.recordDialogueResult(await models.dialogueAttempt(), true);
    expect((await models.dialogueAttempt()).profile.model).toBe('qwen3.7-flash');
  });
  it('walks the configured order without wrapping and manually restores the default', async () => {
    for (const expected of [
      'qwen3.7-flash',
      'qwen3.7-flash-2026-07-15',
      'deepseek-v4-flash-0731',
    ]) {
      await fail(models, 3);
      expect((await models.dialogueAttempt()).profile.model).toBe(expected);
    }
    await fail(models, 5);
    expect((await models.publicSettings()).dialogueRouting).toMatchObject({
      activeProfile: 'deepseek-v4-flash-0731',
      consecutiveFailures: 3,
      exhausted: true,
    });
    await models.save(await models.publicSettings(), token, true);
    expect((await models.dialogueAttempt()).profile.model).toBe('qwen3.8-flash');
    expect((await models.publicSettings()).dialogueRouting.consecutiveFailures).toBe(0);
  });
  it('serializes concurrent failures and ignores old in-flight results after a switch', async () => {
    const old = await models.dialogueAttempt();
    await Promise.all(
      Array.from({ length: 8 }, () => models.recordDialogueResult(old, false)),
    );
    expect((await models.dialogueAttempt()).profile.model).toBe('qwen3.7-flash');
    await fail(models);
    await models.recordDialogueResult(old, true);
    expect((await models.publicSettings()).dialogueRouting.consecutiveFailures).toBe(1);
    await models.recordDialogueResult(old, false);
    expect((await models.publicSettings()).dialogueRouting.consecutiveFailures).toBe(1);
  });
  it('ignores a cancellation even while queued for persistence', async () => {
    const abort = new AbortController();
    const attempt = await models.dialogueAttempt();
    const pending = models.recordDialogueResult(attempt, false, abort.signal);
    abort.abort();
    await pending;
    expect((await models.publicSettings()).dialogueRouting.consecutiveFailures).toBe(0);
  });
  it('ignores stale frontend runtime state and unrelated saves, but applies an explicit new default', async () => {
    const draft = await models.publicSettings();
    await fail(models, 3);
    draft.images = !draft.images;
    await models.save(draft, token);
    expect((await models.dialogueAttempt()).profile.model).toBe('qwen3.7-flash');
    const next = await models.publicSettings();
    next.roles.dialogue = 'deepseek-v4-flash-0731';
    next.fallbacks.dialogue = ['qwen3-8-flash', 'qwen3-7-flash'];
    const old = await models.dialogueAttempt();
    await models.save(next, token);
    await models.recordDialogueResult(old, false);
    expect((await models.dialogueAttempt()).profile.model).toBe(
      'deepseek-v4-flash-0731',
    );
    expect((await models.publicSettings()).dialogueRouting.consecutiveFailures).toBe(0);
    await fail(models, 3);
    expect((await models.dialogueAttempt()).profile.model).toBe('qwen3.8-flash');
  });
  it('does not share failures or routing changes with planner and supervisor peers', async () => {
    const planning = (await models.profilesFor('planner')).map((p) => p.id);
    await fail(models, 9);
    expect((await models.profilesFor('planner')).map((p) => p.id)).toEqual(planning);
    expect((await models.profilesFor('supervisor')).map((p) => p.id)).toEqual(planning);
    const settings = await models.publicSettings();
    settings.fallbacks.dialogue = ['missing'];
    await expect(models.save(settings, token)).rejects.toThrow('备选渠道');
  });
});
