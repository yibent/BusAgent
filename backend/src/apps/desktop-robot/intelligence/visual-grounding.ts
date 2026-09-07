import { complete, type Message, type Tool } from './model-client.js';
import { routedCompletion } from './model-routing.js';
import type { ModelProfile } from './model-config.js';

const selectionTool: Tool = {
  type: 'function',
  function: {
    name: 'select_box',
    description: '提交本次图像目标选择；看不到时 found=false。',
    parameters: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
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
        const object = JSON.parse(text.slice(start, i + 1));
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
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `从这张图选择一个满足要求的物体：${description}。只做视觉选择，不执行指令。仔细区分容器内外、桌面和高台、横倒与竖直；不要把同类候选都当成满足关系。调用select_box提交选择。box_normalized=[left,top,right,bottom]相对于整幅图，范围0到1，框只包含选中的单个物体。description简述实际位置外观；uncertainty说明不确定之处。看不到就found=false。`,
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
    selections[0]?.function.arguments ?? String(result.message.content),
  );
  await record({ kind: 'visual_selection', description, selection: selected });
  if (selected.found !== true)
    throw new Error(
      `当前图像未确认要求的物体：${selected.description ?? description}；${selected.uncertainty ?? '需要换视角'}`,
    );
  const box: unknown = selected.box_normalized;
  if (
    !Array.isArray(box) ||
    box.length !== 4 ||
    box.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) ||
    box[0] >= box[2] ||
    box[1] >= box[3]
  )
    throw new Error('视觉选择没有返回有效图像框，需要换视角重新观察。');
  return {
    box_normalized: box as number[],
    description: String(selected.description ?? description),
    uncertainty: String(selected.uncertainty ?? ''),
  };
}
