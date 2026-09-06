import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import {
  BrainCircuit,
  ScanEye,
  Bot,
  Ellipsis,
  ChevronRight,
  LocateFixed,
  ZoomIn,
  ZoomOut,
  Trash2,
  Hand,
  Cable,
  MousePointer2,
} from "lucide-react";
import type { RobotBusEvent } from "@/hooks/useConversation";
import {
  buildTimeline,
  linkColor,
  timecode,
  type TimelineClip,
  type Track,
} from "@/lib/timeline";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
export const tracks = [
  {
    id: "information" as Track,
    label: "信息处理",
    sub: "Language & reasoning",
    Icon: BrainCircuit,
  },
  {
    id: "vision" as Track,
    label: "视觉处理",
    sub: "Perception & tracking",
    Icon: ScanEye,
  },
  {
    id: "motion" as Track,
    label: "动作处理",
    sub: "Motion & manipulation",
    Icon: Bot,
  },
  {
    id: "other" as Track,
    label: "其他",
    sub: "System & coordination",
    Icon: Ellipsis,
  },
];
export function Timeline({
  events,
  selectedId,
  onSelect,
  onClear,
  onUpdate,
}: {
  events: RobotBusEvent[];
  selectedId?: string;
  onSelect: (clip: TimelineClip) => void;
  onClear: () => void;
  onUpdate: (clip: TimelineClip) => void;
}) {
  const clips = useMemo(() => buildTimeline(events), [events]);
  const [now, setNow] = useState(Date.now());
  const [zoom, setZoom] = useState(28);
  const [follow, setFollow] = useState(true);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hand, setHand] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; scroll: number; moved: boolean } | null>(
    null,
  );
  const running = clips.some((c) => c.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  const origin = clips[0]?.start ?? now;
  const lastTime = Math.max(
    origin,
    ...clips.map((c) => c.end ?? Math.max(c.start, now)),
  );
  const duration = Math.max(30000, lastTime - origin + 6000);
  const width = Math.max(800, (duration / 1000) * zoom);
  const position = (t: number) => ((t - origin) / 1000) * zoom;
  const playTime = cursor ?? lastTime;
  useEffect(() => {
    if (!follow || !viewport.current) return;
    const p = position(lastTime);
    const el = viewport.current;
    if (p > el.scrollLeft + el.clientWidth - 100)
      el.scrollLeft = Math.max(0, p - el.clientWidth + 140);
  }, [lastTime, zoom, follow]);
  // A selected running clip keeps its inspector up to date.
  useEffect(() => {
    const clip = clips.find((c) => c.id === selectedId);
    if (clip) onUpdate(clip);
  }, [clips]);
  const step = zoom >= 60 ? 1 : zoom >= 25 ? 5 : zoom >= 10 ? 10 : 30;
  const ticks = Array.from(
    { length: Math.ceil(duration / 1000 / step) + 1 },
    (_, i) => i * step,
  );
  const heights = tracks.map((t) =>
    Math.max(
      52,
      (Math.max(
        0,
        ...clips.filter((c) => c.track === t.id).map((c) => c.lane),
      ) +
        1) *
        36 +
        14,
    ),
  );
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (
      (event.target as HTMLElement).closest("button") &&
      !hand &&
      event.button !== 1
    )
      return;
    if (hand || event.button === 1) {
      event.preventDefault();
      drag.current = {
        x: event.clientX,
        scroll: viewport.current!.scrollLeft,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setFollow(false);
    } else if ((event.target as HTMLElement).closest(".timeline-ruler")) {
      const bounds = viewport.current!.getBoundingClientRect();
      setCursor(
        origin +
          (Math.max(
            0,
            event.clientX - bounds.left + viewport.current!.scrollLeft,
          ) /
            zoom) *
            1000,
      );
      setFollow(false);
    }
  }
  return (
    <section className="timeline-panel" aria-label="BusAgent 执行时间轴">
      <header className="panel-title timeline-title">
        <span>
          <Cable size={15} />
          执行时间轴 <small>BUSAGENT</small>
        </span>
        <div className="loop-legend">
          <i className="dot fast" />
          快环
          <i className="dot slow" />
          慢环
          <span className="divider" />
          <span>{clips.length} 个节点</span>
        </div>
      </header>
      <div className="timeline-toolbar">
        <div className="tool-cluster">
          <Tip label="选择节点 / 点击刻度定位">
            <Button
              variant="ghost"
              size="icon"
              className={!hand ? "active-tool" : ""}
              onClick={() => setHand(false)}
              aria-label="选择工具"
            >
              <MousePointer2 />
            </Button>
          </Tip>
          <Tip label="拖动浏览时间轴">
            <Button
              variant="ghost"
              size="icon"
              className={hand ? "active-tool" : ""}
              onClick={() => setHand(true)}
              aria-label="拖动浏览"
            >
              <Hand />
            </Button>
          </Tip>
          <span className="toolbar-divider" />
          <span className="timecode">{timecode(playTime - origin)}</span>
          <span className="timeline-session">当前会话</span>
        </div>
        <div className="tool-cluster">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (viewport.current)
                setZoom(
                  Math.max(
                    2,
                    Math.min(
                      120,
                      (viewport.current.clientWidth - 80) /
                        Math.max(5, (lastTime - origin) / 1000),
                    ),
                  ),
                );
            }}
          >
            适合窗口
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="缩小时间轴"
            onClick={() => setZoom((z) => Math.max(2, z / 1.5))}
          >
            <ZoomOut />
          </Button>
          <input
            aria-label="时间轴缩放"
            className="timeline-zoom"
            type="range"
            min="2"
            max="120"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="放大时间轴"
            onClick={() => setZoom((z) => Math.min(120, z * 1.5))}
          >
            <ZoomIn />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={follow ? "active-tool" : ""}
            onClick={() => {
              setFollow(!follow);
              setCursor(null);
            }}
          >
            <LocateFixed />
            跟随
          </Button>
          <Tip label="清空本页时间轴，不影响任务执行">
            <Button
              variant="ghost"
              size="icon"
              aria-label="清空时间轴"
              disabled={!clips.length}
              onClick={() => {
                onClear();
                setCursor(null);
                if (viewport.current) viewport.current.scrollLeft = 0;
              }}
            >
              <Trash2 />
            </Button>
          </Tip>
        </div>
      </div>
      <div className="timeline-body">
        <div className="track-labels">
          <div className="track-label-head">
            轨道 <span>04</span>
          </div>
          {tracks.map((track, i) => (
            <div
              className="track-label"
              key={track.id}
              style={{ height: heights[i] }}
            >
              <track.Icon size={18} />
              <div>
                {track.label}
                <small>{track.sub}</small>
              </div>
              <ChevronRight size={12} />
            </div>
          ))}
        </div>
        <div
          ref={viewport}
          className={`timeline-viewport ${hand ? "pan-mode" : ""}`}
          onPointerDown={startDrag}
          onPointerMove={(e) => {
            if (drag.current && viewport.current) {
              viewport.current.scrollLeft =
                drag.current.scroll - (e.clientX - drag.current.x);
              drag.current.moved = true;
            }
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onWheel={() => setFollow(false)}
        >
          <div className="timeline-canvas" style={{ width }}>
            <div className="timeline-ruler">
              {ticks.map((t) => (
                <span key={t} style={{ left: t * zoom }}>
                  {timecode(t * 1000)}
                </span>
              ))}
            </div>
            {tracks.map((track, i) => (
              <div
                className="timeline-track"
                key={track.id}
                style={{
                  height: heights[i],
                  backgroundSize: `${step * zoom}px 100%`,
                }}
              >
                {clips
                  .filter((c) => c.track === track.id)
                  .map((clip) => {
                    const w =
                      clip.end === undefined
                        ? position(Math.max(now, clip.start)) -
                          position(clip.start)
                        : position(clip.end) - position(clip.start);
                    const parentColor = clip.parentId
                      ? linkColor(clip.parentId)
                      : undefined;
                    return (
                      <button
                        key={clip.id}
                        className={`timeline-clip loop-${clip.loop} state-${clip.state} ${selectedId === clip.id ? "is-selected" : ""} ${!clip.precise ? "event-marker" : ""}`}
                        style={
                          {
                            left: position(clip.start),
                            top: 7 + clip.lane * 36,
                            width: Math.max(clip.precise ? 12 : 7, w),
                            "--link-in": parentColor,
                            "--link-out": linkColor(clip.id),
                          } as CSSProperties
                        }
                        onClick={() => {
                          if (hand) return;
                          onSelect(clip);
                          setCursor(clip.start);
                          setFollow(false);
                        }}
                        title={`${clip.title} · ${clip.precise ? `${((clip.end ?? now) - clip.start) / 1000}s` : "事件时刻"}${clip.state === "running" ? " · 执行中" : ""}`}
                        aria-label={`${clip.title}，${clip.precise ? (clip.state === "running" ? "执行中" : "已结束") : "事件时刻"}`}
                      >
                        <i className="clip-in" />
                        <span className="clip-name">{clip.title}</span>
                        {clip.state === "running" && (
                          <i className="clip-pulse" />
                        )}
                        <i className="clip-out" />
                      </button>
                    );
                  })}
              </div>
            ))}
            {!!clips.length && (
              <div className="playhead" style={{ left: position(playTime) }}>
                <i />
              </div>
            )}
          </div>
          {!clips.length && (
            <div className="timeline-empty">
              <Cable size={23} />
              <strong>每一次调用，都在这里展开</strong>
              <span>发出任务后，浏览节点的顺序、耗时与并行关系。</span>
            </div>
          )}
        </div>
      </div>
      <footer className="timeline-footer">
        <span>
          <i className={`dot ${running ? "fast" : ""}`} />
          {running ? "正在记录" : "等待下一次调用"}
        </span>
        <span>拖动浏览 · 滚动缩放控件 · 点击节点查看详情</span>
        <span>
          {events.length > 0 &&
          !events.some((e) => e.eventType.startsWith("node."))
            ? "事件模式 · 节点计时待接入"
            : "只读执行记录"}
        </span>
      </footer>
    </section>
  );
}
