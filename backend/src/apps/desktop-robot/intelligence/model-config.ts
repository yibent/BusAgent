import { Injectable } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { HostConfig } from '../../../config/host-config.js';
import type { Role } from './types.js';

export const profileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1),
  provider: z.enum(['gemini', 'qwen', 'glm', 'openai-compatible']),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().default(''),
  vision: z.boolean().default(true),
  thinking: z.boolean().default(false),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'max']).optional(),
  peerGroup: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});
export type ModelProfile = z.infer<typeof profileSchema>;
const configSchema = z.object({
  profiles: z.array(profileSchema).min(1),
  roles: z.object({
    planner: z.string(),
    supervisor: z.string(),
    dialogue: z.string().optional(),
  }),
  fallbacks: z
    .object({
      planner: z.array(z.string()).default([]),
      supervisor: z.array(z.string()).default([]),
    })
    .default({}),
  performance: z
    .object({
      lookahead: z.boolean().default(true),
      requestTimeoutMs: z.number().int().min(1000).max(120000).default(20000),
      planningBudgetMs: z.number().int().min(5000).max(300000).default(60000),
      toolRounds: z.number().int().min(1).max(16).default(6),
      contextBudgetTokens: z.number().int().min(6000).max(128000).optional(),
      toolResultBudgetTokens: z.number().int().min(512).max(12000).optional(),
    })
    .default({}),
  images: z.boolean().default(true),
  supervisorEnabled: z.boolean().default(true),
  recoveryBudget: z.number().int().min(1).max(20).default(3),
});
export type ModelSettings = z.infer<typeof configSchema>;
export function completionsUrl(base: string): string {
  const url = new URL(base);
  url.pathname =
    url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') || '/v1';
  url.pathname += '/chat/completions';
  return url.toString();
}

@Injectable()
export class ModelConfig {
  readonly path = resolve(
    process.env.BUSAGENT_INTELLIGENCE_CONFIG ?? '.local/intelligence.json',
  );
  readonly tokenPath = resolve(dirname(this.path), 'admin-token');
  private cache: ModelSettings | undefined;
  constructor(private readonly host: HostConfig) {}
  async settings(): Promise<ModelSettings> {
    if (this.cache) return structuredClone(this.cache);
    try {
      this.cache = configSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cache = configSchema.parse({
        profiles: [
          {
            id: 'gemini-37-flash',
            name: 'Gemini 3.7 Flash',
            provider: 'gemini',
            baseUrl: process.env.GEMINI_PRIMARY_URL ?? 'https://api.gptnb.ai/v1',
            model: 'gemini-3.7-flash',
            apiKey: process.env.GEMINI_PRIMARY_API_KEY ?? '',
            peerGroup: 'gemini-flash',
            reasoningEffort: 'low',
            thinking: true,
          },
          {
            id: 'gemini-38-flash',
            name: 'Gemini 3.8 Flash',
            provider: 'gemini',
            baseUrl: process.env.GEMINI_SECONDARY_URL ?? 'https://api.bltcy.ai/v1',
            model: 'gemini-3.8-flash',
            apiKey: process.env.GEMINI_SECONDARY_API_KEY ?? '',
            peerGroup: 'gemini-flash',
            reasoningEffort: 'low',
            thinking: true,
          },
          {
            id: 'qwen-plus',
            name: 'Qwen Plus',
            provider: 'qwen',
            baseUrl: process.env.QWEN_CHAT_URL ?? this.host.qwenChatUrl,
            model: process.env.BUSAGENT_PLANNER_MODEL ?? 'qwen3.7-plus',
            apiKey: process.env.QWEN_CHAT_API_KEY ?? this.host.dashscopeApiKey ?? '',
          },
        ],
        roles: {
          planner: 'gemini-37-flash',
          supervisor: 'gemini-37-flash',
          dialogue: 'qwen-plus',
        },
        fallbacks: { planner: ['gemini-38-flash'], supervisor: ['gemini-38-flash'] },
      });
    }
    return structuredClone(this.cache);
  }
  async publicSettings() {
    const settings = await this.settings();
    return {
      ...settings,
      profiles: settings.profiles.map(({ apiKey, ...p }) => ({
        ...p,
        configured: Boolean(apiKey),
      })),
    };
  }
  async profile(role: Role): Promise<ModelProfile> {
    const settings = await this.settings();
    if (role === 'supervisor' && !settings.supervisorEnabled)
      throw new Error('自动监督 LLM 已关闭，等待人工核验。');
    const profile = settings.profiles.find((p) => p.id === settings.roles[role]);
    if (!profile?.enabled || !profile.apiKey)
      throw new Error(`${role} 模型尚未启用或缺少 API Key，请在模型设置中配置。`);
    return profile;
  }
  async profilesFor(role: Role): Promise<ModelProfile[]> {
    const settings = await this.settings();
    const primary = await this.profile(role);
    const ids = [
      primary.id,
      ...settings.fallbacks[role],
      ...settings.profiles
        .filter((p) => primary.peerGroup && p.peerGroup === primary.peerGroup)
        .map((p) => p.id),
    ];
    return [...new Set(ids)].flatMap((id) => {
      const p = settings.profiles.find(
        (row) => row.id === id && row.enabled && row.apiKey,
      );
      return p
        ? [{ ...p, timeoutMs: p.timeoutMs ?? settings.performance.requestTimeoutMs }]
        : [];
    });
  }
  async dialogueProfiles(): Promise<ModelProfile[]> {
    const settings = await this.settings();
    const selected = settings.profiles.find(
      (p) => p.id === settings.roles.dialogue && p.enabled && p.apiKey,
    );
    if (settings.roles.dialogue) {
      if (!selected) throw new Error('即时对话模型尚未配置，保留其独立配置。');
      return [selected];
    }
    return this.profilesFor('planner');
  }
  async authorize(token: unknown): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.tokenPath, randomBytes(24).toString('hex'), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const expected = Buffer.from((await readFile(this.tokenPath, 'utf8')).trim());
    const provided = Buffer.from(typeof token === 'string' ? token : '');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided))
      throw new Error('模型设置需要服务器管理令牌。');
  }
  async save(input: unknown, token: unknown) {
    await this.authorize(token);
    const next = configSchema.parse(input);
    const previous = await this.settings();
    if (new Set(next.profiles.map((p) => p.id)).size !== next.profiles.length)
      throw new Error('模型配置 ID 不能重复。');
    for (const p of next.profiles) {
      const url = new URL(p.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('模型地址必须是 HTTP(S) 服务地址。');
      if (!p.apiKey)
        p.apiKey = previous.profiles.find((old) => old.id === p.id)?.apiKey ?? '';
    }
    for (const id of Object.values(next.roles)) {
      if (!next.profiles.some((p) => p.id === id && p.enabled && p.apiKey))
        throw new Error('规划和监督角色必须选择已配置并启用的模型。');
    }
    const temporary = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
    this.cache = next;
    return this.publicSettings();
  }
}
