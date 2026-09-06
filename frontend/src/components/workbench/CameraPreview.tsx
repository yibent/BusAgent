import { useEffect, useRef, useState } from "react";
import {
  Camera,
  ChevronDown,
  Expand,
  Grid2X2,
  Monitor,
  RotateCcw,
  Square,
  Unplug,
  Video,
} from "lucide-react";
import { arenaUrl } from "@/lib/workspace-api";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
export type CameraView = "scene" | "side" | "wrist" | "all";
const views = [
  { id: "scene" as const, name: "工作区", short: "CAM 01" },
  { id: "side" as const, name: "侧视图", short: "CAM 02" },
  { id: "wrist" as const, name: "腕部视图", short: "CAM 03" },
];
export function CameraFeed({
  view,
  quality = 1,
  onFocus,
}: {
  view: (typeof views)[number];
  quality?: number;
  onFocus?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "live" | "error">("loading");
  const [size, setSize] = useState("");
  const [lastFrame, setLastFrame] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function update() {
      let image: ImageBitmap | undefined;
      try {
        if (document.hidden) return;
        const response = await fetch(arenaUrl(`/api/frame/${view.id}.jpg`), {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(6000),
          ]),
        });
        if (!response.ok) throw new Error("Frame unavailable");
        image = await createImageBitmap(await response.blob());
        if (!active || !canvas.current) return;
        const width = Math.round(image.width * quality),
          height = Math.round(image.height * quality);
        const el = canvas.current;
        if (el.width !== width || el.height !== height) {
          el.width = width;
          el.height = height;
        }
        el.getContext("2d")?.drawImage(image, 0, 0, width, height);
        setSize(`${width} × ${height}`);
        setState("live");
        setLastFrame(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      } catch {
        if (active) setState("error");
      } finally {
        image?.close();
        if (active) timer = setTimeout(update, 200);
      }
    }
    void update();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [view.id, quality]);
  return (
    <div className={`camera-feed ${view.id}`}>
      <div className="camera-label">
        <span>{view.short}</span>
        {view.name}
      </div>
      <canvas ref={canvas} aria-label={`${view.name}实时画面`} />
      {state !== "live" && (
        <div className="camera-placeholder">
          {state === "error" ? <Unplug size={24} /> : <Camera size={24} />}
          <strong>
            {state === "error" ? "画面连接中断" : "正在连接摄像头"}
          </strong>
          <span>
            {state === "error"
              ? "保留最后一帧 · 自动重连中"
              : "等待 Isaac Sim 画面"}
          </span>
        </div>
      )}
      <div className="camera-meta">
        <span>
          <i className={`dot ${state === "live" ? "fast" : ""}`} />
          {state === "live" ? "LIVE" : "OFFLINE"}
        </span>
        <span>
          {size || "—"}
          <b>{lastFrame}</b>
        </span>
      </div>
      {onFocus && (
        <button
          className="camera-expand icon-button"
          onClick={onFocus}
          aria-label={`单独预览${view.name}`}
        >
          <Expand size={13} />
        </button>
      )}
    </div>
  );
}
export function CameraPreview({
  onStop,
  onReset,
  busy,
  canEdit,
}: {
  onStop: () => void;
  onReset: (scope: string) => void;
  busy: boolean;
  canEdit: boolean;
}) {
  const [view, setView] = useState<CameraView>("all");
  const [quality, setQuality] = useState(1);
  const root = useRef<HTMLElement>(null);
  const [fullscreenError, setFullscreenError] = useState(false);
  return (
    <section
      className="preview-panel"
      ref={root}
      aria-label="Isaac Sim 实时预览"
    >
      <header className="panel-title">
        <span>
          <Video size={15} />
          仿真监视器 <small>ISAAC SIM</small>
        </span>
        <div className="tool-cluster">
          <Tip label="中断机械臂当前动作">
            <Button
              className="stop-button"
              variant="ghost"
              size="sm"
              onClick={onStop}
            >
              <Square size={12} fill="currentColor" />
              中断
            </Button>
          </Tip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" disabled={busy}>
                <RotateCcw />
                重置
                <ChevronDown size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!canEdit}
                onSelect={() => onReset("all")}
              >
                物体与机械臂
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canEdit}
                onSelect={() => onReset("objects")}
              >
                仅物体位置
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canEdit}
                onSelect={() => onReset("robot")}
              >
                仅机械臂状态
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onReset("home")}>
                机械臂回到待机位置
              </DropdownMenuItem>
              <DropdownMenuItem disabled>时间轴不会自动清空</DropdownMenuItem>
              <DropdownMenuItem disabled>
                {canEdit
                  ? "恢复所选场景的初始状态"
                  : "场景重置等待仿真端接口更新"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="preview-toolbar">
        <div className="view-tabs" role="group" aria-label="预览视角">
          {views.map((v) => (
            <button
              key={v.id}
              aria-pressed={view === v.id}
              onClick={() => setView(v.id)}
            >
              {v.name}
            </button>
          ))}
          <button aria-pressed={view === "all"} onClick={() => setView("all")}>
            <Grid2X2 size={13} />
            三视图
          </button>
        </div>
        <div className="tool-cluster">
          <Tip label="调整预览显示采样，不改变视觉模型输入">
            <label className="quality-select">
              精度
              <select
                aria-label="预览精度"
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
              >
                <option value={1}>完整</option>
                <option value={0.5}>1/2</option>
                <option value={0.25}>1/4</option>
              </select>
            </label>
          </Tip>
          <Tip label={fullscreenError ? "浏览器不支持全屏" : "全屏预览"}>
            <Button
              variant="ghost"
              size="icon"
              aria-label="全屏预览"
              onClick={() => {
                const action = document.fullscreenElement
                  ? document.exitFullscreen()
                  : root.current?.requestFullscreen?.();
                action?.catch(() => setFullscreenError(true));
              }}
            >
              <Expand />
            </Button>
          </Tip>
        </div>
      </div>
      <div
        className={`camera-grid ${view === "all" ? "three-views" : "single-view"}`}
      >
        {views
          .filter((v) => view === "all" || view === v.id)
          .map((v) => (
            <CameraFeed
              key={v.id}
              view={v}
              quality={quality}
              onFocus={view === "all" ? () => setView(v.id) : undefined}
            />
          ))}
      </div>
      <footer className="preview-footer">
        <span>
          <Monitor size={12} />
          Franka Panda
        </span>
        <span>
          {view === "all"
            ? "工作区 / 侧视图 / 腕部视图"
            : views.find((v) => v.id === view)?.name}
        </span>
        <span>RGB 预览</span>
      </footer>
    </section>
  );
}
