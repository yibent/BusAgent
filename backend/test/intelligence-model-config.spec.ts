import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ModelConfig,
  completionsUrl,
} from '../src/apps/desktop-robot/intelligence/model-config.js';
import { complete } from '../src/apps/desktop-robot/intelligence/model-client.js';
import type { HostConfig } from '../src/config/host-config.js';

describe('private model profiles', () => {
  let directory: string;
  let models: ModelConfig;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'busagent-profiles-test-'));
    vi.stubEnv('BUSAGENT_INTELLIGENCE_CONFIG', join(directory, 'settings.json'));
    vi.stubEnv('QWEN_CHAT_API_KEY', 'dialogue-test-key');
    vi.stubEnv('GEMINI_PRIMARY_API_KEY', 'private-test-key');
    vi.stubEnv('GEMINI_SECONDARY_API_KEY', 'secondary-test-key');
    vi.stubEnv('QWEN_CHAT_URL', 'https://model.test/v1');
    models = new ModelConfig({} as HostConfig);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  it('requires an admin token and preserves keys without returning them to the browser', async () => {
    const publicSettings = await models.publicSettings();
    expect(JSON.stringify(publicSettings)).not.toContain('private-test-key');
    await expect(models.save(publicSettings, 'wrong')).rejects.toThrow('管理令牌');
    const token = await readFile(models.tokenPath, 'utf8');
    const saved = await models.save(publicSettings, token);
    expect(JSON.stringify(saved)).not.toContain('private-test-key');
    expect((await models.profile('planner')).apiKey).toBe('private-test-key');
    expect((await stat(models.path)).mode & 0o777).toBe(0o600);
    expect((await stat(models.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await new ModelConfig({} as HostConfig).profile('planner')).apiKey).toBe(
      'private-test-key',
    );
  });
  it('persists an independently selectable dialogue profile and shares settings updates immediately', async () => {
    const settings = await models.publicSettings();
    await expect(models.save(settings, 'wrong')).rejects.toThrow('管理令牌');
    const token = await readFile(models.tokenPath, 'utf8');
    settings.roles.dialogue = 'qwen3-8-flash';
    await models.save(settings, token);
    expect((await models.dialogueProfiles())[0]?.id).toBe('qwen3-8-flash');
    expect((await new ModelConfig({} as HostConfig).settings()).roles.dialogue).toBe(
      'qwen3-8-flash',
    );
  });
  it('isolates Gemini and GLM thinking parameters and does not log remote error bodies', async () => {
    const profile = await models.profile('planner');
    const request = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'OK' } }],
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', request);
    await complete(profile, [{ role: 'user', content: 'test' }], []);
    let body = JSON.parse(
      (request.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe('low');
    expect(body.thinking).toBeUndefined();
    await complete(
      { ...profile, provider: 'glm', thinking: true },
      [{ role: 'user', content: 'test' }],
      [],
    );
    body = JSON.parse(
      (request.mock.calls[1]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.enable_thinking).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'enabled' });
    request.mockResolvedValueOnce(
      new Response('sensitive remote diagnostics', { status: 401 }),
    );
    await expect(complete(profile, [], [])).rejects.toThrow('HTTP 401');
  });
  it('uses the supported GLM 5.3 thinking mode even with a previously disabled setting', async () => {
    const request = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'OK' } }],
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', request);
    const profile = {
      ...(await models.profile('planner')),
      provider: 'glm' as const,
      model: 'glm-5.3-flash',
      thinking: false,
    };
    await complete(profile, [{ role: 'user', content: 'test' }], []);
    const body = JSON.parse(
      (request.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'enabled', clear_thinking: false });
    expect(body.reasoning_effort).toBe('low');
    expect(body.enable_thinking).toBeUndefined();
    await complete({ ...profile, reasoningEffort: 'high' }, [], []);
    expect(
      (
        JSON.parse((request.mock.calls[1]![1] as RequestInit).body as string) as Record<
          string,
          unknown
        >
      ).reasoning_effort,
    ).toBe('high');
  });
  it('keeps the two Gemini providers as peers when the preferred role is reversed', async () => {
    const settings = await models.publicSettings();
    await expect(models.save(settings, 'wrong')).rejects.toThrow();
    settings.roles.planner = 'gemini-38-flash';
    await models.save(settings, await readFile(models.tokenPath, 'utf8'));
    expect((await models.profilesFor('planner')).map((p) => p.id)).toEqual([
      'gemini-38-flash',
      'gemini-37-flash',
    ]);
    expect((await models.dialogueProfiles()).map((p) => p.id)).toEqual([
      'qwen3-8-flash',
    ]);
    expect(completionsUrl('https://model.test/')).toBe(
      'https://model.test/v1/chat/completions',
    );
    expect(completionsUrl('https://model.test/custom/v1/')).toBe(
      'https://model.test/custom/v1/chat/completions',
    );
  });
  it('preserves provider tool signature metadata when continuing an inference', async () => {
    const message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_state', arguments: '{}' },
          extra_content: { google: { thought_signature: 'opaque-signature' } },
        },
      ],
    };
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ choices: [{ message }] }));
    vi.stubGlobal('fetch', request);
    const profile = await models.profile('planner');
    const first = await complete(profile, [], []);
    request.mockResolvedValue(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'ready' } }],
      }),
    );
    await complete(
      profile,
      [first.message, { role: 'tool', tool_call_id: 'call-1', content: '{}' }],
      [],
    );
    const sent = JSON.parse(
      (request.mock.calls[1]![1] as RequestInit).body as string,
    ) as { messages: unknown[] };
    expect(sent.messages[0]).toEqual(message);
  });
  it('disables DeepSeek reasoning for immediate dialogue without using Qwen parameters', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json({
          choices: [{ message: { role: 'assistant', content: '你好' } }],
        }),
      );
    vi.stubGlobal('fetch', request);
    const profile = (await models.settings()).profiles.find(
      (p) => p.provider === 'deepseek',
    )!;
    await complete(profile, [{ role: 'user', content: '你好' }], []);
    const body = JSON.parse(
      (request.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('enable_thinking');
  });
});
