import { useCallback, useState } from "react";
import { Boxes, CircleHelp, LayoutPanelTop, Settings2, X } from "lucide-react";
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
import { editWorkspace, runCommand } from "@/lib/workspace-api";
import type { TimelineClip } from "@/lib/timeline";
import "@/workbench.css";
export function WorkbenchPage() {
  const conversation = useConversation();
  const robot = useRobotStatus();
  const { workspace, error, refresh } = useWorkspace();
  const [page, setPage] = useState<"scenes" | "simulation">("scenes");
  const [selectedScene, setSelectedScene] = useState<string | null>(null);
  const [enteredScene, setEnteredScene] = useState<string | null>(null);
  const [selectedClip, setSelectedClip] = useState<TimelineClip | null>(null);
  const [tab, setTab] = useState<InspectorTab>("node");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [help, setHelp] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const perform = useCallback(
    async (action: () => Promise<unknown>, message: string) => {
      setBusy(true);
      try {
        await action();
        setNotice({ text: message, error: false });
        await refresh();
      } catch (e) {
        setNotice({
          text: e instanceof Error ? e.message : "操作未完成",
          error: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  const enterScene = async () => {
    if (!selectedScene || !workspace) return;
    if (selectedScene !== workspace.scene_id) {
      setBusy(true);
      try {
        await editWorkspace("scene", { scene_id: selectedScene });
        await refresh();
      } catch (e) {
        setNotice({
          text: e instanceof Error ? e.message : "场景载入失败",
          error: true,
        });
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setEnteredScene(selectedScene);
    setPage("simulation");
    setNotice(null);
  };
  const selectClip = useCallback((clip: TimelineClip) => {
    setSelectedClip(clip);
    setTab("node");
  }, []);
  return (
    <TooltipProvider delayDuration={400}>
      <div className="workbench dark">
        <header className="app-header">
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              setPage("scenes");
            }}
            aria-label="刘工智能场景首页"
          >
            <span className="brand-mark">
              <i />
              <i />
              <i />
            </span>
            <strong>刘工智能</strong>
            <span className="brand-edition">STUDIO</span>
          </a>
          <nav className="main-navigation" aria-label="主导航">
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
        {page === "scenes" ? (
          <SceneBrowser
            workspace={workspace}
            error={error}
            selected={selectedScene}
            onSelect={setSelectedScene}
            onEnter={() => void enterScene()}
            loading={busy}
            onRefresh={() => void refresh()}
          />
        ) : (
          <>
            <main className="editor-workspace">
              <ResizablePanelGroup direction="vertical" key={layoutVersion}>
                <ResizablePanel defaultSize={55} minSize={32}>
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
                        onReset={(scope) =>
                          void perform(
                            () =>
                              scope === "home"
                                ? runCommand("home")
                                : editWorkspace("reset", { scope }),
                            scope === "home"
                              ? "机械臂已回到待机位置。"
                              : "初始状态已恢复，时间轴保留。",
                          )
                        }
                      />
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel defaultSize={45} minSize={25}>
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
                <small>
                  {!conversation.connected ? "连接中断" : "会话已连接"}
                </small>
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
        )}
        <VoiceOrb
          conversation={conversation}
          disabled={page !== "simulation"}
        />
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
        <Dialog open={help} onOpenChange={setHelp}>
          <DialogContent>
            <DialogTitle>刘工智能工作台</DialogTitle>
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
                重置恢复所选场景的初始状态。时间轴保留在当前页面，需要时可直接清空；刷新页面后重新开始记录。
              </p>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
