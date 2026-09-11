import { complete, type Message, type Tool } from './model-client.js';
import { routedCompletion } from './model-routing.js';
import type { ModelProfile } from './model-config.js';
import { groundingMode } from './agent-prompts.js';

const selectionTool: Tool = {
  type: 'function',
  function: {
    name: 'select_box',
    description: '提交本次图像目标选择；看不到时 found=false。',
    parameters: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        box_2d: {
          type: 'array',
          description: 'Gemini原生坐标：[ymin,xmin,ymax,xmax]，整幅图归一化至0..1000。',
          items: { type: 'number', minimum: 0, maximum: 1000 },
          minItems: 4,
          maxItems: 4,
        },
        box_normalized: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
        },
        description: { type: 'string' },
        uncertainty: { type: 'string' },
      },
      required: ['found', 'description', 'uncertainty'],
      additionalProperties: false,
    },
  },
};

/** Accept a JSON object in a fenced/prose reply without inventing coordinates. */
function parseSelection(text: string) {
  const objects: Record<string, unknown>[] = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (c === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const object = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        if (typeof object.found === 'boolean') objects.push(object);
      } catch {
        /* Invalid JSON is not a selection. */
      }
      start = -1;
    }
  }
  if (objects.length !== 1) throw new Error('视觉回复没有唯一有效的结构化选框。');
  return objects[0]!;
}

/** A small visual selection request, separate from long task/queue history. */
export async function selectImageObject(
  profiles: ModelProfile[],
  image: Buffer,
  description: string,
  signal: AbortSignal,
  record: (event: Record<string, unknown>) => Promise<void>,
  call = complete,
) {
  if (groundingMode() === 'truth')
    throw new Error('Isaac Sim 真值模式禁止 Gemini 图像框选；请仅提供物品标签。');
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `从这张图选择一个满足要求的物体：${description}。只做视觉选择，不执行指令。仔细区分容器内外、桌面和高台、横倒与竖直；不要把同类候选都当成满足关系。调用select_box提交选择。优先使用Gemini原生box_2d=[ymin,xmin,ymax,xmax]，坐标相对于整幅图归一化到0..1000；兼容字段box_normalized=[left,top,right,bottom]范围0..1。只返回一种坐标，框只包含选中的单个物体。不输出掩码，由本地SAM2精化。description简述实际位置外观；uncertainty说明不确定之处。看不到就found=false。`,
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` },
        },
      ],
    },
  ];
  const result = await routedCompletion(
    profiles,
    messages,
    [selectionTool],
    signal,
    record,
    call,
    new Set(),
    { maxTokens: 1536 },
  );
  await record({
    kind: 'model',
    role: 'visual_selector',
    model: result.model,
    usage: result.usage,
    elapsed_ms: result.elapsed_ms,
  });
  const selections =
    result.message.tool_calls?.filter((t) => t.function.name === 'select_box') ?? [];
  if (selections.length > 1)
    throw new Error('视觉回复选择了多个目标，需要明确单个对象。');
  const selected = parseSelection(
    selections[0]?.function.arguments ??
      (typeof result.message.content === 'string' ? result.message.content : ''),
  );
  await record({ kind: 'visual_selection', description, selection: selected });
  const selectedDescription =
    typeof selected.description === 'string' ? selected.description : description;
  const uncertainty =
    typeof selected.uncertainty === 'string' ? selected.uncertainty : '';
  if (selected.found !== true)
    throw new Error(
      `当前图像未确认要求的物体：${selectedDescription}；${uncertainty || '需要换视角'}`,
    );
  const box = normalizeSelectionBox(selected);
  return {
    box_normalized: box,
    description: selectedDescription,
    uncertainty,
  };
}

/** Coordinate systems are explicit: never guess pixels vs normalized coordinates. */
export function normalizeSelectionBox(selected: Record<string, unknown>): number[] {
  function valid(value: unknown, maximum: number): value is number[] {
    return (
      Array.isArray(value) &&
      value.length === 4 &&
      value.every(
        (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= maximum,
      ) &&
      value[0] < value[2] &&
      value[1] < value[3]
    );
  }
  const native = selected.box_2d;
  const normalized = selected.box_normalized;
  if (native !== undefined) {
    if (!valid(native, 1000)) throw new Error('Gemini返回的box_2d无效，需要重新观察。');
    const box = [
      native[1]! / 1000,
      native[0]! / 1000,
      native[3]! / 1000,
      native[2]! / 1000,
    ];
    if (
      normalized !== undefined &&
      (!valid(normalized, 1) ||
        box.some((x, i) => Math.abs(x - normalized[i]!) > 0.002))
    )
      throw new Error('视觉回复包含不一致的坐标系，需要重新观察。');
    return box;
  }
  if (!valid(normalized, 1))
    throw new Error('视觉选择没有返回有效图像框，需要换视角重新观察。');
  return normalized;
}
