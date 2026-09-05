import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Link } from "react-router-dom";
import {
  ActivityIcon,
  BackIcon,
  MicIcon,
  PlusIcon,
  RobotIcon,
  SendIcon,
  SparkleIcon,
  StopIcon,
  TargetIcon,
} from "../components/Icons";
import { useConversation, type RobotBusEvent } from "../hooks/useConversation";
import { useRobotStatus } from "../hooks/useRobotStatus";
import { GraspPanel } from "../components/GraspPanel";

const quickCommands = [
  "查询能力",
  "底座顺时针转10度",
  "向上移动1厘米",
  "打开夹爪",
  "闭合夹爪",
  "归位",
  "继续执行",
  "现在什么状态",
];

const activityText = {
  idle: "Web 通道已连接",
  connecting: "正在连接 BusAgent",
  listening: "正在听 · 停顿后自动发送",
  thinking: "BusAgent 正在处理",
  speaking: "正在播报 · 可直接打断",
  error: "Web 通道异常",
} as const;

type ArchitectureNodeState =
  | "waiting"
  | "active"
  | "watching"
  | "done"
  | "failed";

interface ArchitectureNode {
  id: string;
  index: string;
  name: string;
  hint: string;
  events: string[];
  failureEvents?: string[];
}

const coreNodes: ArchitectureNode[] = [
  {
    id: "understanding",
    index: "01",
    name: "指令理解",
    hint: "qwen3.8-flash · low",
    events: ["instruction.parsed", "interaction.classified"],
  },
  {
    id: "grounding",
    index: "02",
    name: "场景指代",
    hint: "Grounding",
    events: ["command.grounded", "clarification.requested"],
  },
  {
    id: "planning",
    index: "03",
    name: "任务规划",
    hint: "Skill Plan",
    events: ["plan.proposed"],
  },
  {
    id: "validation",
    index: "04",
    name: "计划校验",
    hint: "Validator",
    events: ["plan.validated", "plan.rejected"],
    failureEvents: ["plan.rejected"],
  },
  {
    id: "routing",
    index: "05",
    name: "控制环路由",
    hint: "Loop Router",
    events: ["execution.profile.selected"],
  },
];

const executionNodes: ArchitectureNode[] = [
  {
    id: "coordinator",
    index: "06",
    name: "执行协调",
    hint: "Coordinator",
    events: ["robot.execute.requested"],
  },
  {
    id: "adapter",
    index: "07",
    name: "设备适配",
    hint: "Robot Adapter",
    events: [
      "execution.queued",
      "execution.cancelled",
      "execution.accepted",
      "execution.started",
      "execution.progress",
      "execution.completed",
      "execution.failed",
      "execution.unknown",
    ],
    failureEvents: ["execution.failed", "execution.unknown"],
  },
];

const stageByEvent: Record<string, number> = {
  "intent.created": 0,
  "instruction.parsed": 0,
  "interaction.classified": 0,
  "command.grounded": 1,
  "clarification.requested": 1,
  "plan.proposed": 2,
  "plan.validated": 3,
  "plan.rejected": 3,
  "execution.profile.selected": 4,
  "interrupt.requested": 4,
  "robot.execute.requested": 5,
  "execution.accepted": 5,
  "execution.queued": 5,
  "execution.cancelled": 6,
  "execution.started": 5,
  "execution.progress": 5,
  "execution.completed": 6,
  "execution.failed": 6,
  "execution.unknown": 6,
};

const eventNames: Record<string, string> = {
  "intent.created": "收到用户指令",
  "instruction.parsed": "完成结构化理解",
  "interaction.classified": "交互意图确认 · 无需设备执行",
  "command.grounded": "目标语义已确认",
  "clarification.requested": "需要补充目标信息",
  "plan.proposed": "生成技能计划",
  "plan.validated": "计划校验通过",
  "plan.rejected": "计划被拒绝",
  "execution.profile.selected": "选择控制环",
  "interrupt.requested": "收到立即暂停",
  "robot.execute.requested": "提交设备执行",
  "execution.accepted": "控制器已接收",
  "execution.queued": "等待上一动作完成 · 尚未下发",
  "execution.cancelled": "动作已取消",
  "execution.started": "开始执行技能",
  "execution.progress": "执行阶段更新",
  "execution.completed": "任务执行完成",
  "execution.failed": "任务执行失败",
  "execution.unknown": "执行结果未知",
  "reply.created": "生成工程回复",
};

function timeText(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function eventDetail(event: RobotBusEvent): string {
  if (event.payload.phase === "interaction") {
    const latency = event.payload.first_text_ms;
    return typeof latency === "number"
      ? `快速交互 · 首字 ${latency} ms`
      : "快速交互";
  }
  const skill = event.payload.skill;
  if (event.eventType === "execution.progress" && typeof event.payload.message === "string")
    return event.payload.message;
  if (typeof skill === "string") return skill;
  const message = event.payload.message;
  if (typeof message === "string") return message;
  const intent = event.payload.intent;
  if (typeof intent === "string") return intent;
  return event.sourceAgentId.replace(/^robot\./, "");
}

function currentTaskEvents(events: RobotBusEvent[]): RobotBusEvent[] {
  const nextIntent = events.findIndex(
    (event, index) => index > 0 && event.eventType === "intent.created",
  );
  return nextIntent === -1 ? events : events.slice(0, nextIntent);
}

function includesEvent(events: RobotBusEvent[], names: string[]) {
  return events.some((event) => names.includes(event.eventType));
}

function architectureNodeState(
  node: ArchitectureNode,
  events: RobotBusEvent[],
  activeNodeId?: string,
): ArchitectureNodeState {
  if (
    node.id === "adapter" &&
    events.find((event) => node.events.includes(event.eventType))?.eventType ===
      "execution.queued"
  )
    return "waiting";
  if (includesEvent(events, node.failureEvents ?? [])) return "failed";
  if (activeNodeId === node.id) return "active";
  if (includesEvent(events, node.events)) return "done";
  return "waiting";
}

function activeNodeForEvent(eventType?: string): string | undefined {
  const routing: Record<string, string> = {
    "intent.created": "understanding",
    "instruction.parsed": "grounding",
    "clarification.requested": "grounding",
    "command.grounded": "planning",
    "plan.proposed": "validation",
    "plan.validated": "routing",
    "execution.profile.selected": "coordinator",
    "interrupt.requested": "coordinator",
    "robot.execute.requested": "adapter",
    "execution.accepted": "adapter",
    "execution.started": "adapter",
    "execution.progress": "adapter",
  };
  return eventType ? routing[eventType] : undefined;
}

function stateText(state: ArchitectureNodeState) {
  if (state === "active") return "运行中";
  if (state === "watching") return "监听中";
  if (state === "done") return "已完成";
  if (state === "failed") return "异常";
  return "等待";
}

function ArchitectureNodeCard({
  node,
  state,
}: {
  node: ArchitectureNode;
  state: ArchitectureNodeState;
}) {
  return (
    <div className={`architecture-node ${state}`}>
      <div className="node-index">{node.index}</div>
      <div className="node-copy">
        <strong>{node.name}</strong>
        <small>{node.hint}</small>
      </div>
      <span className="node-state">
        <i />
        {stateText(state)}
      </span>
    </div>
  );
}

export function RobotConsolePage() {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    robotEvents,
    activity,
    isListening,
    isSpeaking,
    micBusy,
    voiceLevel,
    sendText,
    toggleListening,
    stopSpeaking,
    startNewConversation,
  } = useConversation();
  const robot = useRobotStatus();
  const taskEvents = useMemo(
    () => currentTaskEvents(robotEvents),
    [robotEvents],
  );
  const stage = taskEvents.reduce(
    (maximum, event) => Math.max(maximum, stageByEvent[event.eventType] ?? -1),
    -1,
  );
  // Interaction replies do not hide the independently advancing task state.
  const latest = taskEvents.find((event) => event.eventType in stageByEvent);
  const terminal = latest?.eventType;
  const activeNodeId = activeNodeForEvent(terminal);
  const failed =
    terminal === "execution.failed" ||
    terminal === "execution.unknown" ||
    terminal === "plan.rejected";
  const needsInput = terminal === "clarification.requested";
  const completed =
    terminal === "execution.completed" || terminal === "interaction.classified";
  const hasIntent = includesEvent(taskEvents, ["intent.created"]);
  const dialogueState: ArchitectureNodeState =
    activity === "error"
      ? "failed"
      : activity === "thinking" || activity === "speaking"
        ? "active"
        : hasIntent
          ? "done"
          : "waiting";
  const interruptState: ArchitectureNodeState =
    terminal === "interrupt.requested"
      ? "active"
      : includesEvent(taskEvents, ["interrupt.requested"])
        ? "done"
        : activity === "error"
          ? "failed"
          : "watching";
  const sttState: ArchitectureNodeState = isListening
    ? "active"
    : hasIntent
      ? "done"
      : "waiting";
  const scene = robot.status?.views?.scene;
  const detections = scene?.detections?.length ?? 0;

  useEffect(() => {
    const element = threadRef.current;
    if (element)
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 116)}px`;
  }, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendText(text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  const newSession = () => {
    startNewConversation();
    setDraft("");
  };

  return (
    <main className="robot-console-shell">
      <header className="console-header">
        <div className="console-brand">
          <Link className="console-back" to="/" aria-label="返回 App 首页">
            <BackIcon />
          </Link>
          <span className="console-logo">
            <RobotIcon />
          </span>
          <div>
            <p>BUSAGENT · 11-NODE EVENT BUS</p>
            <h1>SO-101 智能操作台</h1>
          </div>
        </div>
        <div className="console-header-actions">
          <span
            className={`system-pill ${robot.connected ? "online" : "offline"}`}
          >
            <i />
            {robot.connected ? "Isaac 控制器在线" : "Isaac 控制器离线"}
          </span>
          <button className="console-new" type="button" onClick={newSession}>
            <PlusIcon /> 新会话
          </button>
        </div>
      </header>

      <section className="console-grid">
        <div className="console-observe-column">
          <section className="console-card runtime-card">
            <div className="card-heading">
              <div>
                <span className="section-kicker">RUNTIME STATUS</span>
                <h2>Isaac 联动状态</h2>
              </div>
              <span className="runtime-time">
                {robot.lastUpdated
                  ? `${timeText(robot.lastUpdated)} 更新`
                  : "等待状态"}
              </span>
            </div>

            <div
              className={`runtime-hero ${robot.connected ? "online" : "offline"}`}
            >
              <div className="robot-orbit" aria-hidden="true">
                <i />
                <i />
                <i />
                <RobotIcon />
              </div>
              <div>
                <span>GPU WORKCELL · SO-101</span>
                <h3>
                  {robot.connected ? "控制链路已就绪" : "等待 Isaac 控制器"}
                </h3>
                <p>
                  Isaac Sim 画面由服务器显示器直接查看；Web
                  端仅同步语音、任务和控制状态。
                </p>
              </div>
            </div>

            <div className="runtime-metrics">
              <div>
                <TargetIcon />
                <span>
                  <small>当前目标</small>
                  <strong>{robot.status?.prompt ?? "—"}</strong>
                </span>
              </div>
              <div>
                <ActivityIcon />
                <span>
                  <small>感知状态</small>
                  <strong>
                    {detections > 0 ? `${detections} 个目标` : "等待目标"}
                  </strong>
                </span>
              </div>
              <div>
                <RobotIcon />
                <span>
                  <small>机械臂</small>
                  <strong>
                    {robot.status?.motion?.mode === "moving"
                      ? "运动中"
                      : robot.status?.follow_enabled
                        ? "跟随中"
                        : "保持"}
                  </strong>
                </span>
              </div>
            </div>

            {robot.error && <p className="controller-error">{robot.error}</p>}
            {robot.status?.motion && (
              <div className="motion-feedback">
                <p>实测关节角度（度）</p>
                <dl className="joint-readings">
                  {Object.entries(
                    robot.status.motion.joint_positions_deg ?? {},
                  ).map(([name, angle]) => (
                    <div key={name}>
                      <dt>
                        {(
                          {
                            shoulder_pan: "底座",
                            shoulder_lift: "肩部",
                            elbow_flex: "肘部",
                            wrist_flex: "腕俯仰",
                            wrist_roll: "腕旋转",
                            gripper: "夹爪",
                          } as Record<string, string>
                        )[name] ?? name}
                      </dt>
                      <dd>{angle.toFixed(1)}°</dd>
                    </div>
                  ))}
                </dl>
                <p>
                  末端世界坐标（米）：
                  {robot.status.motion.tool_position_world_m
                    ?.map((v) => v.toFixed(3))
                    .join(" / ") ?? "等待采样"}
                </p>
                <p>
                  最近动作：
                  {robot.status.motion.last_command?.message ??
                    "尚未下达"} ·{" "}
                  {(
                    {
                      accepted: "已接收",
                      started: "执行中",
                      completed: "已完成",
                      failed: "失败",
                      cancelled: "已中断",
                    } as Record<string, string>
                  )[robot.status.motion.last_command?.state ?? ""] ?? "待命"}
                </p>
                {robot.status.grounding && (
                  <div>
                    <p>
                      最近物体定位（顶部 RGB-D）：
                      {robot.status.grounding.prompt} ·{" "}
                      {robot.status.grounding.count} 个候选
                    </p>
                    <p>
                      物体可见表面坐标（米）：
                      {robot.status.grounding.object_position_world_m
                        ?.map((v) => v.toFixed(3))
                        .join(" / ") ?? "未获得有效深度"}
                    </p>
                    {robot.status.grounding.target_world_m && (
                      <p>
                        物体偏移目标（米）：
                        {robot.status.grounding.target_world_m
                          .map((v) => v.toFixed(3))
                          .join(" / ")}
                      </p>
                    )}
                    <p>{robot.status.grounding.message}</p>
                  </div>
                )}
                <details>
                  <summary>当前控制器能力</summary>
                  <p>{robot.status.capabilities?.message ?? "等待能力信息"}</p>
                </details>
              </div>
            )}
          </section>

          <GraspPanel status={robot.status} connected={robot.connected} />
          <section className="console-card pipeline-card">
            <div className="card-heading">
              <div>
                <span className="section-kicker">AGENT ORCHESTRATION</span>
                <h2>多节点协作拓扑</h2>
              </div>
              <span
                className={`task-state ${failed ? "failed" : completed ? "done" : ""}`}
              >
                {terminal === "execution.queued"
                  ? "排队等待"
                  : terminal === "execution.cancelled"
                    ? "已取消"
                    : failed
                      ? "异常"
                      : completed
                        ? "完成"
                        : needsInput
                          ? "待补充"
                          : stage >= 0
                            ? "运行中"
                            : "待命"}
              </span>
            </div>
            <div className="architecture-summary">
              <div>
                <strong>11</strong>
                <span>职责节点</span>
              </div>
              <div>
                <strong>2</strong>
                <span>并行旁路</span>
              </div>
              <div>
                <strong>1</strong>
                <span>设备串行通道</span>
              </div>
              <p>
                同一输入同时进入快速对话和任务理解；边回应、边解析，实际动作仍走单设备通道。
              </p>
            </div>

            <div className="architecture-map">
              <div className="architecture-entry">
                <span className="lane-label">输入网关</span>
                <div className={`gateway-node ${sttState}`}>
                  <i />
                  <div>
                    <strong>语音识别</strong>
                    <small>STT · 流式转写</small>
                  </div>
                  <span>{stateText(sttState)}</span>
                </div>
                <span className="bus-chip">
                  EVENT BUS · 一次输入 / 双路并行
                </span>
              </div>

              <div className="architecture-lanes">
                <section className="architecture-lane core-lane">
                  <header>
                    <span>任务主链</span>
                    <small>5 个职责节点 · 串行推进</small>
                  </header>
                  <div className="architecture-node-row core-node-row">
                    {coreNodes.map((node) => (
                      <ArchitectureNodeCard
                        key={node.id}
                        node={node}
                        state={architectureNodeState(
                          node,
                          taskEvents,
                          activeNodeId,
                        )}
                      />
                    ))}
                  </div>
                </section>

                <div className="parallel-lanes">
                  <section className="architecture-lane side-lane dialogue-lane">
                    <header>
                      <span>并行旁路 A</span>
                      <small>不等待语义推理与动作完成</small>
                    </header>
                    <div className="side-route">
                      <div className={`compact-node ${dialogueState}`}>
                        <span className="compact-node-icon">D</span>
                        <div>
                          <strong>快速工程对话</strong>
                          <small>qwen-flash · 无思考</small>
                        </div>
                        <em>{stateText(dialogueState)}</em>
                      </div>
                      <span className="route-arrow">→</span>
                      <div
                        className={`compact-node ${isSpeaking ? "active" : hasIntent ? "done" : "waiting"}`}
                      >
                        <span className="compact-node-icon">T</span>
                        <div>
                          <strong>语音播报</strong>
                          <small>TTS</small>
                        </div>
                        <em>{isSpeaking ? "播报中" : "就绪"}</em>
                      </div>
                    </div>
                  </section>

                  <section className="architecture-lane side-lane interrupt-lane">
                    <header>
                      <span>并行旁路 B</span>
                      <small>高优先级抢占</small>
                    </header>
                    <div className="side-route">
                      <div className={`compact-node ${interruptState}`}>
                        <span className="compact-node-icon">!</span>
                        <div>
                          <strong>中断监听</strong>
                          <small>Interrupt Monitor</small>
                        </div>
                        <em>{stateText(interruptState)}</em>
                      </div>
                      <span className="bypass-target">直达执行协调器</span>
                    </div>
                  </section>
                </div>
              </div>

              <section className="architecture-lane execution-lane">
                <header>
                  <span>执行汇合</span>
                  <small>副作用边界 · 单设备串行</small>
                </header>
                <div className="architecture-node-row execution-node-row">
                  {executionNodes.map((node) => (
                    <ArchitectureNodeCard
                      key={node.id}
                      node={node}
                      state={architectureNodeState(
                        node,
                        taskEvents,
                        activeNodeId,
                      )}
                    />
                  ))}
                  <div
                    className={`workcell-target ${robot.connected ? "online" : "offline"}`}
                  >
                    <RobotIcon />
                    <div>
                      <strong>SO-101</strong>
                      <small>
                        {robot.connected ? "Isaac 在线" : "Isaac 离线"}
                      </small>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <div className="event-stream">
              {taskEvents.length === 0 ? (
                <p>说出或输入指令后，拓扑会随真实 BusAgent 事件逐节点点亮。</p>
              ) : (
                taskEvents.slice(0, 6).map((event) => (
                  <div className="event-row" key={event.id}>
                    <i />
                    <time>{timeText(event.createdAt)}</time>
                    <strong>
                      {eventNames[event.eventType] ?? event.eventType}
                    </strong>
                    <span>
                      {event.sourceAgentId.replace(/^robot\./, "")} ·{" "}
                      {eventDetail(event)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <section className="console-card voice-card">
          <div className="voice-heading">
            <div>
              <span className="section-kicker">VOICE COMMAND</span>
              <h2>语音交互</h2>
            </div>
            <span className={`voice-status ${activity}`}>
              <i />
              {activityText[activity]}
            </span>
          </div>

          <div className="console-thread" ref={threadRef} aria-live="polite">
            {messages.length === 0 ? (
              <div className="console-empty">
                <span>
                  <SparkleIcon />
                </span>
                <h3>请下达操作指令</h3>
                <p>可以持续开启麦克风。需要暂停时直接说“停一下”。</p>
                <div className="console-suggestions">
                  {quickCommands.map((command) => (
                    <button
                      key={command}
                      type="button"
                      onClick={() => void sendText(command)}
                    >
                      {command}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="console-messages">
                {messages.map((message) => (
                  <article
                    className={`console-message ${message.role}`}
                    key={message.id}
                  >
                    <div>
                      <span>
                        {message.role === "user"
                          ? "你"
                          : message.role === "assistant"
                            ? "BusAgent"
                            : "系统"}
                      </span>
                      <time>{timeText(message.createdAt)}</time>
                    </div>
                    <p className={message.pending ? "pending" : ""}>
                      {message.text || "正在处理…"}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </div>

          <footer className="console-composer-wrap">
            <button
              className="hold-button"
              type="button"
              onClick={() => void sendText("停一下")}
            >
              <StopIcon /> 立即暂停
            </button>
            {isSpeaking && (
              <button
                className="console-stop-speech"
                type="button"
                onClick={stopSpeaking}
              >
                停止语音播放
              </button>
            )}
            <div className="console-composer">
              <button
                className={`console-mic ${isListening ? "active" : ""}`}
                type="button"
                aria-label={isListening ? "关闭麦克风" : "打开麦克风"}
                aria-pressed={isListening}
                disabled={micBusy}
                onClick={() => void toggleListening()}
                style={{ "--voice-level": voiceLevel } as CSSProperties}
              >
                <i />
                {isListening ? <StopIcon /> : <MicIcon />}
              </button>
              <textarea
                ref={textareaRef}
                rows={1}
                value={draft}
                placeholder={isListening ? "正在倾听…" : "输入操作指令或问题…"}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button
                className="console-send"
                type="button"
                disabled={!draft.trim()}
                onClick={submit}
                aria-label="发送"
              >
                <SendIcon />
              </button>
            </div>
            <p className="console-footnote">
              Isaac Sim 在服务器显示器独立渲染 · Web
              页面同步语音、控制与任务状态
            </p>
          </footer>
        </section>
      </section>
    </main>
  );
}
