import { createHash, randomUUID } from 'node:crypto';
import { estimateTokens } from '../../../modules/conversation/context-format.js';
import type { Message, Tool } from './model-client.js';

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const priority = [
  'error',
  'ok',
  'state',
  'holding',
  'failure',
  'evaluation',
  'postconditions',
  'review_required',
  'review_reason',
  'request_id',
  'ref',
  'axis_ref',
  'cell_ref',
  'label',
  'geometry',
  'selection',
  'evidence_ref',
  'snapshot_ref',
  'observed_at',
  'camera',
  'total',
  'next_offset',
  'has_more',
  'before',
];

/** Preserve complete values, and expose omitted JSON paths for exact retrieval. */
export function evidencePreview(value: unknown, budget: number) {
  const omitted: Array<{ path: string; total?: number }> = [];
  const visit = (v: unknown, available: number, path: string): unknown => {
    if (estimateTokens(v) <= available) return v;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const remaining = available - estimateTokens(out) - 8;
        if (remaining < 80) {
          omitted.push({ path, total: v.length });
          break;
        }
        out.push(visit(v[i], remaining, `${path}/${i}`));
      }
      return out;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      const entries = Object.entries(object(v));
      entries.sort(([a], [b]) => {
        const rank = (key: string) =>
          priority.includes(key) ? priority.indexOf(key) : 100;
        return rank(a) - rank(b);
      });
      for (const [key, item] of entries) {
        const next = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        const remaining = available - estimateTokens(out) - estimateTokens(key) - 12;
        if (remaining < 60) {
          omitted.push({ path: next });
          continue;
        }
        out[key] = visit(item, remaining, next);
      }
      return out;
    }
    omitted.push({ path });
    return { omitted: true, path };
  };
  const preview = visit(value, Math.max(128, budget - 200), '');
  return {
    preview,
    omitted_paths: omitted.slice(0, 24),
    omitted_path_count: omitted.length,
  };
}

export function evidencePage(value: unknown, path = '', offset = 0, limit = 16) {
  let selected = value;
  if (path && !path.startsWith('/'))
    throw new Error('path 使用 JSON Pointer，例如 /geometry/cells');
  for (const encoded of path.split('/').slice(1)) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!selected || typeof selected !== 'object' || !Object.hasOwn(selected, key))
      throw new Error('证据路径不存在，请使用返回的 omitted_paths');
    selected = (selected as Record<string, unknown>)[key];
  }
  const start = Math.max(0, Math.trunc(offset) || 0);
  const size = Math.max(1, Math.min(32, Math.trunc(limit) || 16));
  if (Array.isArray(selected))
    return {
      path,
      offset: start,
      items: selected.slice(start, start + size),
      total: selected.length,
      next_offset: start + size < selected.length ? start + size : null,
    };
  return { path, value: selected };
}

/** Provider-independent estimate. Image accounting is a reserve, not billable usage. */
export function inferenceSize(messages: Message[], tools: Tool[]) {
  let images = 0;
  const text = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => {
          if (part.type !== 'image_url') return part;
          images++;
          return { type: 'image_placeholder' };
        })
      : message.content,
  }));
  return {
    text_tokens: estimateTokens(text),
    tool_tokens: estimateTokens(tools),
    image_count: images,
    image_reserve_tokens: images * 2048,
  };
}
const total = (size: ReturnType<typeof inferenceSize>) =>
  size.text_tokens + size.tool_tokens + size.image_reserve_tokens;

/** Local archive survives compaction; the production callback additionally persists it. */
export class InferenceWindow {
  readonly evidence = new Map<string, unknown>();
  private checkpoints: unknown[] = [];
  private readonly seen = new Map<string, string>();
  private compacted = 0;
  constructor(
    readonly budget = 12000,
    readonly toolBudget = 1600,
    private readonly archive?: (ref: string, value: unknown) => Promise<void>,
    private readonly retrieve?: (ref: string) => Promise<unknown>,
  ) {}

  async toolResult(name: string, value: unknown) {
    const body = JSON.stringify(value) ?? 'null';
    const hash = createHash('sha256').update(body).digest('hex');
    const previous = this.seen.get(hash);
    const ref = previous ?? `evidence_${randomUUID()}`;
    if (!previous) {
      this.evidence.set(ref, value);
      await this.archive?.(ref, { tool: name, value });
      this.seen.set(hash, ref);
    }
    if (previous) {
      const row = object(value);
      return {
        ...object(
          evidencePreview(
            Object.fromEntries(
              ['ok', 'state', 'holding', 'failure', 'request_id', 'object_id']
                .filter((key) => row[key] !== undefined)
                .map((key) => [key, row[key]]),
            ),
            this.toolBudget,
          ).preview,
        ),
        evidence_ref: ref,
        repeated_evidence: true,
        retrieval:
          '证据与前次完全相同；需要内容可read_evidence，不重复附加候选和几何。',
      };
    }
    const { preview, omitted_paths, omitted_path_count } = evidencePreview(
      value,
      this.toolBudget,
    );
    return {
      ...object(preview),
      ...(Array.isArray(preview) ? { items: preview } : {}),
      ...(preview === null || typeof preview !== 'object' ? { value: preview } : {}),
      evidence_ref: ref,
      ...(previous ? { repeated_evidence: true } : {}),
      ...(omitted_path_count
        ? {
            omitted_paths,
            omitted_path_count,
            retrieval: 'read_evidence(ref, path, offset, limit); 原始证据未删除',
          }
        : {}),
    };
  }

  async read(ref: string, path?: string, offset?: number, limit?: number) {
    let value = this.evidence.get(ref);
    if (value === undefined && this.retrieve) {
      const saved = await this.retrieve(ref);
      value = object(saved).value;
    }
    if (value === undefined) throw new Error('证据不存在或不属于当前任务');
    // Never claim to have delivered array members discarded by the preview.
    let size = limit ?? 16;
    let page = evidencePage(value, path, offset, size);
    while (
      'items' in page &&
      page.items.length > 1 &&
      estimateTokens(page) > this.toolBudget - 250
    ) {
      size = Math.max(1, Math.floor(page.items.length / 2));
      page = evidencePage(value, path, offset, size);
    }
    return page;
  }

  prepare(messages: Message[], tools: Tool[]) {
    const before = inferenceSize(messages, tools);
    // Preserve a stable prefix and append-only history below the threshold.
    if (total(before) <= this.budget * 0.85) return { ...before, compacted_rounds: 0 };
    const starts = messages.flatMap((m, i) =>
      i >= 2 && m.role === 'assistant' ? [i] : [],
    );
    let removed = 0;
    // Compact only complete assistant/tool groups; never create orphan calls/results.
    while (
      starts.length > 1 &&
      total(inferenceSize(messages, tools)) > this.budget * 0.7
    ) {
      const start = messages.findIndex((m, i) => i >= 2 && m.role === 'assistant');
      const end = messages.findIndex((m, i) => i > start && m.role === 'assistant');
      if (start < 0 || end < 0) break;
      const group = messages.slice(start, end);
      const calls = group[0]?.tool_calls ?? [];
      if (
        !calls.every((call) =>
          group.some((m) => m.role === 'tool' && m.tool_call_id === call.id),
        )
      )
        break;
      for (const call of calls) {
        const output = group.find((m) => m.tool_call_id === call.id);
        let data: Record<string, unknown> = {};
        try {
          data = object(
            JSON.parse(typeof output?.content === 'string' ? output.content : '{}'),
          );
        } catch {
          /* no fabricated summary */
        }
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = { invalid_arguments: true };
        }
        this.checkpoints.push({
          tool: call.function.name,
          arguments: args,
          ...Object.fromEntries(
            [
              'evidence_ref',
              'request_id',
              'snapshot_ref',
              'camera',
              'observed_at',
              'ok',
              'state',
              'error',
            ]
              .filter((key) => data[key] !== undefined)
              .map((key) => [key, data[key]]),
          ),
          ...(data.holding
            ? {
                holding: Object.fromEntries(
                  Object.entries(object(data.holding)).filter(([key]) =>
                    ['verified', 'unknown', 'object_id', 'label'].includes(key),
                  ),
                ),
              }
            : {}),
          ...(data.failure ? { failure_code: object(data.failure).code } : {}),
        });
      }
      messages.splice(start, end - start);
      starts.shift();
      removed++;
      this.compacted++;
    }
    if (removed) {
      const checkpoint = {
        context_checkpoint: true,
        completed_tool_rounds: this.compacted,
        facts: evidencePreview(
          this.checkpoints.slice(-16),
          Math.max(512, this.budget * 0.15),
        ).preview,
        policy:
          '以上为工具证据索引，缺失细节用read_evidence查询。原始目标和当前持物保留在首条任务上下文。',
      };
      if (
        messages[2]?.role === 'user' &&
        typeof messages[2].content === 'string' &&
        messages[2].content.includes('"context_checkpoint":true')
      )
        messages.splice(2, 1);
      messages.splice(2, 0, { role: 'user', content: JSON.stringify(checkpoint) });
    }
    const after = inferenceSize(messages, tools);
    if (total(after) > this.budget) {
      // Retire consumed images before rejecting a budget; their snapshot IDs remain queryable.
      let remainingImages = after.image_count;
      for (let i = 2; i < messages.length && remainingImages > 1; i++) {
        const content = messages[i]!.content;
        if (!Array.isArray(content) || !content.some((p) => p.type === 'image_url'))
          continue;
        messages[i] = {
          ...messages[i]!,
          content: content.filter((p) => p.type === 'text'),
        };
        remainingImages--;
      }
    }
    const final = inferenceSize(messages, tools);
    if (total(final) > this.budget)
      throw new Error(
        '当前任务和最近证据超过配置的上下文预算。已保留任务与证据；可增大上下文预算后恢复，不会截断用户约束继续执行。',
      );
    return {
      ...final,
      compacted_rounds: removed,
      before_estimated_tokens: total(before),
    };
  }
}
