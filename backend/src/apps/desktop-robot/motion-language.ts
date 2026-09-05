import type { ParsedInstruction } from './instruction-types.js';

const DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
export function normalizeNumbers(text: string): string {
  return text.replace(
    /负?[零〇一二两三四五六七八九十百]+(?:点[零〇一二两三四五六七八九]+)?/g,
    (raw) => {
      const negative = raw.startsWith('负');
      const [integer = '', fraction] = raw.replace(/^负/, '').split('点');
      let sum = 0,
        digit = 0;
      for (const char of integer) {
        if (char === '百' || char === '十') {
          sum += (digit || 1) * (char === '百' ? 100 : 10);
          digit = 0;
        } else digit = digit * 10 + (DIGITS[char] ?? 0);
      }
      return String(
        (sum +
          digit +
          (fraction
            ? Number('0.' + [...fraction].map((c) => DIGITS[c] ?? 0).join(''))
            : 0)) *
          (negative ? -1 : 1),
      );
    },
  );
}
const JOINTS: Array<[RegExp, string]> = [
  [/shoulder_pan|底座|基座|第?1(?:个)?关节/i, 'shoulder_pan'],
  [/shoulder_lift|肩关节|第?2(?:个)?关节/i, 'shoulder_lift'],
  [/elbow_flex|肘关节|第?3(?:个)?关节/i, 'elbow_flex'],
  [/wrist_flex|腕部俯仰|腕俯仰|第?4(?:个)?关节/i, 'wrist_flex'],
  [/wrist_roll|腕部|手腕|第?5(?:个)?关节/i, 'wrist_roll'],
];
const NUMBER = '(-?\\d+(?:\\.\\d+)?)';

export function motionLanguage(
  source: string,
): Pick<
  ParsedInstruction,
  'intent' | 'motion' | 'needs_clarification' | 'clarification_question'
> | null {
  const text = normalizeNumbers(source.replaceAll('百分之', 'percent:')).toLowerCase();
  const make = (
    skill: string,
    params: Record<string, unknown>,
    question: string | null = null,
  ) => ({
    intent: 'motion' as const,
    motion: { skill, params },
    needs_clarification: question !== null,
    clarification_question: question,
  });
  if (/归位|回零|回到初始|回初始|home/.test(text)) return make('home', {});
  if (/继续|恢复动作|resume/.test(text) && !/跟随|跟踪/.test(text))
    return make('resume', {});
  if (/速度|调速|慢一点|快一点/.test(source)) {
    const value = /慢一点/.test(source)
      ? 10
      : /快一点/.test(source)
        ? 40
        : Number(new RegExp(NUMBER + '\\s*度').exec(text)?.[1]);
    return make(
      'set_speed',
      { degrees_per_second: value },
      Number.isFinite(value)
        ? null
        : '请说明运动速度，例如每秒20度，范围为1到60度每秒。',
    );
  }
  if (
    /夹爪|张开|闭合|松开|夹紧/.test(text) &&
    /打开|张开|闭合|关闭|松开|夹紧|开度/.test(text)
  ) {
    const value = /开度/.test(text)
      ? Number(
          /(\d+(?:\.\d+)?)\s*%/.exec(text)?.[1] ??
            /percent:\s*(\d+(?:\.\d+)?)/.exec(text)?.[1],
        ) / 100
      : /张开|打开|松开/.test(text)
        ? 1
        : 0;
    return make(
      'gripper',
      { opening: value },
      Number.isFinite(value) ? null : '请说明夹爪开度百分比，例如夹爪开度50%。',
    );
  }
  const joint = JOINTS.find(([pattern]) =>
    pattern.test(text.replace(/基座坐标/g, '坐标')),
  )?.[1];
  if (/旋转|转动|转到|转\s*-?\d|顺时针|逆时针|关节|底座|手腕|腕部/.test(text)) {
    const amount = new RegExp(NUMBER + '\\s*度').exec(text)?.[1];
    const ccw = /逆时针/.test(text);
    const cw = !ccw && /顺时针/.test(text);
    const absolute = /转到|设为|设置为|角度为/.test(text);
    const raw = amount === undefined ? undefined : Number(amount);
    // shoulder_pan's URDF axis points down in this asset.
    const sign = joint === 'shoulder_pan' ? (cw ? 1 : -1) : cw ? -1 : 1;
    const degrees =
      raw === undefined ? undefined : cw || ccw ? Math.abs(raw) * sign : raw;
    if (joint)
      return make(
        'move_joint',
        { joint, degrees, absolute },
        raw === undefined
          ? '请说明角度，例如底座顺时针转30度，或第二关节转到负20度。'
          : null,
      );
    const axis = /([xyz])\s*轴/.exec(text)?.[1];
    const frame = /工具|自身|局部/.test(text)
      ? 'tool'
      : /基座坐标|机器人坐标/.test(text)
        ? 'base'
        : 'world';
    return make(
      'rotate',
      { axis, degrees, frame },
      raw === undefined
        ? '请说明末端旋转角度，例如90度。'
        : !axis
          ? '请说明旋转轴，例如绕Z轴；若要转底座或手腕，请直接说明部件。'
          : !cw && !ccw && !/负|正|[-+]\d/.test(source)
            ? '请说明顺时针或逆时针。默认从旋转轴正方向看向原点。'
            : null,
    );
  }
  if (
    /移动|平移|抬高|抬起|下降|上移|下移|左移|右移|前移|后移|移到|坐标|(?:向|往)[上下左右前后]/.test(
      text,
    )
  ) {
    const frame = /工具|自身|局部/.test(text)
      ? 'tool'
      : /基座坐标|机器人坐标/.test(text)
        ? 'base'
        : 'world';
    const coordinates = new RegExp(
      'x\\s*[:=：]?\\s*' +
        NUMBER +
        '[\\s,，]+y\\s*[:=：]?\\s*' +
        NUMBER +
        '[\\s,，]+z\\s*[:=：]?\\s*' +
        NUMBER,
    ).exec(text);
    const scale = /毫米|mm/.test(text)
      ? 0.001
      : /厘米|cm/.test(text)
        ? 0.01
        : /米|\bm\b/.test(text)
          ? 1
          : undefined;
    if (coordinates)
      return make(
        'move_cartesian',
        {
          frame,
          absolute: true,
          xyz_m: coordinates.slice(1, 4).map((v) => Number(v) * (scale ?? 1)),
        },
        scale === undefined ? '请说明坐标单位：米、厘米还是毫米。' : null,
      );
    const amount = new RegExp(NUMBER + '\\s*(毫米|厘米|米|mm|cm|m)').exec(text);
    const direction = /(?:沿|绕|向)?\s*([xyz])\s*轴\s*(正|负)?/.exec(text);
    let axis = direction?.[1];
    let sign = direction?.[2] === '负' ? -1 : 1;
    if (/抬高|抬起|上移|向上|往上|升高/.test(text)) axis = 'z';
    if (/下降|下移|向下|往下|降低/.test(text)) {
      axis = 'z';
      sign = -1;
    }
    if (/左移|向左|往左/.test(text)) axis = 'y';
    if (/右移|向右|往右/.test(text)) {
      axis = 'y';
      sign = -1;
    }
    if (/前移|向前|往前/.test(text)) axis = 'x';
    if (/后移|向后|往后/.test(text)) {
      axis = 'x';
      sign = -1;
    }
    const vector = [0, 0, 0];
    if (axis && amount)
      vector['xyz'.indexOf(axis)] = Number(amount[1]) * (scale ?? 1) * sign;
    return make(
      'move_cartesian',
      { frame, absolute: false, xyz_m: vector },
      !axis
        ? '请说明移动方向或XYZ坐标。默认世界坐标：前后为X，左右为Y，上下为Z。'
        : !amount
          ? '请说明移动距离和单位，例如向上移动2厘米。'
          : null,
    );
  }
  return null;
}
export function isMotionSupplement(text: string): boolean {
  return /^(?:嗯|呃|请|就|是|绕|沿|向|往|顺时针|逆时针|世界|基座|工具|自身|[xyzXYZ]|[-+\d零一二两三四五六七八九十百负正]|厘米|毫米|米|度)/.test(
    text.trim(),
  );
}
