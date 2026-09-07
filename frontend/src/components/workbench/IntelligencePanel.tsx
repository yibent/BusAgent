import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
  thinking: boolean;
  reasoningEffort?: "low" | "high" | "max";
};
type Settings = {
  profiles: Profile[];
  roles: { planner: string; supervisor: string };
  images: boolean;
  recoveryBudget: number;
  fallbacks: { planner: string[]; supervisor: string[] };
  performance: {
    lookahead: boolean;
    requestTimeoutMs: number;
    planningBudgetMs: number;
    toolRounds: number;
  };
};
type Step = {
  id: string;
  title: string;
  skill: string;
  state: string;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
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
  planning_ahead?: string;
};
type Queue = { enabled: boolean; paused: boolean; goals: Goal[] };
const fixedThinking = (profile: Profile) =>
  profile.provider === "glm" && /^glm-5\.3(?:-|$)/i.test(profile.model);
const states: Record<string, string> = {
  queued: "等待中",
  planning: "规划中",
  running: "执行中",
  review: "监督判断中",
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

export function IntelligencePanel({
  page,
  onClose,
}: {
  page: "tasks" | "models" | null;
  onClose(): void;
}) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setQueue(await api<Queue>("/v1/tasks"));
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!page) return;
    setNotice("");
    if (page === "models") {
      void api<Settings>("/v1/model-config")
        .then(setSettings)
        .catch((e) => setNotice(e.message));
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1200);
    return () => clearInterval(timer);
  }, [page, refresh]);
  const run = async (operation: () => Promise<unknown>, success = "") => {
    setBusy(true);
    setNotice("");
    try {
      await operation();
      if (success) setNotice(success);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const control = (action: string, id?: string) =>
    run(async () => {
      setQueue(await api<Queue>("/v1/tasks/control", { action, id }));
    });
  const change = (index: number, fields: Partial<Profile>) =>
    setSettings(
      (s) =>
        s && {
          ...s,
          profiles: s.profiles.map((p, i) =>
            i === index ? { ...p, ...fields } : p,
          ),
        },
    );
  const testModel = (profile: string, vision = false) =>
    run(async () => {
      setSettings(await api<Settings>("/v1/model-config", { settings, token }));
      const result = await api<{
        model: string;
        elapsed_ms: number;
        message: string;
      }>("/v1/model-config/test", { token, profile, vision });
      setNotice(
        `${result.model} ${vision ? "读图" : "连接"}测试完成，耗时 ${(result.elapsed_ms / 1000).toFixed(1)} 秒。${vision ? result.message : ""}`,
      );
    });
  return (
    <Dialog
      open={page !== null}
      onOpenChange={(open) => {
        if (!open) {
          setToken("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogTitle>
          {page === "tasks" ? "任务队列" : "模型与智能设置"}
        </DialogTitle>
        <DialogDescription>
          {page === "tasks"
            ? "新任务依次排队，监督模型按实际结果调整剩余步骤。"
            : "规划与监督可分别选择模型。图片默认不进入上下文，仅在模型请求时读取。"}
        </DialogDescription>
        <div className="intelligence-panel">
          {notice && (
            <p role="status" className="intelligence-notice">
              {notice}
            </p>
          )}
          {page === "tasks" && (
            <>
              <div className="intelligence-toolbar">
                <span>
                  {queue?.enabled
                    ? queue.paused
                      ? "队列已暂停"
                      : "自主规划已启用"
                    : "自主规划尚未启用"}
                </span>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void control(queue?.paused ? "resume" : "pause")
                  }
                >
                  {queue?.paused ? "恢复队列" : "暂停队列"}
                </Button>
              </div>
              {!queue?.goals.length && (
                <p className="intelligence-empty">
                  还没有任务。通过文字或语音下达指令后，计划与执行进度会显示在这里。
                </p>
              )}
              {queue?.goals.map((goal) => (
                <article className="goal-card" key={goal.id}>
                  <div className="goal-heading">
                    <strong>{goal.source}</strong>
                    <span data-state={goal.state}>
                      {states[goal.state] ?? goal.state}
                    </span>
                  </div>
                  {goal.summary && <p>{goal.summary}</p>}
                  {goal.completion && (
                    <p className="goal-criterion">
                      完成条件：{goal.completion}
                    </p>
                  )}
                  {goal.message && <p>{goal.message}</p>}
                  <ol>
                    {goal.steps.map((step) => (
                      <li key={step.id} data-state={step.state}>
                        <span>{step.title}</span>
                        <small>
                          {states[step.state] ?? step.state} · {step.skill}
                          {step.params.mode
                            ? ` · ${String(step.params.mode)}`
                            : ""}
                          {step.params.slow_provider
                            ? ` · ${String(step.params.slow_provider)}`
                            : ""}
                        </small>
                        {step.result && (
                          <details>
                            <summary>执行反馈</summary>
                            <pre>{JSON.stringify(step.result, null, 2)}</pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ol>
                  <div className="goal-actions">
                    <small>
                      模型调用 {goal.model_calls} 次
                      {goal.planning_ahead
                        ? ` · ${{ started: "后台准备中", ready: "计划已提前准备", used: "已采用提前规划", discarded: "将根据新状态规划" }[goal.planning_ahead] ?? ""}`
                        : ""}
                    </small>
                    {["blocked", "paused"].includes(goal.state) && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void control("retry", goal.id)}
                      >
                        恢复此任务
                      </Button>
                    )}
                    {goal.state === "queued" && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void control("up", goal.id)}
                      >
                        向前移动
                      </Button>
                    )}
                    {!["completed", "cancelled"].includes(goal.state) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void control("cancel", goal.id)}
                      >
                        取消
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </>
          )}
          {page === "models" && settings && (
            <>
              <label>
                管理令牌
                <input
                  aria-label="管理令牌"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="用于保存设置和测试模型"
                />
              </label>
              <div className="model-role-grid">
                {(["planner", "supervisor"] as const).map((role) => (
                  <label key={role}>
                    {role === "planner" ? "任务规划模型" : "任务监督模型"}
                    <select
                      value={settings.roles[role]}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          roles: { ...settings.roles, [role]: e.target.value },
                        })
                      }
                    >
                      {settings.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={settings.images}
                  onChange={(e) =>
                    setSettings({ ...settings, images: e.target.checked })
                  }
                />
                允许模型按需读取相机图片
              </label>
              <div className="model-role-grid">
                {(["planner", "supervisor"] as const).map((role) => (
                  <label key={role}>
                    {role === "planner"
                      ? "规划失败时的备用模型"
                      : "监督失败时的备用模型"}
                    <select
                      value={settings.fallbacks[role][0] ?? ""}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          fallbacks: {
                            ...settings.fallbacks,
                            [role]: e.target.value ? [e.target.value] : [],
                          },
                        })
                      }
                    >
                      <option value="">不自动切换</option>
                      {settings.profiles
                        .filter(
                          (p) =>
                            p.enabled &&
                            p.configured &&
                            p.id !== settings.roles[role],
                        )
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={settings.performance.lookahead}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      performance: {
                        ...settings.performance,
                        lookahead: e.target.checked,
                      },
                    })
                  }
                />
                运动期间提前规划独立的下一条任务
              </label>
              <div className="model-role-grid">
                <label>
                  单次模型等待上限（秒）
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={settings.performance.requestTimeoutMs / 1000}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        performance: {
                          ...settings.performance,
                          requestTimeoutMs: Number(e.target.value) * 1000,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  每轮规划总等待预算（秒）
                  <input
                    type="number"
                    min={5}
                    max={300}
                    value={settings.performance.planningBudgetMs / 1000}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        performance: {
                          ...settings.performance,
                          planningBudgetMs: Number(e.target.value) * 1000,
                        },
                      })
                    }
                  />
                </label>
              </div>
              <label>
                连续恢复预算
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={settings.recoveryBudget}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      recoveryBudget: Number(e.target.value),
                    })
                  }
                />
              </label>
              {settings.profiles.map((p, index) => (
                <fieldset className="model-profile" key={p.id}>
                  <legend>{p.name}</legend>
                  <label>
                    名称
                    <input
                      value={p.name}
                      onChange={(e) => change(index, { name: e.target.value })}
                    />
                  </label>
                  <label>
                    接口类型
                    <select
                      value={p.provider}
                      onChange={(e) =>
                        change(index, { provider: e.target.value })
                      }
                    >
                      <option value="qwen">Qwen</option>
                      <option value="glm">智谱 GLM</option>
                      <option value="openai-compatible">OpenAI 兼容接口</option>
                    </select>
                  </label>
                  <label>
                    Base URL
                    <input
                      value={p.baseUrl}
                      onChange={(e) =>
                        change(index, { baseUrl: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    模型 ID
                    <input
                      value={p.model}
                      onChange={(e) => change(index, { model: e.target.value })}
                    />
                  </label>
                  <label>
                    API Key
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={p.apiKey ?? ""}
                      placeholder={
                        p.configured ? "已配置，留空保留原密钥" : "尚未配置"
                      }
                      onChange={(e) =>
                        change(index, { apiKey: e.target.value })
                      }
                    />
                  </label>
                  <div className="model-flags">
                    {(["enabled", "vision", "thinking"] as const).map(
                      (key, i) => (
                        <label className="check-label" key={key}>
                          <input
                            type="checkbox"
                            checked={
                              key === "thinking" && fixedThinking(p)
                                ? true
                                : p[key]
                            }
                            disabled={key === "thinking" && fixedThinking(p)}
                            onChange={(e) =>
                              change(index, { [key]: e.target.checked })
                            }
                          />
                          {key === "thinking" && fixedThinking(p)
                            ? "此模型始终开启思考"
                            : ["启用", "支持图像", "开启思考"][i]}
                        </label>
                      ),
                    )}
                  </div>
                  {fixedThinking(p) && (
                    <label>
                      思考强度
                      <select
                        value={p.reasoningEffort ?? "low"}
                        onChange={(e) =>
                          change(index, {
                            reasoningEffort: e.target
                              .value as Profile["reasoningEffort"],
                          })
                        }
                      >
                        <option value="low">低（优先速度）</option>
                        <option value="high">高</option>
                        <option value="max">最高</option>
                      </select>
                    </label>
                  )}
                  <div className="model-flags">
                    <Button
                      size="sm"
                      disabled={busy || !token}
                      onClick={() => void testModel(p.id)}
                    >
                      保存并测试连接
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !token || !p.vision || !settings.images}
                      onClick={() => void testModel(p.id, true)}
                    >
                      保存并测试读图
                    </Button>
                  </div>
                </fieldset>
              ))}
              <div className="intelligence-toolbar">
                <Button
                  variant="ghost"
                  onClick={() =>
                    setSettings({
                      ...settings,
                      profiles: [
                        ...settings.profiles,
                        {
                          id: `custom-${Date.now()}`,
                          name: "新模型",
                          provider: "openai-compatible",
                          baseUrl: "",
                          model: "",
                          enabled: false,
                          configured: false,
                          vision: true,
                          thinking: false,
                        },
                      ],
                    })
                  }
                >
                  添加模型
                </Button>
                <Button
                  disabled={busy || !token}
                  onClick={() =>
                    void run(
                      async () =>
                        setSettings(
                          await api<Settings>("/v1/model-config", {
                            settings,
                            token,
                          }),
                        ),
                      "已保存，下次模型请求生效。",
                    )
                  }
                >
                  保存设置
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
