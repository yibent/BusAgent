import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { HostConfig } from '../../../config/host-config.js';
import type { Role } from './types.js';

export const profileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1),
  provider: z.enum(['gemini', 'qwen', 'glm', 'deepseek', 'openai-compatible']),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().default(''),
  vision: z.boolean().default(true),
  /** The provider can return normalized object/region boxes from an image. */
  boxGrounding: z.boolean().optional(),
  thinking: z.boolean().default(false),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'max']).optional(),
  peerGroup: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  firstTokenTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  cooldownEnabled: z.boolean().optional(),
});
export type ModelProfile = z.infer<typeof profileSchema>;
const configSchema = z.object({
  profiles: z.array(profileSchema).min(1),
  roles: z.object({
    /** Cheap text-only routing and complete simple plans. Falls back to planner. */
    task: z.string().optional(),
    planner: z.string(),
    supervisor: z.string(),
    dialogue: z.string().optional(),
    visual: z.string().optional(),
  }),
  fallbacks: z
    .object({
      planner: z.array(z.string()).default([]),
      task: z.array(z.string()).optional(),
      supervisor: z.array(z.string()).default([]),
      dialogue: z.array(z.string()).optional(),
      visual: z.array(z.string()).optional(),
    })
    .default({}),
  nodeTimeouts: z
    .object({
      planner: z.number().int().min(1000).max(120000).optional(),
      task: z.number().int().min(1000).max(120000).optional(),
      supervisor: z.number().int().min(1000).max(120000).optional(),
      dialogue: z.number().int().min(1000).max(120000).optional(),
      visual: z.number().int().min(1000).max(120000).optional(),
      perception: z.number().int().min(1000).max(120000).optional(),
    })
    .default({}),
  nodeFirstTokenTimeouts: z
    .object({
      task: z.number().int().min(1000).max(120000).optional(),
      planner: z.number().int().min(1000).max(120000).optional(),
      supervisor: z.number().int().min(1000).max(120000).optional(),
      dialogue: z.number().int().min(1000).max(120000).optional(),
      visual: z.number().int().min(1000).max(120000).optional(),
    })
    .optional(),
  fallbackPolicies: z
    .object({
      task: z.enum(['disabled', 'same_capability', 'ordered_compatible']).optional(),
      planner: z.enum(['disabled', 'same_capability', 'ordered_compatible']).optional(),
      supervisor: z
        .enum(['disabled', 'same_capability', 'ordered_compatible'])
        .optional(),
      visual: z.enum(['disabled', 'same_capability', 'ordered_compatible']).optional(),
    })
    .optional(),
  dialogueRouting: z
    .object({
      activeProfile: z.string(),
      consecutiveFailures: z.number().int().min(0).max(3),
      generation: z.number().int().min(0),
      switchedAt: z.string().optional(),
      reason: z.enum(['manual', 'consecutive_failures']).optional(),
      exhausted: z.boolean().optional(),
    })
    .optional(),
  performance: z
    .object({
      lookahead: z.boolean().default(true),
      requestTimeoutMs: z.number().int().min(1000).max(120000).default(20000),
      firstTokenTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      planningBudgetMs: z.number().int().min(5000).max(300000).default(60000),
      toolRounds: z.number().int().min(1).max(16).default(6),
      contextBudgetTokens: z.number().int().min(6000).max(128000).optional(),
      toolResultBudgetTokens: z.number().int().min(512).max(12000).optional(),
      providerCooldownEnabled: z.boolean().default(false),
    })
    .default({}),
  images: z.boolean().default(true),
  supervisorEnabled: z.boolean().default(true),
  recoveryBudget: z.number().int().min(1).max(20).default(3),
  architecture: z
    .object({
      mode: z.enum(['legacy', 'staged']).default('staged'),
      stageRetryLimit: z.number().int().min(1).max(8).default(2),
      finalReviewLimit: z.number().int().min(1).max(4).default(2),
      finalReview: z.boolean().default(true),
    })
    .optional(),
});
export type ModelSettings = z.infer<typeof configSchema>;
export type ModelRole = Role | 'visual' | 'task';
export interface DialogueAttempt {
  profile: ModelProfile;
  generation: number;
}
type DialogueRouting = NonNullable<ModelSettings['dialogueRouting']>;
const dialogueChain = (s: ModelSettings) => [
  ...new Set(
    [s.roles.dialogue, ...(s.fallbacks.dialogue ?? [])].filter((id): id is string =>
      Boolean(id),
    ),
  ),
];
const dialogueState = (s: ModelSettings): DialogueRouting =>
  s.dialogueRouting ?? {
    activeProfile: s.roles.dialogue ?? '',
    consecutiveFailures: 0,
    generation: 0,
  };
type RoutedRole = ModelRole;
const defaultFallbackPolicy = (role: RoutedRole) =>
  role === 'task' ? 'ordered_compatible' : 'same_capability';
const effectiveFirstTokenTimeout = (
  settings: ModelSettings,
  role: ModelRole | 'dialogue',
  profile: ModelProfile,
) =>
  settings.nodeFirstTokenTimeouts?.[role] ??
  profile.firstTokenTimeoutMs ??
  (profile.vision && ['planner', 'supervisor', 'visual'].includes(role)
    ? 30000
    : (settings.performance.firstTokenTimeoutMs ?? 8000));
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
  private cache: ModelSettings | undefined;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly host: HostConfig) {}
  async settings(): Promise<ModelSettings> {
    if (this.cache) return structuredClone(this.cache);
    try {
      this.cache ??= configSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cache ??= configSchema.parse({
        profiles: [
          {
            id: 'gemini-37-flash',
            name: 'Gemini 3.7 Flash',
            provider: 'gemini',
            baseUrl: process.env.GEMINI_PRIMARY_URL ?? 'https://api.gptnb.ai/v1',
            model: 'gemini-3.7-flash',
            apiKey: process.env.GEMINI_PRIMARY_API_KEY ?? '',
            peerGroup: 'gemini-flash',
            boxGrounding: true,
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
            boxGrounding: true,
            reasoningEffort: 'low',
            thinking: true,
          },
          ...[
            'qwen3.8-flash',
            'qwen3.7-flash',
            'qwen3.7-flash-2026-07-15',
            'deepseek-v4-flash-0731',
          ].map((model) => ({
            id: model.replaceAll('.', '-'),
            name: model,
            provider: model.startsWith('qwen') ? 'qwen' : 'deepseek',
            baseUrl: process.env.QWEN_CHAT_URL ?? this.host.qwenChatUrl,
            model,
            apiKey: process.env.QWEN_CHAT_API_KEY ?? this.host.dashscopeApiKey ?? '',
            vision: false,
            thinking: false,
          })),
        ],
        roles: {
          task: 'gemini-37-flash',
          planner: 'gemini-37-flash',
          supervisor: 'gemini-37-flash',
          dialogue: 'qwen3-8-flash',
        },
        fallbacks: {
          task: ['gemini-38-flash'],
          planner: ['gemini-38-flash'],
          supervisor: ['gemini-38-flash'],
          dialogue: [
            'qwen3-7-flash',
            'qwen3-7-flash-2026-07-15',
            'deepseek-v4-flash-0731',
          ],
        },
      });
    }
    this.cache.architecture ??= {
      mode: 'staged',
      stageRetryLimit: 2,
      finalReviewLimit: 2,
      finalReview: true,
    };
    this.cache.performance.firstTokenTimeoutMs ??= 8000;
    return structuredClone(this.cache);
  }
  async publicSettings() {
    const settings = await this.settings();
    return {
      ...settings,
      nodeFirstTokenTimeouts: settings.nodeFirstTokenTimeouts ?? {},
      architecture: settings.architecture ?? {
        mode: 'staged',
        stageRetryLimit: 2,
        finalReviewLimit: 2,
        finalReview: true,
      },
      fallbackPolicies: {
        task: settings.fallbackPolicies?.task ?? defaultFallbackPolicy('task'),
        planner: settings.fallbackPolicies?.planner ?? defaultFallbackPolicy('planner'),
        supervisor:
          settings.fallbackPolicies?.supervisor ?? defaultFallbackPolicy('supervisor'),
        visual: settings.fallbackPolicies?.visual ?? defaultFallbackPolicy('visual'),
      },
      roles: {
        ...settings.roles,
        task: settings.roles.task || settings.roles.planner,
        visual: settings.roles.visual || settings.roles.planner,
      },
      fallbacks: {
        ...settings.fallbacks,
        task: settings.fallbacks.task ?? settings.fallbacks.planner,
        visual: settings.fallbacks.visual ?? settings.fallbacks.planner,
      },
      dialogueRouting: dialogueState(settings),
      profiles: settings.profiles.map(({ apiKey, ...p }) => ({
        ...p,
        boxGrounding: p.boxGrounding ?? (p.provider === 'gemini' && p.vision),
        configured: Boolean(apiKey),
      })),
    };
  }
  async profile(role: ModelRole): Promise<ModelProfile> {
    const settings = await this.settings();
    if (role === 'supervisor' && !settings.supervisorEnabled)
      throw new Error('自动监督 LLM 已关闭，等待人工核验。');
    const id =
      role === 'visual'
        ? settings.roles.visual || settings.roles.planner
        : role === 'task'
          ? settings.roles.task || settings.roles.planner
          : settings.roles[role];
    const profile = settings.profiles.find((p) => p.id === id);
    if (!profile?.enabled || !profile.apiKey)
      throw new Error(`${role} 模型尚未启用或缺少 API Key，请在模型设置中配置。`);
    const tokenTimeout = effectiveFirstTokenTimeout(settings, role, profile);
    return {
      ...profile,
      boxGrounding:
        profile.boxGrounding ?? (profile.provider === 'gemini' && profile.vision),
      timeoutMs: Math.max(
        tokenTimeout,
        settings.nodeTimeouts?.[role] ??
          profile.timeoutMs ??
          settings.performance.requestTimeoutMs,
      ),
      firstTokenTimeoutMs: tokenTimeout,
      cooldownEnabled: settings.performance.providerCooldownEnabled,
    };
  }
  async profilesFor(role: ModelRole): Promise<ModelProfile[]> {
    const settings = await this.settings();
    const primary = await this.profile(role);
    const policy = settings.fallbackPolicies?.[role] ?? defaultFallbackPolicy(role);
    const ids = [
      primary.id,
      ...(policy === 'disabled'
        ? []
        : role === 'visual'
          ? (settings.fallbacks.visual ?? settings.fallbacks.planner)
          : role === 'task'
            ? (settings.fallbacks.task ?? settings.fallbacks.planner)
            : settings.fallbacks[role]),
    ];
    return [...new Set(ids)].flatMap((id) => {
      const p = settings.profiles.find(
        (row) => row.id === id && row.enabled && row.apiKey,
      );
      const boxGrounding =
        p?.boxGrounding ?? (p?.provider === 'gemini' && p?.vision === true);
      if (
        !p ||
        (policy === 'same_capability' &&
          (p.vision !== primary.vision ||
            (primary.boxGrounding === true && boxGrounding !== true)))
      )
        return [];
      const tokenTimeout = effectiveFirstTokenTimeout(settings, role, p);
      return p
        ? [
            {
              ...p,
              boxGrounding,
              timeoutMs: Math.max(
                tokenTimeout,
                settings.nodeTimeouts?.[role] ??
                  p.timeoutMs ??
                  settings.performance.requestTimeoutMs,
              ),
              firstTokenTimeoutMs: tokenTimeout,
              cooldownEnabled: settings.performance.providerCooldownEnabled,
            },
          ]
        : [];
    });
  }
  async dialogueAttempt(): Promise<DialogueAttempt> {
    const settings = await this.settings();
    const state = dialogueState(settings);
    const profile = settings.profiles.find(
      (p) => p.id === state.activeProfile && p.enabled && p.apiKey,
    );
    if (!profile) throw new Error('即时回答渠道未配置，请在模型设置中选择默认渠道。');
    const tokenTimeout = effectiveFirstTokenTimeout(settings, 'dialogue', profile);
    return {
      profile: {
        ...profile,
        timeoutMs: Math.max(
          tokenTimeout,
          settings.nodeTimeouts?.dialogue ??
            profile.timeoutMs ??
            settings.performance.requestTimeoutMs,
        ),
        firstTokenTimeoutMs: tokenTimeout,
        cooldownEnabled: settings.performance.providerCooldownEnabled,
      },
      generation: state.generation,
    };
  }
  async dialogueProfiles(): Promise<ModelProfile[]> {
    return [(await this.dialogueAttempt()).profile];
  }

  /** Serialize settings edits and concurrent model outcomes in this single host. */
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writing.then(work);
    this.writing = next.catch(() => undefined);
    return next;
  }
  private async persist(settings: ModelSettings) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
    this.cache = settings;
  }

  /** No retry here: the next request uses the persisted channel after three failures. */
  async recordDialogueResult(
    attempt: DialogueAttempt,
    success: boolean,
    cancelled?: AbortSignal,
  ) {
    return this.mutate(async () => {
      const settings = await this.settings();
      const state = dialogueState(settings);
      if (
        cancelled?.aborted ||
        state.generation !== attempt.generation ||
        state.activeProfile !== attempt.profile.id
      )
        return state;
      const failures = success ? 0 : Math.min(3, state.consecutiveFailures + 1);
      let next: DialogueRouting = {
        ...state,
        consecutiveFailures: failures,
        exhausted: false,
      };
      if (failures >= 3) {
        const chain = dialogueChain(settings);
        const index = chain.indexOf(state.activeProfile);
        const candidate = index >= 0 ? chain[index + 1] : undefined;
        const enabled = settings.profiles.find(
          (p) => p.id === candidate && p.enabled && p.apiKey,
        );
        next = enabled
          ? {
              activeProfile: enabled.id,
              consecutiveFailures: 0,
              generation: state.generation + 1,
              switchedAt: new Date().toISOString(),
              reason: 'consecutive_failures',
              exhausted: false,
            }
          : { ...next, exhausted: true };
      }
      if (
        JSON.stringify(next) !==
        JSON.stringify({ ...state, exhausted: state.exhausted ?? false })
      ) {
        settings.dialogueRouting = next;
        await this.persist(settings);
      }
      return next;
    });
  }
  async save(input: unknown, resetDialogue = false, clearApiKeys: string[] = []) {
    return this.mutate(async () => {
      const next = configSchema.parse(input);
      const previous = await this.settings();
      const clear = new Set(clearApiKeys);
      if ([...clear].some((id) => !next.profiles.some((profile) => profile.id === id)))
        throw new Error('要清除令牌的模型不存在。');
      if (new Set(next.profiles.map((p) => p.id)).size !== next.profiles.length)
        throw new Error('模型配置 ID 不能重复。');
      for (const p of next.profiles) {
        const url = new URL(p.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new Error('模型地址必须是 HTTP(S) 服务地址。');
        if (clear.has(p.id)) p.apiKey = '';
        else if (!p.apiKey)
          p.apiKey = previous.profiles.find((old) => old.id === p.id)?.apiKey ?? '';
      }
      for (const id of Object.values(next.roles).filter(Boolean)) {
        if (!next.profiles.some((p) => p.id === id && p.enabled && p.apiKey))
          throw new Error('规划和监督角色必须选择已配置并启用的模型。');
      }
      for (const [role, ids] of Object.entries(next.fallbacks)) {
        const primary = next.roles[role as keyof typeof next.roles];
        if (
          (ids ?? []).length !== new Set(ids ?? []).size ||
          (ids ?? []).includes(primary ?? '')
        )
          throw new Error(`${role} 的主模型与回退模型不能重复。`);
        for (const id of ids ?? [])
          if (!next.profiles.some((p) => p.id === id && p.enabled && p.apiKey))
            throw new Error(
              role === 'dialogue'
                ? '即时回答备选渠道必须已启用并配置 API 令牌。'
                : `${role} 回退模型必须已启用并配置 API 令牌。`,
            );
      }
      const chain = dialogueChain(next);
      if (
        (next.fallbacks.dialogue ?? []).length !==
          new Set(next.fallbacks.dialogue ?? []).size ||
        (next.fallbacks.dialogue ?? []).includes(next.roles.dialogue ?? '')
      )
        throw new Error('即时回答的默认渠道与备选渠道不能重复。');
      for (const id of chain) {
        if (!next.profiles.some((p) => p.id === id && p.enabled && p.apiKey))
          throw new Error('即时回答备选渠道必须已启用并配置密钥。');
      }
      const previousState = dialogueState(previous);
      const defaultChanged = next.roles.dialogue !== previous.roles.dialogue;
      const active =
        resetDialogue || defaultChanged || !chain.includes(previousState.activeProfile)
          ? (next.roles.dialogue ?? '')
          : previousState.activeProfile;
      const signature = (s: ModelSettings) =>
        JSON.stringify(
          dialogueChain(s).map((id) => s.profiles.find((p) => p.id === id)),
        );
      // Runtime state is server-owned; a stale settings page cannot undo a switch.
      next.dialogueRouting =
        resetDialogue || defaultChanged || signature(next) !== signature(previous)
          ? {
              activeProfile: active,
              consecutiveFailures: 0,
              generation: previousState.generation + 1,
              switchedAt: new Date().toISOString(),
              reason: 'manual',
              exhausted: false,
            }
          : previousState;
      await this.persist(next);
      return this.publicSettings();
    });
  }
}
