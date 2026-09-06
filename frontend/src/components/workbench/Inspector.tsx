import { useEffect, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  Box,
  Bot,
  Check,
  ChevronRight,
  CircuitBoard,
  Clock3,
  FileJson,
  MessageSquareText,
  Move3D,
  Radio,
  Rotate3D,
  ScanEye,
  SlidersHorizontal,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { type TimelineClip, timecode, linkColor } from "@/lib/timeline";
import type { WorkspaceState, SceneObject } from "@/lib/workspace-api";
import type { RobotRuntimeStatus } from "@/hooks/useRobotStatus";
import type { ConversationMessage } from "@/hooks/useConversation";
export type InspectorTab = "node" | "objects" | "robot" | "conversation";
function Property({ name, value }: { name: string; value: React.ReactNode }) {
  return (
    <div className="property-row">
      <span>{name}</span>
      <span>{value}</span>
    </div>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Box;
  title: string;
  text: string;
}) {
  return (
    <div className="inspector-empty">
      <Icon size={28} strokeWidth={1.3} />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
function Vector({
  title,
  icon: Icon,
  value,
  onChange,
  disabled,
  unit,
}: {
  title: string;
  icon: typeof Box;
  value: number[];
  onChange?: (value: number[]) => void;
  disabled?: boolean;
  unit: string;
}) {
  return (
    <div className="vector-field">
      <div>
        <Icon size={13} />
        {title}
        <span>{unit}</span>
      </div>
      <div className="vector-inputs">
        {["X", "Y", "Z"].map((axis, i) => (
          <label key={axis}>
            <span className={`axis-${axis.toLowerCase()}`}>{axis}</span>
            <Input
              type="number"
              aria-label={`${title} ${axis}`}
              value={value[i] ?? 0}
              step={unit === "m" ? 0.01 : 1}
              disabled={disabled}
              onChange={(e) => {
                const next = [...value];
                next[i] = Number(e.target.value);
                onChange?.(next);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
function ObjectEditor({
  object,
  editable,
  busy,
  onSave,
}: {
  object: SceneObject;
  editable: boolean;
  busy: boolean;
  onSave: (id: string, values: Record<string, unknown>) => Promise<void>;
}) {
  const [position, setPosition] = useState(object.position ?? [0, 0, 0]);
  const [rotation, setRotation] = useState(object.rotation ?? [0, 0, 0]);
  useEffect(() => {
    setPosition(object.position ?? [0, 0, 0]);
    setRotation(object.rotation ?? [0, 0, 0]);
  }, [object]);
  return (
    <>
      <div className="inspector-subhead">
        <Move3D size={13} />
        变换<span>世界坐标</span>
      </div>
      <div className="property-group">
        <Vector
          title="位置"
          icon={Move3D}
          unit="m"
          value={position}
          onChange={setPosition}
          disabled={!editable}
        />
        <Vector
          title="旋转"
          icon={Rotate3D}
          unit="°"
          value={rotation}
          onChange={setRotation}
          disabled={!editable}
        />
        {object.size && (
          <Vector
            title="尺寸"
            icon={Box}
            unit="m"
            value={object.size}
            disabled
          />
        )}
        <Property
          name="外观颜色"
          value={
            object.color ? (
              <span className="color-value">
                <i
                  style={{
                    background: `rgb(${object.color.map((c) => Math.round(c * 255)).join(",")})`,
                  }}
                />
                {object.color.map((c) => Math.round(c * 255)).join(" / ")}
              </span>
            ) : (
              "—"
            )
          }
        />
        <Button
          size="sm"
          variant="secondary"
          className="full-button"
          disabled={!editable || busy}
          onClick={() => void onSave(object.id, { position, rotation })}
        >
          <Check size={14} />
          应用位置与旋转
        </Button>
        {!editable && (
          <p className="field-help">
            服务当前提供物体信息；位置编辑等待仿真端接口更新。
          </p>
        )}
      </div>
    </>
  );
}
function RobotSettings({
  workspace,
  busy,
  onSave,
}: {
  workspace: WorkspaceState | null;
  busy: boolean;
  onSave: (config: Record<string, unknown>) => Promise<void>;
}) {
  const cfg = workspace?.controller;
  const [position, setPosition] = useState(
    cfg ? cfg.position_tolerance_m * 1000 : 6,
  );
  const [rotation, setRotation] = useState(cfg?.rotation_tolerance_deg ?? 5);
  useEffect(() => {
    if (cfg) {
      setPosition(cfg.position_tolerance_m * 1000);
      setRotation(cfg.rotation_tolerance_deg);
    }
  }, [cfg]);
  return (
    <>
      <div className="inspector-subhead">
        <SlidersHorizontal size={13} />
        执行参数
      </div>
      <div className="property-group">
        <label className="setting-input">
          位置容差{" "}
          <span>
            <Input
              type="number"
              min="0.1"
              max="100"
              step=".1"
              value={position}
              disabled={!cfg}
              onChange={(e) => setPosition(Number(e.target.value))}
            />
            mm
          </span>
        </label>
        <label className="setting-input">
          旋转容差{" "}
          <span>
            <Input
              type="number"
              min="0.1"
              max="45"
              step=".1"
              value={rotation}
              disabled={!cfg}
              onChange={(e) => setRotation(Number(e.target.value))}
            />
            °
          </span>
        </label>
        <Button
          variant="secondary"
          size="sm"
          className="full-button"
          disabled={!cfg || busy}
          onClick={() =>
            void onSave({
              position_tolerance_m: position / 1000,
              rotation_tolerance_deg: rotation,
            })
          }
        >
          应用参数
        </Button>
        {!cfg && <p className="field-help">执行参数由当前仿真服务管理。</p>}
      </div>
    </>
  );
}
export function Inspector({
  tab,
  onTab,
  selected,
  workspace,
  status,
  messages,
  busy,
  onObjectSave,
  onConfigSave,
}: {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  selected: TimelineClip | null;
  workspace: WorkspaceState | null;
  status: RobotRuntimeStatus | null;
  messages: ConversationMessage[];
  busy: boolean;
  onObjectSave: (id: string, values: Record<string, unknown>) => Promise<void>;
  onConfigSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [objectId, setObjectId] = useState<string | null>(null);
  const object =
    workspace?.objects.find((o) => o.id === objectId) ?? workspace?.objects[0];
  const nodes = [
    { id: "node", name: "节点详情", Icon: Activity },
    { id: "objects", name: "场景物体", Icon: Box },
    { id: "robot", name: "机械臂配置", Icon: Bot },
    { id: "conversation", name: "当前对话", Icon: MessageSquareText },
  ];
  return (
    <section className="inspector-panel" aria-label="属性与配置">
      <header className="panel-title">
        <span>
          <SlidersHorizontal size={15} />
          功能面板
        </span>
        <small>INSPECTOR</small>
      </header>
      <Tabs
        orientation="vertical"
        value={tab}
        onValueChange={(v) => onTab(v as InspectorTab)}
        className="inspector-tabs"
      >
        <TabsList aria-label="功能选择">
          {nodes.map((n) => (
            <Tip key={n.id} label={n.name} side="right">
              <TabsTrigger value={n.id} aria-label={n.name}>
                <n.Icon size={17} />
              </TabsTrigger>
            </Tip>
          ))}
        </TabsList>
        <TabsContent value="node">
          {!selected ? (
            <>
              <Empty
                icon={Activity}
                title="选择一个执行节点"
                text="点击时间轴中的卡片，查看调用内容、执行状态和耗时。"
              />
              <div className="inspector-guide">
                <div>
                  <i className="dot fast" />
                  <span>快环</span>
                  <small>快速感知与直接执行</small>
                </div>
                <div>
                  <i className="dot slow" />
                  <span>慢环</span>
                  <small>语义理解与模型增强</small>
                </div>
                <div>
                  <ArrowDownRight size={12} />
                  <span>调用关系</span>
                  <small>对应端点使用相同颜色</small>
                </div>
              </div>
            </>
          ) : (
            <div className="inspector-split node-layout">
              <div className="inspector-section node-summary">
                <div className="node-intro">
                  <span className={`node-type loop-${selected.loop}`}>
                    <CircuitBoard size={18} />
                  </span>
                  <div>
                    <strong>{selected.title}</strong>
                    <small>{selected.agent}</small>
                  </div>
                  <span className={`state-pill ${selected.state}`}>
                    {
                      {
                        running: "执行中",
                        completed: "完成",
                        failed: "失败",
                        unknown: "待确认",
                        event: "事件",
                      }[selected.state]
                    }
                  </span>
                </div>
                <div className="inspector-subhead">
                  <Clock3 size={13} />
                  调用信息
                </div>
                <div className="property-group">
                  <Property
                    name="开始时间"
                    value={new Date(selected.start).toLocaleTimeString(
                      "zh-CN",
                      {
                        hour12: false,
                      },
                    )}
                  />
                  <Property
                    name="执行耗时"
                    value={
                      selected.precise
                        ? selected.end
                          ? `${((selected.end - selected.start) / 1000).toFixed(3)} s`
                          : "执行中…"
                        : "单点事件"
                    }
                  />
                  <Property
                    name="所属环路"
                    value={
                      { fast: "快环", slow: "慢环", neutral: "未标注" }[
                        selected.loop
                      ]
                    }
                  />
                  <Property
                    name="任务标识"
                    value={
                      <code title={selected.taskId}>
                        {selected.taskId?.slice(-12) ?? "会话"}
                      </code>
                    }
                  />
                  {selected.parentId && (
                    <Property
                      name="上游调用"
                      value={
                        <span
                          className="causal-chip"
                          style={{ color: linkColor(selected.parentId) }}
                        >
                          <i />
                          {selected.parentId.slice(-8)}
                        </span>
                      }
                    />
                  )}
                </div>
              </div>
              <div className="inspector-section node-events">
                <div className="inspector-subhead">
                  <Radio size={13} />
                  节点事件<span>{selected.events.length}</span>
                </div>
                <div className="node-event-list">
                  {selected.events.map((event) => (
                    <div className="node-event" key={event.id}>
                      <span className="event-at">
                        +{timecode(event.createdAt - selected.start)}
                      </span>
                      <div>
                        <strong>{event.eventType}</strong>
                        {typeof event.payload.message === "string" && (
                          <p>{event.payload.message}</p>
                        )}
                        <details>
                          <summary>
                            <FileJson size={11} />
                            调用数据
                            <ChevronRight size={11} />
                          </summary>
                          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                        </details>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </TabsContent>
        <TabsContent value="objects">
          {workspace?.objects.length ? (
            <div className="inspector-split object-layout">
              <div className="inspector-section object-browser">
                <div className="inspector-subhead">
                  <Box size={13} />
                  场景物体<span>{workspace.objects.length}</span>
                </div>
                <div className="object-list">
                  {workspace.objects.map((row) => (
                    <button
                      key={row.id}
                      aria-pressed={object?.id === row.id}
                      onClick={() => setObjectId(row.id)}
                    >
                      <Box
                        size={14}
                        style={
                          row.color
                            ? {
                                color: `rgb(${row.color.map((c) => c * 255).join(",")})`,
                              }
                            : {}
                        }
                      />
                      <span>
                        {row.name}
                        <small>{row.id}</small>
                      </span>
                      <ChevronRight size={12} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="inspector-section object-controls">
                {object && (
                  <ObjectEditor
                    key={object.id}
                    object={object}
                    editable={
                      !!workspace.available && object.editable !== false
                    }
                    busy={busy}
                    onSave={onObjectSave}
                  />
                )}
              </div>
            </div>
          ) : (
            <Empty
              icon={ScanEye}
              title="还没有物体信息"
              text="场景连接后，这里显示可编辑物体或视觉识别结果。"
            />
          )}
        </TabsContent>
        <TabsContent value="robot">
          <div className="inspector-split robot-layout">
            <div className="inspector-section robot-summary">
              <div className="robot-intro">
                <div className="robot-outline">
                  <Bot size={30} strokeWidth={1.2} />
                </div>
                <strong>Franka Panda</strong>
                <span>7 DOF · Parallel gripper</span>
              </div>
              <div className="property-group">
                <Property name="当前状态" value={status?.phase ?? "未连接"} />
                <Property
                  name="持有物体"
                  value={status?.held_object ?? "空夹爪"}
                />
                <Property name="控制方式" value="Arena IK" />
              </div>
              <div className="inspector-subhead">
                <Activity size={13} />
                关节状态<span>°</span>
              </div>
              <div className="joint-list">
                {Object.entries(status?.motion?.joint_positions_deg ?? {}).map(
                  ([name, value], i) => (
                    <div key={name}>
                      <span>J{i + 1}</span>
                      <div>
                        <i
                          style={{
                            width: `${Math.min(100, (Math.abs(value) / 180) * 100)}%`,
                          }}
                        />
                      </div>
                      <code>{value.toFixed(2)}</code>
                    </div>
                  ),
                )}
                {!status?.motion?.joint_positions_deg && (
                  <p className="field-help">等待关节状态</p>
                )}
              </div>
            </div>
            <div className="inspector-section robot-controls">
              <RobotSettings
                workspace={workspace}
                busy={busy}
                onSave={onConfigSave}
              />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="conversation">
          <div className="inspector-subhead">
            <MessageSquareText size={13} />
            当前对话<span>{messages.length}</span>
          </div>
          {messages.length ? (
            <div className="conversation-list">
              {messages.map((m) => (
                <div key={m.id} className={`conversation-entry ${m.role}`}>
                  <div>
                    <strong>
                      {m.role === "user"
                        ? "你"
                        : m.role === "notice"
                          ? "系统"
                          : "刘工"}
                    </strong>
                    <time>
                      {new Date(m.createdAt).toLocaleTimeString("zh-CN", {
                        hour12: false,
                      })}
                    </time>
                  </div>
                  <p>{m.text || "正在思考…"}</p>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              icon={MessageSquareText}
              title="随时告诉刘工"
              text="点击右下方的悬浮球说话，也可以用文字发出任务。"
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
