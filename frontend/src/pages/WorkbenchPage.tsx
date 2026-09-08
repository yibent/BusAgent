import { IntelligencePanel } from "@/components/workbench/IntelligencePanel";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
  CircleHelp,
  LayoutPanelTop,
  Loader2,
  Settings2,
  Trophy,
  X,
} from "lucide-react";
import { useConversation } from "@/hooks/useConversation";
import { useRobotStatus } from "@/hooks/useRobotStatus";
import { useWorkspace } from "@/hooks/useWorkspace";
import { Button } from "@/components/ui/button";
import { TooltipProvider, Tip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { SceneBrowser } from "@/components/workbench/SceneBrowser";
import { CameraPreview } from "@/components/workbench/CameraPreview";
import { Inspector, type InspectorTab } from "@/components/workbench/Inspector";
import { Timeline } from "@/components/workbench/Timeline";
import { VoiceOrb } from "@/components/workbench/VoiceOrb";
import { Logo } from "@/components/workbench/Logo";
import {
  editWorkspace,
  runCommand,
  transitionWorkspace,
} from "@/lib/workspace-api";
import type { TimelineClip } from "@/lib/timeline";
import "@/workbench.css";
import {
  ReviewPresentation,
  isReviewLive,
} from "@/components/workbench/ReviewPresentation";
export function WorkbenchPage() {
  const conversation = useConversation();
  const robot = useRobotStatus();
  const { workspace, error, refresh } = useWorkspace();
  const [page, setPage] = useState<"review" | "scenes" | "simulation">(
    new URLSearchParams(window.location.search).has("workspace")
      ? "simulation"
      : "review",
  );
  const [reviewStep, setReviewStep] = useState(0);
  const [selectedScene, setSelectedScene] = useState<string | null>(null);
  const [enteredScene, setEnteredScene] = useState<string | null>(null);
  const [selectedClip, setSelectedClip] = useState<TimelineClip | null>(null);
  const [tab, setTab] = useState<InspectorTab>("node");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [intelligencePage, setIntelligencePage] = useState<
    "tasks" | "models" | null
  >(null);
  const [help, setHelp] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [queuePaused, setQueuePaused] = useState<boolean | null>(null);
  const [confirmation, setConfirmation] = useState<{
    scene: string;
    fullReset: boolean;
  } | null>(null);
  const [adminToken, setAdminToken] = useState("");
  const [submittingTransition, setSubmittingTransition] = useState(false);
  const knownEpoch = useRef<string | null>(null);
  const lifecycle = workspace?.lifecycle;
  const operation = lifecycle?.operation;
  const transitioning =
    !!operation && !["completed", "failed"].includes(operation.phase);
  useEffect(() => {
    if (!lifecycle) return;
    if (knownEpoch.current === null) knownEpoch.current = lifecycle.epoch;
    else if (
      knownEpoch.current !== lifecycle.epoch &&
      operation?.phase === "completed"
    ) {
      sessionStorage.clear();
      window.location.replace("/?workspace=1");
    }
  }, [lifecycle, operation]);
  const confirmTransition = async () => {
    if (!confirmation || !adminToken.trim()) return;
    setSubmittingTransition(true);
    try {
      await transitionWorkspace(confirmation.scene, adminToken.trim());
      setConfirmation(null);
      await refresh();
    } catch (e) {
      setNotice({
        text: e instanceof Error ? e.message : "场景切换未完成",
        error: true,
      });
    } finally {
      setSubmittingTransition(false);
    }
  };
  useEffect(() => {
    const abort = new AbortController();
    const update = async () => {
      try {
        const response = await fetch("/v1/tasks/status", {
          signal: abort.signal,
          cache: "no-store",
        });
        if (response.ok)
          setQueuePaused((await response.json()).paused === true);
      } catch {
        /* Existing connection indicator handles network outages. */
      }
    };
    void update();
    const timer = setInterval(() => void update(), 2000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, []);
  const perform = useCallback(
    async (action: () => Promise<unknown>, message: string) => {
      setBusy(true);
      try {
        await action();
        setNotice({ text: message, error: false });
        await refresh();
        return true;
      } catch (e) {
        setNotice({
          text: e instanceof Error ? e.message : "操作未完成",
          error: true,
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  const enterScene = async () => {
    if (!selectedScene || !workspace) return;
    if (selectedScene !== workspace.scene_id) {
      setConfirmation({ scene: selectedScene, fullReset: false });
      return;
    }
    setEnteredScene(selectedScene);
    if (page === "review") setReviewStep(8);
    else setPage("simulation");
    setNotice(null);
  };
  const selectClip = useCallback((clip: TimelineClip) => {
    setSelectedClip(clip);
    setTab("node");
  }, []);
  const surface =
    page === "scenes" || (page === "review" && reviewStep === 7) ? (
      <SceneBrowser
        workspace={workspace}
        error={error}
        selected={selectedScene}
        onSelect={(id) => {
          setSelectedScene(id);
          if (id !== workspace?.scene_id)
            setConfirmation({ scene: id, fullReset: false });
        }}
        onEnter={() => void enterScene()}
        loading={busy}
        onRefresh={() => void refresh()}
      />
    ) : (
      <>
        <main className="editor-workspace">
          <ResizablePanelGroup
            direction="vertical"
            key={`${layoutVersion}-${page === "review" ? reviewStep : "workspace"}`}
          >
            <ResizablePanel
              defaultSize={
                page === "review" ? (reviewStep === 3 ? 25 : 70) : 55
              }
              minSize={20}
            >
              <ResizablePanelGroup direction="horizontal">
                <ResizablePanel defaultSize={26} minSize={21} maxSize={75}>
                  <Inspector
                    tab={tab}
                    onTab={setTab}
                    selected={selectedClip}
                    workspace={workspace}
                    status={robot.status}
                    messages={conversation.messages}
                    busy={busy}
                    onObjectSave={async (id, values) =>
                      perform(
                        () => editWorkspace("object", { id, ...values }),
                        "物体位置与旋转已应用。",
                      )
                    }
                    onConfigSave={(values) =>
                      perform(
                        () => editWorkspace("controller", values),
                        "机械臂执行参数已应用。",
                      )
                    }
                    onRefresh={refresh}
                    onRobotSave={(values) =>
                      perform(
                        () => editWorkspace("robot", values),
                        "机械臂已移动到目标位姿",
                      )
                    }
                    onGripper={(state) =>
                      perform(
                        () => editWorkspace("gripper", { state }),
                        state === "open" ? "夹爪已打开" : "夹爪已闭合",
                      )
                    }
                  />
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel minSize={25}>
                  <CameraPreview
                    busy={busy}
                    canEdit={!!workspace?.available}
                    onStop={() => {
                      void runCommand("stop")
                        .then(() =>
                          setNotice({
                            text: "已发送中断请求，机械臂将停止当前动作。",
                            error: false,
                          }),
                        )
                        .catch((e) =>
                          setNotice({ text: e.message, error: true }),
                        );
                    }}
                    onReset={(scope) => {
                      if (scope === "full") {
                        if (workspace?.scene_id)
                          setConfirmation({
                            scene: workspace.scene_id,
                            fullReset: true,
                          });
                        return;
                      }
                      void perform(
                        () =>
                          scope === "home"
                            ? runCommand("home")
                            : editWorkspace("reset", { scope }),
                        scope === "home"
                          ? "机械臂已回到待机位置。"
                          : "初始状态已恢复，时间轴保留。",
                      );
                    }}
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              defaultSize={
                page === "review" ? (reviewStep === 3 ? 75 : 30) : 45
              }
              minSize={25}
            >
              <Timeline
                events={conversation.robotEvents}
                selectedId={selectedClip?.id}
                onSelect={selectClip}
                onUpdate={setSelectedClip}
                onClear={() => {
                  conversation.clearRobotEvents();
                  setSelectedClip(null);
                }}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </main>
        <footer className="app-statusbar">
          <span>
            <i className={`dot ${!conversation.connected ? "" : "fast"}`} />
            BusAgent{" "}
            <small>{!conversation.connected ? "连接中断" : "会话已连接"}</small>
          </span>
          <span>
            刘工智能工作台<span className="statusbar-separator">/</span>
            Franka Panda
          </span>
          <span>
            {robot.lastUpdated
              ? `状态更新 ${new Date(robot.lastUpdated).toLocaleTimeString("zh-CN", { hour12: false })}`
              : "等待状态"}
          </span>
        </footer>
      </>
    );
  return (
    <TooltipProvider delayDuration={400}>
      <div
        className={`workbench dark ${page === "review" ? "review-mode" : ""}`}
      >
        <header className="app-header">
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              setPage("review");
              setReviewStep(0);
            }}
            aria-label="刘工智能评审首页"
          >
            <Logo className="brand-logo" />
            <strong>刘工智能</strong>
            <span className="brand-edition">STUDIO</span>
          </a>
          <nav className="main-navigation" aria-label="主导航">
            <button
              className={page === "review" ? "active" : ""}
              onClick={() => {
                setPage("review");
                setReviewStep(0);
              }}
            >
              <Trophy size={14} />
              挑战杯评审
            </button>
            <button
              className={page === "scenes" ? "active" : ""}
              onClick={() => setPage("scenes")}
            >
              <Boxes size={14} />
              场景
            </button>
            <Tip
              label={enteredScene ? "进入仿真工作区" : "请先在场景页选择工作台"}
            >
              <span>
                <button
                  disabled={!enteredScene}
                  className={page === "simulation" ? "active" : ""}
                  onClick={() => setPage("simulation")}
                >
                  <LayoutPanelTop size={14} />
                  仿真
                </button>
              </span>
            </Tip>
          </nav>
          <div className="header-right">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIntelligencePage("tasks")}
            >
              {queuePaused ? "任务队列 · 已暂停" : "任务队列"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIntelligencePage("models")}
            >
              模型设置
            </Button>
            <span className="connection-status">
              <i className={`dot ${robot.connected ? "fast" : ""}`} />
              {robot.connected ? "仿真已连接" : "连接中"}
            </span>
            <span className="header-divider" />
            <Tip label="恢复默认面板布局">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setLayoutVersion((v) => v + 1)}
                aria-label="恢复面板布局"
              >
                <Settings2 />
              </Button>
            </Tip>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setHelp(true)}
              aria-label="工作台帮助"
            >
              <CircleHelp />
            </Button>
          </div>
        </header>
        {page === "review" ? (
          <ReviewPresentation
            step={reviewStep}
            onStep={setReviewStep}
            onFinish={() => {
              if (workspace?.available) {
                setEnteredScene(workspace.scene_id);
                setSelectedScene(workspace.scene_id);
                setPage("simulation");
              } else setPage("scenes");
            }}
          >
            {isReviewLive(reviewStep) ? surface : null}
          </ReviewPresentation>
        ) : (
          surface
        )}
        <div
          hidden={
            page === "review" &&
            !isReviewLive(reviewStep) &&
            !conversation.isListening &&
            !conversation.isSpeaking
          }
        >
          <VoiceOrb
            conversation={conversation}
            disabled={!workspace?.available}
          />
        </div>
        {notice && (
          <div
            className={`app-notice ${notice.error ? "error" : ""}`}
            role="status"
          >
            <span>{notice.text}</span>
            <button
              className="icon-button"
              onClick={() => setNotice(null)}
              aria-label="关闭提示"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <IntelligencePanel
          page={intelligencePage}
          onClose={() => setIntelligencePage(null)}
        />
        <Dialog
          open={!!confirmation || transitioning || submittingTransition}
          onOpenChange={(open) => {
            if (!open && !transitioning && !submittingTransition)
              setConfirmation(null);
          }}
        >
          <DialogContent
            onEscapeKeyDown={(event) => {
              if (transitioning || submittingTransition) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (transitioning || submittingTransition) event.preventDefault();
            }}
          >
            <DialogTitle>
              {transitioning || submittingTransition
                ? "正在准备工作台"
                : confirmation?.fullReset
                  ? "完全重置当前场景？"
                  : `切换到“${workspace?.scenes.find((scene) => scene.id === confirmation?.scene)?.name ?? ""}”？`}
            </DialogTitle>
            <DialogDescription>
              {transitioning
                ? operation?.message
                : "确认后会停止当前执行，清空当前场景的任务、对话、上下文、记忆、视觉缓存和仿真输出，然后重新加载所选场景。程序、模型、API 设置和服务日志保留。"}
            </DialogDescription>
            {transitioning || submittingTransition ? (
              <p role="status" className="flex items-center gap-2">
                <Loader2 className="animate-spin" size={18} />
                场景与模型正在重新初始化，完成后自动进入。
              </p>
            ) : (
              <>
                <label>
                  管理令牌
                  <input
                    className="ui-input"
                    aria-label="场景切换管理令牌"
                    type="password"
                    autoComplete="off"
                    value={adminToken}
                    onChange={(event) => setAdminToken(event.target.value)}
                    placeholder="与模型设置使用同一管理令牌"
                  />
                </label>
                <div className="flex justify-end gap-3">
                  <Button
                    variant="outline"
                    onClick={() => setConfirmation(null)}
                  >
                    取消
                  </Button>
                  <Button
                    disabled={!adminToken.trim()}
                    onClick={() => void confirmTransition()}
                  >
                    {confirmation?.fullReset ? "清空并重新加载" : "清空并切换"}
                  </Button>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
        {operation?.phase === "failed" && (
          <div className="app-notice error" role="alert">
            <span>{operation.message}</span>
            <Button
              onClick={() =>
                setConfirmation({
                  scene: operation.scene_id,
                  fullReset: operation.scene_id === workspace?.scene_id,
                })
              }
            >
              重试
            </Button>
          </div>
        )}
        <Dialog open={help} onOpenChange={setHelp}>
          <DialogContent>
            <DialogTitle>
              <Logo className="about-logo" />
              刘工智能工作台
            </DialogTitle>
            <DialogDescription>一个场景，从指令到执行。</DialogDescription>
            <div className="help-content">
              <p>
                选择场景后进入仿真。拖动面板之间的分隔线，自由调整属性区、监视器与时间轴的大小。
              </p>
              <p>
                时间轴按调用顺序展示执行历史。绿色表示快环，蓝色表示慢环，灰色表示未标注环路。点击卡片查看节点详情；选择手形工具拖动浏览，使用缩放控件查看细节。
              </p>
              <p>
                卡片有最小显示宽度，运行时缓慢增长，不按真实时间等比例缩放；实际起止时间和耗时可在节点详情查看。相同的端点颜色表示调用关系。
              </p>
              <p>
                点击悬浮球开始说话，再次点击结束。悬停或用键盘聚焦悬浮球，可打开文字输入；对话可在左侧面板查看。
              </p>
              <p>
                物体或机械臂局部复位只重建仿真状态并保留任务记录。场景切换和完全重置会在管理令牌校验后清空当前场景历史并重新加载。
              </p>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
