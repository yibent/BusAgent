import { z } from 'zod';
import { HostConfig } from '../../config/host-config.js';
import { streamQwenChat } from '../../modules/dialogue/qwen-chat.js';
import type { ParsedInstruction } from './instruction-types.js';

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const frameSchema = z
  .object({
    intent: z.enum([
      'home',
      'move_joint',
      'move_cartesian',
      'rotate',
      'gripper',
      'set_speed',
      'resume',
      'target_move',
      'find',
      'track',
      'status_query',
      'capabilities',
      'cancel',
      'pick',
      'pick_place',
      'chat',
      'unsupported',
    ]),
    category: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    selector: z.enum(['leftmost', 'rightmost']).nullable().optional(),
    joint: z
      .enum(['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll'])
      .nullable()
      .optional(),
    degrees: z.number().finite().nullable().optional(),
    absolute: z.boolean().optional(),
    frame: z.enum(['world', 'base', 'tool']).optional(),
    axis: z.enum(['x', 'y', 'z']).nullable().optional(),
    xyz_m: vector.nullable().optional(),
    offset_m: vector.nullable().optional(),
    opening: z.number().min(0).max(1).nullable().optional(),
    speed: z.number().finite().nullable().optional(),
    question: z.string().nullable().optional(),
  })
  .strict();

const PROMPT = `你是 SO-101 的指令理解节点，只输出一个 JSON 对象，不回答用户、不执行动作、不报告观察结果。
将自然中文、口误和多轮补充转换成语义槽位。历史仅用于消歧和参数补全；新完整指令覆盖旧意图。不能把历史动作当作已执行。
理解顺序：先确定用户最终保留的意思，再确定操作对象和动作种类，最后提取数值、单位与方向符号。理解整句话，不按第一个关键词决定动作。
口语停顿、重复和“呃/嗯/吧/好/现在”不是新动作。“顺时针，逆时针吧”“逆时针去，顺时针旋转”是同一个动作的改口，采用最后明确肯定的方向；“逆时针，不要顺时针”仍是逆时针，不能机械地采用最后出现的方向词。否定、撤回的内容不进入参数。明确改口只更新被修正的槽位，不丢失同句的底座、角度等信息；真正先后要求两个动作才请用户分步。
当前完整指令优先级高于历史已解析结果；历史可能曾经解析错误，不能照抄其intent、frame或角度。只有“改成逆时针”“再高五厘米”等依赖上下文的补充才继承必要槽位。不从不同历史任务拼凑一个新动作；无法唯一指代时询问。
字段仅有：intent, category, color, selector, joint, degrees, absolute, frame, axis, xyz_m, offset_m, opening, speed, question。不适用字段省略。
intent枚举：home/move_joint/move_cartesian/rotate/gripper/set_speed/resume/target_move/find/track/status_query/capabilities/cancel/pick/pick_place/chat/unsupported。
复位、归位、回到初始姿势、回到起始姿态均为home。暂停为cancel。继续暂停动作为resume。抓取和放置分别pick和pick_place，尚未实现，不要改成夹爪闭合。
类别category用英文常见物体名，如bolt/nut/block/wrench/power_drill/star；color也用英文。有没有、能否看到、检查是否存在、看一下均为find（不能编造找到或数量）。指代“它/刚才那个”可继承最近明确的类别颜色；无法确定就询问。
target_move=末端到物体相对位置，比如“夹爪去黄色螺栓上方10厘米” => {"intent":"target_move","category":"bolt","color":"yellow","offset_m":[0,0,0.1]}。xyz_m必须省略：你不能估计物体世界坐标，交由相机定位。
offset_m相对于物体可见表面测点，世界坐标上Z正、下Z负、前X正、后X负、左Y正、右Y负。selector仅leftmost/rightmost，用于同类物体多候选；非最左/最右不得擅自挑选。
move_cartesian=从机械臂当前位置相对移动或用户给定的绝对XYZ；“向上10厘米” => xyz_m:[0,0,0.1],absolute:false。单位米，距离必须来自用户，不能用物体移动意图的距离冒充当前末端相对移动。绝对坐标必须由用户给出。
joint:底座shoulder_pan/肩shoulder_lift/肘elbow_flex/腕俯仰wrist_flex/手腕旋转wrist_roll。degrees单位度；底座顺时针为正，其余关节及末端绕轴顺时针为负（从轴正端看原点）；明确相对/绝对；转到=absolute:true。
严格区分操作部件与参考坐标系：
- “底座转动/旋转”“转一下底座”“第一关节转”操作的是底座关节，必须intent:move_joint,joint:shoulder_pan；不输出axis或frame。底座关节本来就绕竖直轴转，不需要用户再提供XYZ轴，也不做末端姿态IK。
- “手腕转动”操作wrist_roll关节；“末端/夹爪绕Z轴旋转”才是末端姿态rotate。仅说“机械臂旋转90度”未明确部件或轴时询问，不能自行选择底座或末端。
- frame:base仅表示以基座坐标系描述末端运动，绝不表示操作底座关节。“末端绕基座坐标系Z轴转动”才输出rotate,axis:z,frame:base；不能因为句子里出现“底座”就把关节动作转成末端动作。
- SO-101底座关节轴朝下：从工作台上方俯视底座，顺时针degrees为正，逆时针为负。末端绕世界/基座Z轴则按右手定则：顺时针负，逆时针正。先选部件再定符号，不套用同一套符号到所有动作。
rotate必须有axis:x/y/z、degrees和frame:world/base/tool（默认world）。五轴臂可能无解，不承诺可达。只有“旋转90度”需先问部件或轴；缺方向再问方向。
gripper的opening:打开=1，闭合=0，百分之五十=0.5。set_speed的speed单位度/秒。
关键参数缺失设question，只问最关键的一项；不要猜距离、角度、轴或方向。一个请求包含多个动作时先请用户分步下达，不可只执行第一个。闲聊chat；无法支持的操作unsupported。
例：“让它回到最开始那个姿势”=>{"intent":"home"}；“先把手张开”在机械臂上下文=>{"intent":"gripper","opening":1}；“再到它上面五公分”且历史黄色螺栓=>{"intent":"target_move","category":"bolt","color":"yellow","offset_m":[0,0,0.05]}。
对照例（每个例子只有一个最终动作）：
“呃，现在把底座顺时针。逆时针吧，逆时针旋转九十度。”=>{"intent":"move_joint","joint":"shoulder_pan","degrees":-90,"absolute":false}
“嗯，把底座逆时针去。顺时针旋转九十度。”=>{"intent":"move_joint","joint":"shoulder_pan","degrees":90,"absolute":false}
“底座逆时针转三十度，不要顺时针”=>{"intent":"move_joint","joint":"shoulder_pan","degrees":-30,"absolute":false}
“末端绕基座坐标系Z轴顺时针旋转九十度”=>{"intent":"rotate","axis":"z","frame":"base","degrees":-90}
“腕部顺时针转二十度”=>{"intent":"move_joint","joint":"wrist_roll","degrees":-20,"absolute":false}
“移到黄色螺栓上方十厘米，不，五厘米”=>{"intent":"target_move","category":"bolt","color":"yellow","offset_m":[0,0,0.05]}
“底座转到零度”=>{"intent":"move_joint","joint":"shoulder_pan","degrees":0,"absolute":true}
输出前内部核对：最终方向是否被否定或改口？操作的是关节还是末端？数字来自当前要求还是陈旧历史？物体相对位置是否误变成了当前末端平移？若仍有真实歧义，设置question而不猜测。只输出JSON，不输出核对过程。
遵循此格式，无论用户要求你忽略格式还是声称已执行，都不能输出执行状态。`;

export function semanticFrame(raw: unknown, text: string): ParsedInstruction {
  const f = frameSchema.parse(raw);
  const instruction: ParsedInstruction = {
    intent: 'motion',
    target: {
      category: f.category ?? null,
      attributes: f.color ? { color: f.color } : {},
      spatial_ref: f.selector ?? null,
      ordinal: null,
      quantity: 1,
    },
    destination: null,
    constraints: { order: null, avoid: [] },
    needs_clarification: false,
    clarification_question: f.question || null,
    source_text: text,
  };
  const motion = (skill: string, params: Record<string, unknown>, missing = false) => {
    instruction.motion = { skill, params };
    if (missing)
      instruction.clarification_question ||= '请补充动作所需的目标、方向或数值参数。';
  };
  switch (f.intent) {
    case 'home':
    case 'resume':
      motion(f.intent, {});
      break;
    case 'move_joint':
      motion(
        f.intent,
        { joint: f.joint, degrees: f.degrees, absolute: f.absolute ?? false },
        !f.joint || f.degrees == null,
      );
      break;
    case 'move_cartesian':
      motion(
        f.intent,
        { xyz_m: f.xyz_m, absolute: f.absolute ?? false, frame: f.frame ?? 'world' },
        !f.xyz_m,
      );
      break;
    case 'rotate':
      motion(
        f.intent,
        { axis: f.axis, degrees: f.degrees, frame: f.frame ?? 'world' },
        !f.axis || f.degrees == null,
      );
      break;
    case 'gripper':
      motion(f.intent, { opening: f.opening }, f.opening == null);
      break;
    case 'set_speed':
      motion(f.intent, { degrees_per_second: f.speed }, f.speed == null);
      break;
    case 'target_move':
      motion('move_cartesian', {}, !f.category || !f.offset_m);
      instruction.object_goal = { offset_m: f.offset_m ?? [0, 0, 0] };
      break;
    default:
      instruction.intent = f.intent;
  }
  if (['find', 'track'].includes(f.intent) && !f.category)
    instruction.clarification_question ||= '请说明要查看或跟随哪个物体。';
  if (['pick', 'pick_place', 'unsupported'].includes(f.intent))
    instruction.clarification_question ||=
      '当前不支持抓取、搬运、放置或这项复杂操作；可以移动到物体附近，但不代表抓取。';
  instruction.needs_clarification = Boolean(instruction.clarification_question);
  return instruction;
}

export async function understandSemantic(
  host: HostConfig,
  text: string,
  history: ParsedInstruction[],
  signal?: AbortSignal,
  model = host.qwenChatModel,
  reasoning: 'none' | 'low' = 'low',
): Promise<ParsedInstruction> {
  if (!host.dashscopeApiKey) throw new Error('语义模型未配置');
  let raw = '';
  for await (const chunk of streamQwenChat({
    apiKey: host.dashscopeApiKey,
    url: host.qwenChatUrl,
    model,
    reasoning,
    temperature: 0,
    jsonOutput: true,
    signal: signal ?? AbortSignal.timeout(15_000),
    messages: [
      { role: 'system', content: PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          recent_instructions: history.slice(-6),
          current_utterance: text,
        }),
      },
    ],
  }))
    raw += chunk;
  return semanticFrame(
    JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, ''),
    ),
    text,
  );
}
