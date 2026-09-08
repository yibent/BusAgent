import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BrainCircuit,
  CheckCircle2,
  Eye,
  Gauge,
  ListTodo,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Route,
  ServerCog,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type SettingsPage = "tasks" | "routes" | "providers" | "runtime";
type NodeRole = "task" | "planner" | "supervisor" | "visual" | "dialogue";
type FallbackPolicy = "disabled" | "same_capability" | "ordered_compatible";
type Profile = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  configured: boolean;
  enabled: boolean;
  vision: boolean;
  boxGrounding: boolean;
  thinking: boolean;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "max";
  timeoutMs?: number;
  firstTokenTimeoutMs?: number;
};
type Settings = {
  profiles: Profile[];
  roles: Record<NodeRole, string>;
  fallbacks: Record<NodeRole, string[]>;
  nodeTimeouts: Partial<Record<NodeRole | "perception", number>>;
  nodeFirstTokenTimeouts: Partial<Record<NodeRole, number>>;
  fallbackPolicies: Partial<
    Record<Exclude<NodeRole, "dialogue">, FallbackPolicy>
  >;
  images: boolean;
  supervisorEnabled: boolean;
  recoveryBudget: number;
  architecture: {
    mode: "legacy" | "staged";
    stageRetryLimit: number;
    finalReviewLimit: number;
    finalReview: boolean;
  };
  dialogueRouting?: {
    activeProfile: string;
    consecutiveFailures: number;
    exhausted?: boolean;
  };
  performance: {
    lookahead: boolean;
    requestTimeoutMs: number;
    firstTokenTimeoutMs?: number;
    planningBudgetMs: number;
    toolRounds: number;
    contextBudgetTokens?: number;
    toolResultBudgetTokens?: number;
    providerCooldownEnabled: boolean;
  };
};
type Step = {
  id: string;
  title: string;
  skill: string;
  state: string;
  result?: Record<string, unknown>;
  stage?: {
    id: string;
    number: number;
    title: string;
    depends_on: string[];
    expected_state: string;
  };
};
type Goal = {
  id: string;
  source: string;
  summary: string;
  completion: string;
  state: string;
  message: string;
  steps: Step[];
  model_calls: number;
  list_number?: number;
  architecture?: "legacy" | "staged";
};
type Queue = { enabled: boolean; paused: boolean; goals: Goal[] };

const stateNames: Record<string, string> = {
  queued: "等待中",
  planning: "规划中",
  running: "执行中",
  review: "等待核验",
  paused: "已暂停",
  blocked: "需要处理",
  completed: "已完成",
  cancelled: "已取消",
  pending: "待执行",
  dispatching: "下发中",
  failed: "未完成",
  unknown: "核对结果中",
  superseded: "已调整",
};
const ended = (state: string) => ["completed", "cancelled"].includes(state);
const fixedThinking = (profile: Profile) =>
  profile.provider === "gemini" ||
  (profile.provider === "glm" && /^glm-5\.3(?:-|$)/i.test(profile.model));
const nodes: Array<{
  id: NodeRole;
  code: string;
  title: string;
  detail: string;
  icon: typeof BrainCircuit;
  vision?: boolean;
}> = [
  {
    id: "task",
    code: "AI-01",
    title: "快速任务模型",
    detail: "一次判断无需执行、简单计划、复杂升级或修改已有列表。",
    icon: Route,
  },
  {
    id: "planner",
    code: "AI-02",
    title: "高级任务模型",
    detail: "复杂任务读取场景证据并生成带依赖的阶段序列。",
    icon: BrainCircuit,
  },
  {
    id: "supervisor",
    code: "AI-03",
    title: "列表最终复核",
    detail: "列表结束后结合阶段结果和最新场景做一次集中验收。",
    icon: ShieldCheck,
  },
  {
    id: "visual",
    code: "AI-04",
    title: "视觉语义选择",
    detail: "本地视觉无法消除关系歧义时才读取图片。",
    icon: Eye,
    vision: true,
  },
  {
    id: "dialogue",
    code: "AI-05",
    title: "即时对话",
    detail: "负责自然接话和结果表达，连续三次失败后切换。",
    icon: MessageSquareText,
  },
];
const pages: Array<{
  id: SettingsPage;
  title: string;
  subtitle: string;
  icon: typeof ListTodo;
}> = [
  { id: "tasks", title: "任务队列", subtitle: "执行与恢复", icon: ListTodo },
  { id: "routes", title: "节点路由", subtitle: "主模型与回退", icon: Route },
  {
    id: "providers",
    title: "模型渠道",
    subtitle: "接口与令牌",
    icon: ServerCog,
  },
  { id: "runtime", title: "运行策略", subtitle: "预算与本地链路", icon: Gauge },
];

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "请求未完成");
  return result as T;
}
const normalizeSettings = (settings: Settings): Settings => ({
  ...settings,
  roles: {
    ...settings.roles,
    task: settings.roles.task ?? settings.roles.planner,
    visual: settings.roles.visual ?? settings.roles.planner,
  },
  fallbacks: {
    ...settings.fallbacks,
    task: settings.fallbacks.task ?? settings.fallbacks.planner ?? [],
    visual: settings.fallbacks.visual ?? settings.fallbacks.planner ?? [],
  },
  nodeTimeouts: settings.nodeTimeouts ?? {},
  nodeFirstTokenTimeouts: settings.nodeFirstTokenTimeouts ?? {},
  fallbackPolicies: {
    task: settings.fallbackPolicies?.task ?? "ordered_compatible",
    planner: settings.fallbackPolicies?.planner ?? "same_capability",
    supervisor: settings.fallbackPolicies?.supervisor ?? "same_capability",
    visual: settings.fallbackPolicies?.visual ?? "same_capability",
  },
  performance: {
    ...settings.performance,
    providerCooldownEnabled:
      settings.performance.providerCooldownEnabled ?? false,
    firstTokenTimeoutMs: settings.performance.firstTokenTimeoutMs ?? 8000,
  },
  architecture: settings.architecture ?? {
    mode: "staged",
    stageRetryLimit: 2,
    finalReviewLimit: 2,
    finalReview: true,
  },
});

function FallbackChain({
  settings,
  role,
  onChange,
}: {
  settings: Settings;
  role: NodeRole;
  onChange(settings: Settings): void;
}) {
  const ids = settings.fallbacks[role] ?? [];
  const primary = settings.roles[role];
  const primaryProfile = settings.profiles.find(
    (profile) => profile.id === primary,
  );
  const policy =
    role === "dialogue" ? undefined : settings.fallbackPolicies[role];
  const wantsVision = nodes.find((node) => node.id === role)?.vision;
  const eligible = settings.profiles.filter(
    (profile) =>
      profile.enabled &&
      (ids.includes(profile.id) ||
        ((!wantsVision || profile.vision) &&
          (policy !== "same_capability" ||
            !primaryProfile ||
            (profile.vision === primaryProfile.vision &&
              (!primaryProfile.boxGrounding || profile.boxGrounding))))),
  );
  const update = (fallbacks: string[]) =>
    onChange({
      ...settings,
      fallbacks: { ...settings.fallbacks, [role]: fallbacks },
    });
  return (
    <div className="fallback-chain">
      <div className="chain-heading">
        <span>顺序回退</span>
        <small>
          {role === "dialogue"
            ? "连续 3 次失败后固定切换"
            : policy === "disabled"
              ? "当前节点不自动回退"
              : policy === "same_capability"
                ? "只切换到具备相同图像/框选能力的模型"
                : "按顺序尝试所有兼容渠道"}
        </small>
      </div>
      {ids.map((id, index) => (
        <div className="fallback-row" key={role + "-" + index}>
          <span className="chain-index">
            {String(index + 1).padStart(2, "0")}
          </span>
          <select
            aria-label={"备选模型 " + (index + 1)}
            value={id}
            onChange={(event) =>
              update(
                ids.map((old, i) => (i === index ? event.target.value : old)),
              )
            }
          >
            {eligible
              .filter(
                (profile) =>
                  profile.id === id ||
                  (profile.id !== primary && !ids.includes(profile.id)),
              )
              .map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
          </select>
          <button
            aria-label={"上移备选 " + (index + 1)}
            disabled={index === 0}
            onClick={() => {
              const next = [...ids];
              [next[index - 1], next[index]] = [next[index], next[index - 1]];
              update(next);
            }}
          >
            <ArrowUp />
          </button>
          <button
            aria-label={"下移备选 " + (index + 1)}
            disabled={index === ids.length - 1}
            onClick={() => {
              const next = [...ids];
              [next[index], next[index + 1]] = [next[index + 1], next[index]];
              update(next);
            }}
          >
            <ArrowDown />
          </button>
          <button
            aria-label={"移除备选 " + (index + 1)}
            onClick={() => update(ids.filter((_, i) => i !== index))}
          >
            <Trash2 />
          </button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        disabled={
          !eligible.some(
            (profile) => profile.id !== primary && !ids.includes(profile.id),
          )
        }
        onClick={() => {
          const next = eligible.find(
            (profile) => profile.id !== primary && !ids.includes(profile.id),
          );
          if (next) update([...ids, next.id]);
        }}
      >
        <Plus size={13} />
        添加备选
      </Button>
    </div>
  );
}

export function IntelligencePanel({
  page,
  onPageChange,
  onClose,
  onResetLayout,
}: {
  page: SettingsPage | null;
  onPageChange(page: SettingsPage): void;
  onClose(): void;
  onResetLayout(): void;
}) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"active" | "all" | "done">("active");
  const [clearApiKeys, setClearApiKeys] = useState<string[]>([]);
  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await api<Queue>("/v1/tasks"));
    } catch (error) {
      setNotice((error as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!page) return;
    setNotice("");
    void refreshQueue();
    void api<Settings>("/v1/model-config")
      .then((value) => setSettings(normalizeSettings(value)))
      .catch((error) => setNotice(error.message));
    const timer = window.setInterval(() => void refreshQueue(), 1200);
    return () => window.clearInterval(timer);
  }, [page, refreshQueue]);
  useEffect(() => {
    if (!page || page === "tasks") return;
    const timer = window.setInterval(() => {
      void api<Settings>("/v1/model-config")
        .then((latest) =>
          setSettings((draft) =>
            draft
              ? { ...draft, dialogueRouting: latest.dialogueRouting }
              : normalizeSettings(latest),
          ),
        )
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [page]);
  const run = async (operation: () => Promise<void>, success = "") => {
    setBusy(true);
    setNotice("");
    try {
      await operation();
      if (success) setNotice(success);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const persist = async (resetDialogue = false) => {
    if (!settings) return;
    setSettings(
      normalizeSettings(
        await api<Settings>("/v1/model-config", {
          settings,
          resetDialogue,
          clearApiKeys,
        }),
      ),
    );
    setClearApiKeys([]);
  };
  const save = (resetDialogue = false) =>
    run(
      () => persist(resetDialogue),
      resetDialogue
        ? "设置已保存，即时对话已切回默认渠道。"
        : "设置已保存，下次请求生效。",
    );
  const activeGoals =
    queue?.goals.filter((goal) =>
      ["queued", "planning", "running", "review"].includes(goal.state),
    ) ?? [];
  const visibleGoals =
    queue?.goals
      .filter((goal) =>
        filter === "all"
          ? true
          : filter === "done"
            ? ended(goal.state)
            : !ended(goal.state),
      )
      .slice()
      .reverse() ?? [];
  const usedProfiles = useMemo(
    () =>
      new Set(
        settings
          ? [
              ...Object.values(settings.roles),
              ...Object.values(settings.fallbacks).flat(),
            ]
          : [],
      ),
    [settings],
  );

  return (
    <Dialog open={page !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="settings-dialog">
        <div className="settings-heading">
          <div>
            <DialogTitle>系统设置</DialogTitle>
            <DialogDescription>
              任务状态、模型路由、接口渠道与运行预算集中管理。
            </DialogDescription>
          </div>
          <span className="settings-live">
            <i className={queue?.paused ? "paused" : "online"} />
            {queue?.paused ? "队列暂停" : activeGoals.length + " 项活动任务"}
          </span>
        </div>
        <div className="settings-shell">
          <aside className="settings-rail" aria-label="系统设置导航">
            <div className="rail-label">CONTROL SURFACE</div>
            {pages.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={page === item.id ? "active" : ""}
                  onClick={() => onPageChange(item.id)}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <Icon />
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.subtitle}</small>
                  </div>
                </button>
              );
            })}
            <div className="rail-foot">
              <Activity />
              <span>
                BUSAGENT
                <br />
                ROBOT BRAIN
              </span>
            </div>
          </aside>
          <section className="settings-stage">
            {notice && (
              <p className="intelligence-notice" role="status">
                {notice}
              </p>
            )}
            {page === "tasks" && (
              <>
                <header className="stage-header">
                  <div>
                    <span className="stage-kicker">EXECUTION QUEUE</span>
                    <h2>任务队列</h2>
                    <p>只展示机器人执行任务，即时问答不会占用队列。</p>
                  </div>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setQueue(
                          await api<Queue>("/v1/tasks/control", {
                            action: queue?.paused ? "resume" : "pause",
                          }),
                        );
                      })
                    }
                  >
                    {queue?.paused ? <Play size={14} /> : <Pause size={14} />}
                    {queue?.paused ? "恢复执行" : "暂停队列"}
                  </Button>
                </header>
                <div className="queue-overview">
                  {(
                    [
                      ["活动", activeGoals.length, Activity],
                      [
                        "运行",
                        queue?.goals.filter((goal) =>
                          ["running", "planning", "review"].includes(
                            goal.state,
                          ),
                        ).length ?? 0,
                        Gauge,
                      ],
                      [
                        "需处理",
                        queue?.goals.filter((goal) =>
                          ["blocked", "paused"].includes(goal.state),
                        ).length ?? 0,
                        TriangleAlert,
                      ],
                      [
                        "已完成",
                        queue?.goals.filter(
                          (goal) => goal.state === "completed",
                        ).length ?? 0,
                        CheckCircle2,
                      ],
                    ] as Array<[string, number, typeof Activity]>
                  ).map(([label, value, Icon]) => (
                    <div key={String(label)}>
                      <Icon size={15} />
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>
                <div className="queue-filter">
                  {[
                    ["active", "活动任务"],
                    ["all", "全部"],
                    ["done", "已结束"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={filter === id ? "active" : ""}
                      onClick={() => setFilter(id as "active" | "all" | "done")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="queue-list">
                  {!visibleGoals.length && (
                    <div className="queue-empty">
                      <ListTodo />
                      <strong>
                        {filter === "active"
                          ? "当前没有活动任务"
                          : "没有符合条件的记录"}
                      </strong>
                      <span>新的机械臂任务会在这里显示执行和恢复状态。</span>
                    </div>
                  )}
                  {visibleGoals.map((goal) => {
                    const done = goal.steps.filter(
                      (step) => step.state === "completed",
                    ).length;
                    const progress = goal.steps.length
                      ? Math.round((done / goal.steps.length) * 100)
                      : 0;
                    return (
                      <article
                        className="queue-card"
                        key={goal.id}
                        data-state={goal.state}
                      >
                        <div className="queue-card-top">
                          <span>{stateNames[goal.state] ?? goal.state}</span>
                          <small>{goal.model_calls} 次模型请求</small>
                        </div>
                        <h3>
                          {goal.list_number
                            ? `列表 ${goal.list_number} · `
                            : ""}
                          {goal.summary || goal.source}
                        </h3>
                        {goal.summary && (
                          <p className="queue-source">{goal.source}</p>
                        )}
                        {goal.message && <p>{goal.message}</p>}
                        {!!goal.steps.length && (
                          <>
                            <div className="queue-progress">
                              <i style={{ width: progress + "%" }} />
                            </div>
                            <ol>
                              {goal.steps.map((step, index) => (
                                <li key={step.id} data-state={step.state}>
                                  <span>
                                    {String(index + 1).padStart(2, "0")}
                                  </span>
                                  <div>
                                    <strong>{step.title}</strong>
                                    <small>
                                      {stateNames[step.state] ?? step.state} ·{" "}
                                      {step.skill}
                                    </small>
                                    {step.stage && (
                                      <small className="stage-condition">
                                        阶段 {step.stage.number} · 验收：
                                        {step.stage.expected_state}
                                      </small>
                                    )}
                                  </div>
                                  {step.result && (
                                    <details>
                                      <summary>反馈</summary>
                                      <pre>
                                        {JSON.stringify(step.result, null, 2)}
                                      </pre>
                                    </details>
                                  )}
                                </li>
                              ))}
                            </ol>
                          </>
                        )}
                        <footer>
                          <small>
                            {goal.completion
                              ? "完成条件：" + goal.completion
                              : "等待明确完成条件"}
                          </small>
                          <div>
                            {["blocked", "paused"].includes(goal.state) && (
                              <Button
                                size="sm"
                                onClick={() =>
                                  void run(async () => {
                                    setQueue(
                                      await api<Queue>("/v1/tasks/control", {
                                        action: "retry",
                                        id: goal.id,
                                      }),
                                    );
                                  })
                                }
                              >
                                恢复
                              </Button>
                            )}
                            {!ended(goal.state) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  void run(async () => {
                                    setQueue(
                                      await api<Queue>("/v1/tasks/control", {
                                        action: "cancel",
                                        id: goal.id,
                                      }),
                                    );
                                  })
                                }
                              >
                                取消
                              </Button>
                            )}
                          </div>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              </>
            )}
            {page === "routes" && settings && (
              <>
                <header className="stage-header">
                  <div>
                    <span className="stage-kicker">MODEL ROUTING MATRIX</span>
                    <h2>节点路由</h2>
                    <p>每个模型节点独立选择主渠道、顺序回退和超时。</p>
                  </div>
                </header>
                <div className="route-grid">
                  {nodes.map((node) => {
                    const Icon = node.icon;
                    const eligible = settings.profiles.filter(
                      (profile) =>
                        profile.enabled && (!node.vision || profile.vision),
                    );
                    const running =
                      node.id === "dialogue"
                        ? settings.dialogueRouting?.activeProfile
                        : settings.roles[node.id];
                    const primaryProfile = settings.profiles.find(
                      (profile) => profile.id === settings.roles[node.id],
                    );
                    const defaultFirstToken =
                      primaryProfile?.firstTokenTimeoutMs ??
                      (primaryProfile?.vision &&
                      ["planner", "supervisor", "visual"].includes(node.id)
                        ? 30000
                        : (settings.performance.firstTokenTimeoutMs ?? 8000));
                    const firstTokenTimeout =
                      settings.nodeFirstTokenTimeouts[node.id] ??
                      defaultFirstToken;
                    return (
                      <article className="route-card" key={node.id}>
                        <div className="route-title">
                          <span>{node.code}</span>
                          <Icon />
                          <div>
                            <h3>{node.title}</h3>
                            <p>{node.detail}</p>
                          </div>
                        </div>
                        {node.id === "dialogue" && (
                          <div className="route-health">
                            当前运行：
                            <strong>
                              {settings.profiles.find(
                                (profile) => profile.id === running,
                              )?.name ?? running}
                            </strong>
                            <span>
                              失败{" "}
                              {settings.dialogueRouting?.consecutiveFailures ??
                                0}
                              /3
                            </span>
                          </div>
                        )}
                        {node.id === "planner" && (
                          <div className="route-health capability-route">
                            {settings.profiles.find(
                              (profile) =>
                                profile.id === settings.roles.planner,
                            )?.boxGrounding
                              ? "当前高级模型可直接输出冻结图像框，随后由 SAM2 + 深度绑定。"
                              : "当前高级模型不直接框选；目标最终由本地 Florence 提供候选框。"}
                          </div>
                        )}
                        <div className="route-fields">
                          <label>
                            主模型
                            <select
                              aria-label={node.title + "主模型"}
                              value={settings.roles[node.id]}
                              onChange={(event) =>
                                setSettings({
                                  ...settings,
                                  roles: {
                                    ...settings.roles,
                                    [node.id]: event.target.value,
                                  },
                                  fallbacks: {
                                    ...settings.fallbacks,
                                    [node.id]: (
                                      settings.fallbacks[node.id] ?? []
                                    ).filter((id) => id !== event.target.value),
                                  },
                                })
                              }
                            >
                              {eligible.map((profile) => (
                                <option key={profile.id} value={profile.id}>
                                  {profile.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            节点超时
                            <span className="unit-input">
                              <input
                                aria-label={node.title + "超时秒数"}
                                type="number"
                                min={1}
                                max={120}
                                value={
                                  Math.max(
                                    firstTokenTimeout,
                                    settings.nodeTimeouts[node.id] ??
                                      primaryProfile?.timeoutMs ??
                                      settings.performance.requestTimeoutMs,
                                  ) / 1000
                                }
                                onChange={(event) =>
                                  setSettings({
                                    ...settings,
                                    nodeTimeouts: {
                                      ...settings.nodeTimeouts,
                                      [node.id]:
                                        Number(event.target.value) * 1000,
                                    },
                                  })
                                }
                              />
                              <i>秒</i>
                            </span>
                          </label>
                          <label>
                            首字等待
                            <span className="unit-input">
                              <input
                                aria-label={node.title + "首字等待秒数"}
                                type="number"
                                min={1}
                                max={120}
                                value={firstTokenTimeout / 1000}
                                onChange={(event) =>
                                  setSettings({
                                    ...settings,
                                    nodeFirstTokenTimeouts: {
                                      ...settings.nodeFirstTokenTimeouts,
                                      [node.id]:
                                        Number(event.target.value) * 1000,
                                    },
                                  })
                                }
                              />
                              <i>秒</i>
                            </span>
                          </label>
                          {node.id !== "dialogue" && (
                            <label>
                              回退策略
                              <select
                                aria-label={node.title + "回退策略"}
                                value={settings.fallbackPolicies[node.id]}
                                onChange={(event) =>
                                  setSettings({
                                    ...settings,
                                    fallbackPolicies: {
                                      ...settings.fallbackPolicies,
                                      [node.id]: event.target
                                        .value as FallbackPolicy,
                                    },
                                  })
                                }
                              >
                                <option value="disabled">不自动回退</option>
                                <option value="same_capability">
                                  仅同能力模型
                                </option>
                                <option value="ordered_compatible">
                                  按顺序兼容回退
                                </option>
                              </select>
                            </label>
                          )}
                        </div>
                        <FallbackChain
                          settings={settings}
                          role={node.id}
                          onChange={setSettings}
                        />
                      </article>
                    );
                  })}
                </div>
              </>
            )}
            {page === "providers" && settings && (
              <>
                <header className="stage-header">
                  <div>
                    <span className="stage-kicker">PROVIDER REGISTRY</span>
                    <h2>模型渠道</h2>
                    <p>
                      管理接口、模型能力和 API 令牌；已保存令牌不会明文回传。
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setSettings({
                        ...settings,
                        profiles: [
                          ...settings.profiles,
                          {
                            id: "custom-" + Date.now(),
                            name: "新模型",
                            provider: "openai-compatible",
                            baseUrl: "https://",
                            model: "",
                            enabled: false,
                            configured: false,
                            vision: false,
                            boxGrounding: false,
                            thinking: false,
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={14} /> 添加渠道
                  </Button>
                </header>
                <div className="provider-grid">
                  {settings.profiles.map((profile, index) => {
                    const pendingClear = clearApiKeys.includes(profile.id);
                    const change = (fields: Partial<Profile>) =>
                      setSettings({
                        ...settings,
                        profiles: settings.profiles.map((item, i) =>
                          i === index ? { ...item, ...fields } : item,
                        ),
                      });
                    return (
                      <fieldset className="provider-card" key={profile.id}>
                        <legend>
                          <i className={profile.enabled ? "online" : ""} />
                          {profile.name}
                          <span>{profile.provider}</span>
                        </legend>
                        <div className="provider-fields">
                          <label>
                            显示名称
                            <input
                              value={profile.name}
                              onChange={(event) =>
                                change({ name: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            接口类型
                            <select
                              value={profile.provider}
                              onChange={(event) =>
                                change({ provider: event.target.value })
                              }
                            >
                              <option value="gemini">Gemini 兼容接口</option>
                              <option value="qwen">Qwen</option>
                              <option value="glm">智谱 GLM</option>
                              <option value="deepseek">DeepSeek</option>
                              <option value="openai-compatible">
                                OpenAI 兼容接口
                              </option>
                            </select>
                          </label>
                          <label className="wide">
                            Base URL
                            <input
                              value={profile.baseUrl}
                              onChange={(event) =>
                                change({ baseUrl: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            模型 ID
                            <input
                              value={profile.model}
                              onChange={(event) =>
                                change({ model: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            渠道默认超时
                            <span className="unit-input">
                              <input
                                type="number"
                                min={1}
                                max={120}
                                value={
                                  (profile.timeoutMs ??
                                    settings.performance.requestTimeoutMs) /
                                  1000
                                }
                                onChange={(event) =>
                                  change({
                                    timeoutMs:
                                      Number(event.target.value) * 1000,
                                  })
                                }
                              />
                              <i>秒</i>
                            </span>
                          </label>
                          <label>
                            首字超时
                            <span className="unit-input">
                              <input
                                type="number"
                                min={1}
                                max={120}
                                value={
                                  (profile.firstTokenTimeoutMs ??
                                    settings.performance.firstTokenTimeoutMs ??
                                    8000) / 1000
                                }
                                onChange={(event) =>
                                  change({
                                    firstTokenTimeoutMs:
                                      Number(event.target.value) * 1000,
                                  })
                                }
                              />
                              <i>秒</i>
                            </span>
                          </label>
                          <label className="wide">
                            API 令牌
                            <div className="token-control">
                              <input
                                type="password"
                                autoComplete="new-password"
                                value={profile.apiKey ?? ""}
                                placeholder={
                                  pendingClear
                                    ? "保存后清除"
                                    : profile.configured
                                      ? "已配置；输入新令牌可替换"
                                      : "输入 API 令牌"
                                }
                                onChange={(event) => {
                                  setClearApiKeys((ids) =>
                                    ids.filter((id) => id !== profile.id),
                                  );
                                  change({ apiKey: event.target.value });
                                }}
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={
                                  !profile.configured && !profile.apiKey
                                }
                                onClick={() => {
                                  change({ apiKey: "" });
                                  setClearApiKeys((ids) =>
                                    ids.includes(profile.id)
                                      ? ids.filter((id) => id !== profile.id)
                                      : [...ids, profile.id],
                                  );
                                }}
                              >
                                {pendingClear ? "撤销清除" : "清除令牌"}
                              </Button>
                            </div>
                          </label>
                        </div>
                        <div className="provider-flags">
                          {(
                            [
                              "enabled",
                              "vision",
                              "boxGrounding",
                              "thinking",
                            ] as const
                          ).map((key) => (
                            <label key={key}>
                              <input
                                type="checkbox"
                                checked={
                                  key === "thinking" && fixedThinking(profile)
                                    ? true
                                    : profile[key]
                                }
                                disabled={
                                  (key === "thinking" &&
                                    fixedThinking(profile)) ||
                                  (key === "boxGrounding" && !profile.vision)
                                }
                                onChange={(event) =>
                                  change(
                                    key === "vision" && !event.target.checked
                                      ? {
                                          vision: false,
                                          boxGrounding: false,
                                        }
                                      : { [key]: event.target.checked },
                                  )
                                }
                              />
                              {key === "enabled"
                                ? "启用"
                                : key === "vision"
                                  ? "支持图像"
                                  : key === "boxGrounding"
                                    ? "原生框选"
                                    : fixedThinking(profile)
                                      ? "固定思考"
                                      : "开启思考"}
                            </label>
                          ))}
                          <small className="provider-capability-note">
                            原生框选关闭时，目标定位自动使用 YOLOE → SAM3 →
                            Florence；适合 DeepSeek 等文本模型。
                          </small>
                          {fixedThinking(profile) && (
                            <select
                              aria-label={profile.name + "思考强度"}
                              value={profile.reasoningEffort ?? "low"}
                              onChange={(event) =>
                                change({
                                  reasoningEffort: event.target
                                    .value as Profile["reasoningEffort"],
                                })
                              }
                            >
                              {profile.provider === "gemini" && (
                                <option value="minimal">最少思考</option>
                              )}
                              <option value="low">低强度</option>
                              {profile.provider === "gemini" && (
                                <option value="medium">中强度</option>
                              )}
                              <option value="high">高强度</option>
                              {profile.provider !== "gemini" && (
                                <option value="max">最高强度</option>
                              )}
                            </select>
                          )}
                        </div>
                        <footer>
                          <span
                            className={
                              pendingClear
                                ? "warn"
                                : profile.configured
                                  ? "ready"
                                  : ""
                            }
                          >
                            {pendingClear
                              ? "令牌待清除"
                              : profile.configured
                                ? "令牌已保存"
                                : "尚未配置令牌"}
                          </span>
                          <div className="provider-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={
                                busy ||
                                pendingClear ||
                                (!profile.configured && !profile.apiKey)
                              }
                              onClick={() =>
                                void run(async () => {
                                  await persist();
                                  const result = await api<{
                                    model: string;
                                    elapsed_ms: number;
                                  }>("/v1/model-config/test", {
                                    profile: profile.id,
                                  });
                                  setNotice(
                                    result.model +
                                      " 连接成功，耗时 " +
                                      (result.elapsed_ms / 1000).toFixed(1) +
                                      " 秒。",
                                  );
                                })
                              }
                            >
                              测试连接
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={
                                busy ||
                                pendingClear ||
                                !profile.vision ||
                                !settings.images ||
                                (!profile.configured && !profile.apiKey)
                              }
                              onClick={() =>
                                void run(async () => {
                                  await persist();
                                  const result = await api<{
                                    model: string;
                                    elapsed_ms: number;
                                  }>("/v1/model-config/test", {
                                    profile: profile.id,
                                    vision: true,
                                  });
                                  setNotice(
                                    result.model +
                                      " 读图成功，耗时 " +
                                      (result.elapsed_ms / 1000).toFixed(1) +
                                      " 秒。",
                                  );
                                })
                              }
                            >
                              测试读图
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={usedProfiles.has(profile.id)}
                              onClick={() =>
                                setSettings({
                                  ...settings,
                                  profiles: settings.profiles.filter(
                                    (_, i) => i !== index,
                                  ),
                                })
                              }
                            >
                              <Trash2 size={13} /> 删除
                            </Button>
                          </div>
                        </footer>
                      </fieldset>
                    );
                  })}
                </div>
              </>
            )}
            {page === "runtime" && settings && (
              <>
                <header className="stage-header">
                  <div>
                    <span className="stage-kicker">RUNTIME POLICY</span>
                    <h2>运行策略</h2>
                    <p>控制模型冷却、规划预算、本地感知和恢复策略。</p>
                  </div>
                </header>
                <div className="runtime-grid">
                  <section className="runtime-block architecture-block">
                    <div className="runtime-title">
                      <BrainCircuit />
                      <div>
                        <h3>Agent 架构</h3>
                        <p>新旧逻辑并存，切换后从下一条用户输入开始生效。</p>
                      </div>
                    </div>
                    <div className="architecture-selector">
                      <button
                        className={
                          settings.architecture.mode === "staged"
                            ? "active"
                            : ""
                        }
                        onClick={() =>
                          setSettings({
                            ...settings,
                            architecture: {
                              ...settings.architecture,
                              mode: "staged",
                            },
                          })
                        }
                      >
                        <strong>阶段任务架构</strong>
                        <span>
                          一次快速分流 · 按需高级规划 · Florence 阶段检查
                        </span>
                      </button>
                      <button
                        className={
                          settings.architecture.mode === "legacy"
                            ? "active"
                            : ""
                        }
                        onClick={() =>
                          setSettings({
                            ...settings,
                            architecture: {
                              ...settings.architecture,
                              mode: "legacy",
                            },
                          })
                        }
                      >
                        <strong>旧 Mastra 架构</strong>
                        <span>保留原工具循环，供兼容与对照测试。</span>
                      </button>
                    </div>
                    <div className="runtime-fields compact-fields">
                      <label>
                        阶段最大执行次数
                        <input
                          type="number"
                          min={1}
                          max={8}
                          value={settings.architecture.stageRetryLimit}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              architecture: {
                                ...settings.architecture,
                                stageRetryLimit: Number(event.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        高级复核上限
                        <input
                          type="number"
                          min={1}
                          max={4}
                          value={settings.architecture.finalReviewLimit}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              architecture: {
                                ...settings.architecture,
                                finalReviewLimit: Number(event.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label className="switch-row inline-switch">
                        <span>
                          <strong>列表结束高级复核</strong>
                          <small>任务完成后集中调用一次复核模型。</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={settings.architecture.finalReview}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              architecture: {
                                ...settings.architecture,
                                finalReview: event.target.checked,
                              },
                            })
                          }
                        />
                      </label>
                    </div>
                  </section>
                  <section className="runtime-block local-vision">
                    <div className="runtime-title">
                      <Eye />
                      <div>
                        <h3>本地视觉链路</h3>
                        <p>无需外部 API，按证据逐级回退。</p>
                      </div>
                    </div>
                    <div className="vision-flow">
                      <span>
                        <b>FAST</b>YOLOE + SAM2
                      </span>
                      <i>→</i>
                      <span>
                        <b>SLOW</b>SAM3
                      </span>
                      <i>→</i>
                      <span>
                        <b>DESCRIBE</b>Florence
                      </span>
                    </div>
                    <label>
                      单次本地感知超时
                      <span className="unit-input">
                        <input
                          type="number"
                          min={3}
                          max={120}
                          value={
                            (settings.nodeTimeouts.perception ?? 15000) / 1000
                          }
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              nodeTimeouts: {
                                ...settings.nodeTimeouts,
                                perception: Number(event.target.value) * 1000,
                              },
                            })
                          }
                        />
                        <i>秒</i>
                      </span>
                    </label>
                    <label className="switch-row">
                      <span>
                        <strong>允许外部视觉语义回退</strong>
                        <small>本地候选无法消除歧义时才读取图片。</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={settings.images}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            images: event.target.checked,
                          })
                        }
                      />
                    </label>
                  </section>
                  <section className="runtime-block">
                    <div className="runtime-title">
                      <Gauge />
                      <div>
                        <h3>模型请求策略</h3>
                        <p>冷却关闭后，每个新请求都会重新探测首选渠道。</p>
                      </div>
                    </div>
                    <label className="switch-row danger-switch">
                      <span>
                        <strong>模型失败冷却</strong>
                        <small>
                          开启时，超时或限流会暂时跳过该渠道；关闭后不保留冷却。
                        </small>
                      </span>
                      <input
                        aria-label="模型失败冷却"
                        type="checkbox"
                        checked={
                          settings.performance.providerCooldownEnabled !== false
                        }
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            performance: {
                              ...settings.performance,
                              providerCooldownEnabled: event.target.checked,
                            },
                          })
                        }
                      />
                    </label>
                    <div className="runtime-fields">
                      <label>
                        流式首字上限
                        <span className="unit-input">
                          <input
                            type="number"
                            min={1}
                            max={120}
                            value={
                              (settings.performance.firstTokenTimeoutMs ??
                                8000) / 1000
                            }
                            onChange={(event) =>
                              setSettings({
                                ...settings,
                                performance: {
                                  ...settings.performance,
                                  firstTokenTimeoutMs:
                                    Number(event.target.value) * 1000,
                                },
                              })
                            }
                          />
                          <i>秒</i>
                        </span>
                      </label>
                      <label>
                        整轮规划上限
                        <span className="unit-input">
                          <input
                            type="number"
                            min={5}
                            max={300}
                            value={settings.performance.planningBudgetMs / 1000}
                            onChange={(event) =>
                              setSettings({
                                ...settings,
                                performance: {
                                  ...settings.performance,
                                  planningBudgetMs:
                                    Number(event.target.value) * 1000,
                                },
                              })
                            }
                          />
                          <i>秒</i>
                        </span>
                      </label>
                      <label>
                        旧架构工具轮数
                        <input
                          type="number"
                          min={1}
                          max={16}
                          value={settings.performance.toolRounds}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              performance: {
                                ...settings.performance,
                                toolRounds: Number(event.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        上下文预算
                        <input
                          type="number"
                          min={6000}
                          max={128000}
                          step={1000}
                          value={
                            settings.performance.contextBudgetTokens ?? 12000
                          }
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              performance: {
                                ...settings.performance,
                                contextBudgetTokens: Number(event.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        工具结果预算
                        <input
                          type="number"
                          min={512}
                          max={12000}
                          step={256}
                          value={
                            settings.performance.toolResultBudgetTokens ?? 1600
                          }
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              performance: {
                                ...settings.performance,
                                toolResultBudgetTokens: Number(
                                  event.target.value,
                                ),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        连续恢复次数
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={settings.recoveryBudget}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              recoveryBudget: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                    </div>
                  </section>
                  <section className="runtime-block runtime-switches">
                    <label className="switch-row">
                      <span>
                        <strong>自动监督 LLM</strong>
                        <small>关闭后未解决异常等待人工处理。</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={settings.supervisorEnabled !== false}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            supervisorEnabled: event.target.checked,
                          })
                        }
                      />
                    </label>
                    <label className="switch-row">
                      <span>
                        <strong>运动期间提前规划</strong>
                        <small>仅供旧架构预处理独立的下一任务。</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={settings.performance.lookahead}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            performance: {
                              ...settings.performance,
                              lookahead: event.target.checked,
                            },
                          })
                        }
                      />
                    </label>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        onResetLayout();
                        setNotice("工作台面板布局已恢复默认。");
                      }}
                    >
                      <RotateCcw size={14} /> 恢复工作台面板布局
                    </Button>
                  </section>
                </div>
              </>
            )}
            {page !== "tasks" && settings && (
              <footer className="settings-savebar">
                <span>
                  <Activity size={13} />
                  保存后对下一次模型或感知请求生效
                </span>
                <div>
                  {page === "routes" && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void save(true)}
                    >
                      切回默认对话渠道
                    </Button>
                  )}
                  <Button disabled={busy} onClick={() => void save()}>
                    {busy ? "正在保存…" : "保存设置"}
                  </Button>
                </div>
              </footer>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
