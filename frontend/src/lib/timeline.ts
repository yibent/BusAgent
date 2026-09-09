import type { RobotBusEvent } from "@/hooks/useConversation";
export type Track = "information" | "vision" | "motion" | "other";
export type Loop = "fast" | "slow" | "neutral";
export interface TimelineClip {
  id: string;
  title: string;
  agent: string;
  track: Track;
  loop: Loop;
  start: number;
  end?: number;
  state: "running" | "completed" | "failed" | "unknown" | "event";
  taskId?: string;
  triggerId?: string;
  parentId?: string;
  lane: number;
  events: RobotBusEvent[];
  precise: boolean;
}
const titles: Record<string, string> = {
  "intent.created": "收到请求",
  "instruction.parsed": "理解指令",
  "interaction.classified": "识别意图",
  "command.grounded": "确认目标",
  "clarification.requested": "等待补充",
  "plan.proposed": "任务规划",
  "plan.validated": "计划就绪",
  "plan.rejected": "计划未通过",
  "execution.profile.selected": "选择环路",
  "robot.execute.requested": "下发动作",
  "execution.accepted": "接收动作",
  "execution.queued": "动作排队",
  "execution.started": "Panda 执行",
  "execution.progress": "执行进度",
  "execution.completed": "动作完成",
  "execution.failed": "动作失败",
  "execution.cancelled": "动作中断",
  "execution.unknown": "结果待确认",
  "perception.observed": "视觉观测",
  "perception.reported": "视觉结果",
  "reply.created": "生成回复",
  "interrupt.requested": "中断请求",
  "transcript.final": "语音转写",
  "observation.ready": "场景观测",
};
export function agentTitle(agent: string) {
  const names: Record<string, string> = {
    instruction: "指令理解",
    grounding: "目标解析",
    planner: "任务规划",
    planning: "任务规划",
    supervision: "任务监督",
    memory: "会话记忆",
    context_compression: "上下文压缩",
    validator: "计划检查",
    "plan-validator": "计划检查",
    "loop-router": "环路选择",
    coordinator: "执行协调",
    executor: "Panda 执行",
    vision: "视觉处理",
    dialogue: "对话回复",
    stt: "语音转写",
    "interrupt-monitor": "中断监听",
    interrupt_monitor: "中断监听",
    intelligence: "智能规划",
    tts: "语音合成",
  };
  return (
    names[agent.replace(/^(robot|module)\./, "")] ??
    agent.replace(/^(robot|module)\./, "")
  );
}
export function clipTrack(agent: string, eventType = ""): Track {
  if (
    /vision|perception|observation|yolo|sam[23]?|florence|tracking/i.test(
      `${agent} ${eventType}`,
    )
  )
    return "vision";
  if (
    /executor|coordinator|grasp|place|motion|execution\.|robot.execute/.test(
      `${agent} ${eventType}`,
    )
  )
    return "motion";
  if (
    /instruction|grounding|plann|intelligence|supervis|memory|compression|dialogue|llm|reply|intent|conversation/.test(
      `${agent} ${eventType}`,
    )
  )
    return "information";
  return "other";
}
function loopOf(events: RobotBusEvent[]): Loop {
  for (const event of [...events].reverse()) {
    const p = event.payload;
    const profile = p.execution_profile as Record<string, unknown> | undefined;
    const value = `${p.loop ?? p.control_loop ?? p.backend ?? profile?.loop ?? ""}`;
    if (/slow|enhanced|sam3|florence|graspgen|anyplace/i.test(value))
      return "slow";
    if (/fast|basic|yolo|sam2|lk|official/i.test(value)) return "fast";
  }
  return "neutral";
}
export function linkColor(key: string) {
  let hash = 0;
  for (const char of key) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return ["#e5af6b", "#c1a0ec", "#73c7d0", "#e08b9c", "#ccd17c", "#d59dd0"][
    Math.abs(hash) % 6
  ];
}
export function buildTimeline(input: RobotBusEvent[]): TimelineClip[] {
  const events = [...new Map(input.map((e) => [e.id, e])).values()]
    .filter((e) => Number.isFinite(e.createdAt) && !(e.eventType.startsWith("node.") &&
      String(e.payload.trigger_event_type ?? "").startsWith("transcript.")))
    .sort((a, b) => a.createdAt - b.createdAt);
  const clips: TimelineClip[] = [];
  const spans = new Map<string, TimelineClip>();
  const eventById = new Map(events.map((e) => [e.id, e]));
  for (const event of events) {
    if (!event.eventType.startsWith("node.")) continue;
    const spanId = String(event.payload.span_id ?? event.id);
    let clip = spans.get(spanId);
    if (!clip) {
      clip = {
        id: spanId,
        title: agentTitle(event.sourceAgentId),
        agent: event.sourceAgentId,
        track: clipTrack(event.sourceAgentId),
        loop: "neutral",
        start: Number(event.payload.started_at_ms ?? event.createdAt),
        state: "running",
        taskId: event.taskId,
        triggerId: String(event.payload.trigger_event_id ?? ""),
        events: [],
        lane: 0,
        precise: true,
      };
      spans.set(spanId, clip);
      clips.push(clip);
    }
    clip.events.push(event);
    clip.loop = loopOf(clip.events);
    if (["node.completed", "node.failed"].includes(event.eventType)) {
      clip.end = event.createdAt;
      clip.state = event.eventType === "node.failed" ? "failed" : "completed";
    }
  }
  const activeExecution = new Map<string, TimelineClip>();
  const operations = new Map<string, TimelineClip>();
  const visionCommands = new Map<string, TimelineClip>();
  const frames = new Map<string, TimelineClip>();
  for (const event of events) {
    if (event.eventType.startsWith("node.")) continue;
    const p = event.payload;
    const owner = event.sourceSpanId
      ? spans.get(event.sourceSpanId)
      : undefined;
    if (p.operation_id && /^operation_(started|completed|failed)$/.test(String(p.kind))) {
      const id = String(p.operation_id);
      let clip = operations.get(id);
      if (!clip) {
        clip = { id, title: ({ camera_frame: "相机取帧", perception: "视觉定位", grid: "格位几何", axis: "朝向几何", visual_fallback: "视觉语义回退" } as Record<string, string>)[String(p.operation)] ?? "视觉处理",
          agent: event.sourceAgentId, track: "vision", loop: "neutral",
          start: Number(p.started_at_ms ?? event.createdAt), state: "running",
          taskId: event.taskId, parentId: owner?.id, triggerId: event.causationId,
          lane: 0, events: [], precise: true };
        operations.set(id, clip); clips.push(clip);
      }
      clip.events.push(event);
      if (p.kind !== "operation_started") {
        clip.end = Number(p.finished_at_ms ?? event.createdAt);
        clip.state = p.kind === "operation_failed" || p.ok === false ? "failed" : "completed";
        if (p.command_id) visionCommands.set(String(p.command_id), clip);
        if (p.operation === 'camera_frame' && p.request_id) frames.set(String(p.request_id), clip);
      }
      continue;
    }
    if (p.kind === 'image' && frames.has(String(p.snapshot_ref))) {
      frames.get(String(p.snapshot_ref))!.events.push(event);
      continue;
    }
    if (p.kind === "vision_tool" && visionCommands.has(String(p.command_id))) {
      visionCommands.get(String(p.command_id))!.events.push(event);
      continue;
    }
    // A planning span can launch physical work or perception. Keep the actual
    // operation on its own track instead of absorbing it into the parent card.
    const operationEvent = /^execution\.(started|progress|completed|failed|cancelled|unknown)$/.test(event.eventType);
    const visionEvent = /^(perception\.|observation\.)/.test(event.eventType) || p.kind === "vision_tool" || p.kind === "image";
    if (owner && operationEvent && owner.track === "motion" && p.skill === "perceive") {
      owner.track = "vision";
      owner.title = "视觉处理";
    }
    if (owner && operationEvent && owner.track === (p.skill === "perceive" ? "vision" : "motion")) {
      owner.events.push(event);
      owner.loop = loopOf(owner.events);
      continue;
    }
    if (owner && !operationEvent && !visionEvent) {
      owner.events.push(event);
      owner.loop = loopOf(owner.events);
      continue;
    }
    // Older hosts publish event instants, not node durations. Only an explicit
    // execution.started opens a duration; never invent starts for result events.
    const executionKey = `${event.taskId ?? event.correlationId ?? "session"}:${event.payload.command_id ?? ""}`;
    if (event.eventType === "execution.started") {
      const clip: TimelineClip = {
        id: event.id,
        title: String(event.payload.skill ?? "Panda 执行"),
        agent: event.sourceAgentId,
        track: event.payload.skill === "perceive" ? "vision" : "motion",
        loop: loopOf([event]),
        start: event.createdAt,
        state: "running",
        taskId: event.taskId,
        triggerId: event.causationId,
        parentId: owner?.id,
        events: [event],
        lane: 0,
        precise: true,
      };
      activeExecution.set(executionKey, clip);
      clips.push(clip);
      continue;
    }
    if (
      /^execution\.(progress|completed|failed|cancelled|unknown)$/.test(
        event.eventType,
      )
    ) {
      const active = activeExecution.get(executionKey);
      if (active) {
        active.events.push(event);
        active.loop = loopOf(active.events);
        if (event.eventType !== "execution.progress") {
          active.end = event.createdAt;
          active.state = /failed|cancelled/.test(event.eventType)
            ? "failed"
            : /unknown/.test(event.eventType)
              ? "unknown"
              : "completed";
          activeExecution.delete(executionKey);
        }
        continue;
      }
    }
    if (/transcript.delta|speech\.|reply.delta/.test(event.eventType)) continue;
    clips.push({
      id: event.id,
      title: p.kind === "vision_tool" ? "视觉结果" : p.kind === "image" ? "读取图像" : titles[event.eventType] ?? agentTitle(event.sourceAgentId),
      agent: event.sourceAgentId,
      track: visionEvent ? "vision" : clipTrack(event.sourceAgentId, event.eventType),
      loop: loopOf([event]),
      start: event.createdAt,
      end: event.createdAt,
      state: /failed|rejected/.test(event.eventType) ? "failed" : "event",
      taskId: event.taskId,
      triggerId: event.causationId,
      events: [event],
      lane: 0,
      precise: false,
    });
  }
  // Completed delivery spans that emitted no domain event are dispatcher
  // telemetry, not user-visible work. Memory materialization and extractive
  // context views remain queryable in the inspector/event log, but keeping one
  // card per update makes the main execution path look like repeated LLM calls.
  const visibleClips = clips.filter((clip) => {
    if (clip.state === "failed") return true;
    if (/^robot\.(memory|context_compression)$/.test(clip.agent)) return false;
    if (
      clip.agent === "robot.intelligence" &&
      clip.events.every((event) => event.eventType.startsWith("node."))
    )
      return false;
    return true;
  });
  const eventOwner = new Map<string, string>();
  for (const clip of visibleClips)
    for (const e of clip.events) eventOwner.set(e.id, clip.id);
  for (const clip of visibleClips) {
    const trigger = clip.triggerId ? eventById.get(clip.triggerId) : undefined;
    clip.parentId ??=
      trigger?.sourceSpanId ??
      (clip.triggerId ? eventOwner.get(clip.triggerId) : undefined);
    if (clip.parentId === clip.id) clip.parentId = undefined;
  }
  for (const clip of visibleClips) {
    clip.events.sort((a, b) => a.createdAt - b.createdAt);
    clip.loop = loopOf(clip.events);
    if (clip.end !== undefined) continue;
    const disconnect = events.find(
      (e) => e.eventType === "connection.lost" && e.createdAt >= clip.start,
    );
    if (disconnect) {
      clip.end = disconnect.createdAt;
      clip.state = "unknown";
    }
  }
  const ordered = visibleClips.sort((a, b) => a.start - b.start);
  const ends: Record<Track, number[]> = {
    information: [],
    vision: [],
    motion: [],
    other: [],
  };
  for (const clip of ordered) {
    const track = ends[clip.track];
    const lane = track.findIndex((end) => end <= clip.start);
    clip.lane = lane < 0 ? track.length : lane;
    track[clip.lane] =
      clip.end === undefined
        ? Infinity
        : Math.max(clip.end, clip.start + 0.001);
  }
  return ordered;
}
export function timecode(ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}.${Math.floor((seconds % 1) * 10)}`;
}

export interface DisplayClip {
  clip: TimelineClip;
  x: number;
  width: number;
  index: number;
}
/** A shared, non-linear axis: preserve ordering and overlap while making even
 * instant events legible. These coordinates never replace recorded timestamps. */
export function layoutTimeline(clips: TimelineClip[], now: number, scale = 1) {
  const minimum = 140 * scale;
  const origin = clips[0]?.start ?? now;
  const anchors = new Set<number>();
  const endings = new Map<number, { start: number; width: number }[]>();
  const bounds = clips.map((clip) => {
    const start = (clip.start - origin) * 3 + 1;
    const elapsed = Math.max(0, (clip.end ?? now) - clip.start);
    // An instant has a visual end after its start, but no fabricated duration.
    const end = Math.max(
      start + 1,
      ((clip.end ?? Math.max(now, clip.start)) - origin) * 3,
    );
    const width =
      minimum + Math.min(96, 14 * Math.log1p(elapsed / 4000)) * scale;
    anchors.add(start);
    anchors.add(end);
    const constraints = endings.get(end) ?? [];
    constraints.push({ start, width });
    endings.set(end, constraints);
    return { start, end };
  });
  const coordinates = new Map<number, number>();
  let x = 16,
    previous: number | undefined;
  for (const point of [...anchors].sort((a, b) => a - b)) {
    if (previous !== undefined) {
      const gapMs = (point - previous) / 3;
      x += Math.min(24, 8 + 3 * Math.log1p(gapMs / 1000)) * scale;
    }
    for (const constraint of endings.get(point) ?? []) {
      x = Math.max(
        x,
        (coordinates.get(constraint.start) ?? 16) + constraint.width,
      );
    }
    coordinates.set(point, x);
    previous = point;
  }
  const items: DisplayClip[] = clips.map((clip, index) => ({
    clip,
    index,
    x: coordinates.get(bounds[index].start) ?? 16,
    width: Math.max(
      minimum,
      (coordinates.get(bounds[index].end) ?? 16 + minimum) -
        (coordinates.get(bounds[index].start) ?? 16),
    ),
  }));
  return { items, width: x + 160, end: x };
}
