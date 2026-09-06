/** Read-only, bounded context for the interaction lane; never invokes /api/command. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export function summarizeCapabilities(value: unknown): string {
  const capabilities = record(value);
  if (!Array.isArray(capabilities.skills)) return '暂时无法确认控制器能力。';
  const skills = new Set(
    capabilities.skills.filter((s): s is string => typeof s === 'string'),
  );
  const groups: string[] = [];
  if (skills.has('perceive')) groups.push('识别物体');
  if (skills.has('move_joint') || skills.has('move_cartesian'))
    groups.push('移动机械臂');
  if (skills.has('home')) groups.push('复位');
  if (skills.has('gripper')) groups.push('夹爪开合');
  if (skills.has('hold') || skills.has('stop')) groups.push('暂停');
  if (skills.has('grasp')) groups.push('单物体抓取与抬升验证');
  if (skills.has('pick_place')) groups.push('Panda抓取、放置与稳定性评测');
  const grasp = record(capabilities.grasp);
  if (skills.has('grasp') && grasp.dual_camera_default === true)
    groups.push('默认双相机辅助');
  if (skills.has('grasp') && grasp.retry_via_dialogue === true)
    groups.push('对话确认后恢复抓取');
  const support = groups.length ? `支持${groups.join('、')}。` : '当前无可用基础动作。';
  return (
    support +
    (!skills.has('grasp') ? '抓取未接入。' : '') +
    (!skills.has('place') && !skills.has('pick_place') ? '放置未实现。' : '')
  );
}

export function summarizeMotion(value: unknown, following = false): string {
  const motion = record(value);
  const last = record(motion.last_command);
  if (motion.simulation_playing === false)
    return '仿真已暂停，不能声称机械臂正在运动。';
  if (motion.active_command_id && last.skill === 'grasp')
    return typeof last.message === 'string'
      ? last.message
      : '抓取正在处理，尚未确认成功。';
  if (motion.mode === 'moving') return '机械臂正在执行动作，尚未确认到位。';
  if (motion.active_command_id) return '控制器已接收动作，等待仿真执行。';
  if (following) return '目标跟随已启用，是否到位尚未确认。';
  const current =
    motion.mode === 'hold'
      ? '当前保持位置'
      : motion.mode === 'idle'
        ? '当前空闲'
        : '当前运动状态未知';
  if (last.state === 'completed')
    return `${current}；上次${last.skill === 'home' ? '复位' : '动作'}已完成。`;
  if (last.state === 'failed') return `${current}；上次动作失败。`;
  if (last.state === 'cancelled') return `${current}；上次动作已中断。`;
  return `${current}。`;
}

/** Whitelist semantic evidence only; never copy raw camera/model payloads. */
export function summarizeVision(
  status: Record<string, unknown>,
): Record<string, unknown> {
  const observation = record(status.vision);
  const views = Array.isArray(observation.views) ? observation.views.map(record) : [];
  return {
    source: 'last_target_observation',
    available: typeof observation.request_id === 'string',
    target: typeof observation.label === 'string' ? observation.label : undefined,
    result:
      observation.ok === true
        ? 'observed'
        : observation.ok === false
          ? 'observation_failed'
          : 'unknown',
    request_id: observation.request_id,
    views: views.map((view) => ({
      camera: view.camera,
      status: view.status,
      sequence: view.sequence,
    })),
    current_sequence: status.sequence,
    exhaustive_inventory: false,
    interpretation:
      '这是最近一次指定目标的观测，不是实时全场景物体清单。无记录、失败或未提及某物体均不能证明它不存在。配置目录和放置目标不受支持的报错不是视觉证据；不得把历史回复当作当前检测结果。',
  };
}

export async function readInteractionSnapshot(
  config: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const url =
    typeof config.controller_url === 'string'
      ? config.controller_url
      : 'http://127.0.0.1:7861';
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(250)]),
    });
    if (!response.ok) throw new Error('status unavailable');
    const status = record(await response.json());
    const motion = record(status.motion);
    const last = record(motion.last_command);
    const capabilities = record(status.capabilities);
    return {
      available: true,
      observed_at: new Date().toISOString(),
      capability_summary: summarizeCapabilities(capabilities),
      status_summary: summarizeMotion(motion, status.follow_enabled === true),
      supported_skills: capabilities.skills,
      unsupported_skills: capabilities.unsupported,
      grasp_capabilities: capabilities.grasp,
      grasp_status: status.grasp,
      visual_evidence: summarizeVision(status),
      robot_state: {
        mode: motion.mode,
        active_command_id: motion.active_command_id,
        simulation_playing: motion.simulation_playing,
        sampled_at: motion.sampled_at,
        joint_positions_deg: motion.joint_positions_deg,
        can_resume: motion.can_resume,
        last_command: { skill: last.skill, state: last.state, message: last.message },
      },
      following: status.follow_enabled,
      error: status.error,
    };
  } catch {
    return {
      available: false,
      message: '控制器状态暂不可用，不能确认当前能力或动作结果。',
    };
  }
}
