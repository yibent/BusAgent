/** One wire contract for both planner entry points and Arena manipulation. */
const selector = {
  anyOf: [
    { type: 'string', description: '英文类别标签，或完整的 obs: 物体引用。' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string' },
        ref: { type: 'string' },
        cell_ref: {
          type: 'string',
          description:
            '真实格位的ref或跨观察cell_id（grid:...:行:列），不能把格位当作待抓物体。',
          pattern:
            '^(obs:[a-f0-9]{32}:(scene_camera|side_camera|wrist_camera):[0-9]+|grid:[a-f0-9]{32}:[0-9]+:[0-9]+)$',
        },
        region_ref: { type: 'string' },
        selection: { type: 'string', enum: ['auto', 'center', 'free_space', 'any'] },
        instance_selection: { type: 'string', enum: ['any'] },
        preference: {
          type: 'string',
          enum: ['nearest', 'left', 'right', 'near', 'far', 'center', 'compact'],
        },
      },
    },
  ],
};

export const actionParamsJsonSchema = {
  type: 'object',
  additionalProperties: true,
  description:
    '按技能传参，不填写无关字段。抓放的朝向只能放入 orientation 对象，不能写成顶层 axis_ref/endpoint_direction。',
  properties: {
    target: selector,
    destination: selector,
    mode: { type: 'string', enum: ['auto', 'basic', 'enhanced'] },
    relation: { type: 'string', enum: ['on', 'inside'] },
    unfamiliar: { type: 'boolean' },
    cluttered: { type: 'boolean' },
    precise: { type: 'boolean' },
    orientation: {
      type: 'object',
      additionalProperties: false,
      description:
        '来自 inspect_object 的实际 axis_ref；endpoint 的语义必须用对应观察图辨认，抓取前即传入。',
      properties: {
        axis_ref: { type: 'string' },
        endpoint: { type: 'integer', minimum: 0, maximum: 1 },
        direction: { type: 'string', enum: ['up', 'down'] },
      },
      required: ['axis_ref', 'endpoint', 'direction'],
    },
  },
};

const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

export function normalizeActionParams(skill: string, raw: Record<string, unknown>) {
  if (!['grasp', 'pick_place', 'place_held'].includes(skill)) return raw;
  const params = Object.fromEntries(Object.entries(raw).filter(([, v]) => v != null));
  for (const field of skill === 'grasp'
    ? ['target']
    : skill === 'place_held'
      ? ['destination']
      : ['target', 'destination']) {
    const value = params[field];
    if (
      !(typeof value === 'string' && value.trim()) &&
      !['label', 'ref', 'cell_ref', 'region_ref'].some(
        (key) =>
          typeof object(value)[key] === 'string' && String(object(value)[key]).trim(),
      )
    )
      throw new Error(
        `${skill} requires a ${field} label or reference; selection alone does not identify an object.`,
      );
  }
  for (const field of ['target', 'destination']) {
    const value = params[field];
    if (typeof value === 'string' && value.startsWith('obs:'))
      params[field] = { ref: value };
  }
  const dest = object(params.destination);
  if (dest.relation !== undefined) {
    if (params.relation !== undefined && params.relation !== dest.relation)
      throw new Error('放置 relation 存在互相冲突的取值。');
    params.relation = dest.relation;
    params.destination = Object.fromEntries(
      Object.entries(dest).filter(([key]) => key !== 'relation'),
    );
  }
  // Accept previously emitted, unambiguous spellings; never discard a requested
  // orientation or invent an endpoint when only an axis was supplied.
  const orientation = { ...object(params.orientation) };
  for (const [canonical, aliases] of [
    ['axis_ref', ['axis_ref', 'orientation_axis_ref']],
    ['endpoint', ['endpoint', 'endpoint_index']],
    ['direction', ['endpoint_direction']],
  ] as const) {
    for (const alias of aliases) {
      if (params[alias] === undefined) continue;
      if (
        orientation[canonical] !== undefined &&
        orientation[canonical] !== params[alias]
      )
        throw new Error(`orientation.${canonical} 存在互相冲突的取值。`);
      orientation[canonical] = params[alias];
      delete params[alias];
    }
  }
  if (Object.keys(orientation).length) {
    if (
      typeof orientation.axis_ref !== 'string' ||
      ![0, 1].includes(Number(orientation.endpoint)) ||
      typeof orientation.endpoint !== 'number' ||
      !['up', 'down'].includes(String(orientation.direction))
    )
      throw new Error(
        '朝向需要完整 orientation={axis_ref,endpoint:0或1,direction:"up"或"down"}；先用同次观察图辨认端点，再提交。',
      );
    params.orientation = orientation;
  }
  const allowed = new Set([
    'target',
    'destination',
    'mode',
    'relation',
    'orientation',
    'unfamiliar',
    'cluttered',
    'precise',
  ]);
  const unsupported = Object.keys(params).filter((key) => !allowed.has(key));
  if (unsupported.length)
    throw new Error(
      `抓放技能不接受参数 ${unsupported.join(', ')}；请按提供的参数契约表达要求，不能把它当作已经传递的动作条件。`,
    );
  return params;
}
