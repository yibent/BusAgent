import {
  useEffect,
  useLayoutEffect,
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
  layoutTimeline,
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
  const [zoom, setZoom] = useState(1);
  const [follow, setFollow] = useState(true);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [hand, setHand] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0, labels: 178 });
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
  } | null>(null);
  const running = clips.some((c) => c.state === "running");
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () =>
      setSize({
        width: el.clientWidth,
        height: el.clientHeight,
        labels:
          parseFloat(
            getComputedStyle(el).getPropertyValue("--track-label-width"),
          ) || 178,
      });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);
  const layout = useMemo(
    () => layoutTimeline(clips, now, zoom),
    [clips, now, zoom],
  );
  const origin = clips[0]?.start ?? now;
  const lastTime = Math.max(
    origin,
    ...clips.map((c) => c.end ?? Math.max(c.start, now)),
  );
  const cursor = layout.items.find((item) => item.clip.id === cursorId);
  const playTime = cursor?.clip.start ?? lastTime;
  const playX = cursor?.x ?? layout.end;
  const availableWidth = Math.max(0, size.width - size.labels);
  const width = Math.max(availableWidth, layout.width);
  const laneCounts = tracks.map((track) =>
    Math.max(
      1,
      ...clips.filter((c) => c.track === track.id).map((c) => c.lane + 1),
    ),
  );
  const minimumHeights = laneCounts.map((count) => count * 36 + 4);
  const spareHeight = Math.max(
    0,
    size.height - 30 - minimumHeights.reduce((a, b) => a + b, 0),
  );
  const heights = minimumHeights.map((height) => height + spareHeight / 4);
  const ticks = layout.items.filter(
    (item, index, all) => index === 0 || item.x - all[index - 1].x >= 50,
  );
  useEffect(() => {
    if (!follow || !viewport.current) return;
    const el = viewport.current;
    if (playX > el.scrollLeft + availableWidth - 160 || playX < el.scrollLeft) {
      el.scrollLeft = Math.max(0, playX - availableWidth + 180);
    }
  }, [playX, follow, availableWidth]);
  useEffect(() => {
    const clip = clips.find((c) => c.id === selectedId);
    if (clip) onUpdate(clip);
  }, [clips, selectedId, onUpdate]);
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (
      (event.target as HTMLElement).closest(".track-label, .track-label-head")
    )
      return;
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
        y: event.clientY,
        scrollX: viewport.current!.scrollLeft,
        scrollY: viewport.current!.scrollTop,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setFollow(false);
    } else if (
      (event.target as HTMLElement).closest(".timeline-ruler") &&
      layout.items.length
    ) {
      const bounds = viewport.current!.getBoundingClientRect();
      const x =
        event.clientX -
        bounds.left -
        size.labels +
        viewport.current!.scrollLeft;
      const closest = layout.items.reduce((a, b) =>
        Math.abs(a.x - x) < Math.abs(b.x - x) ? a : b,
      );
      setCursorId(closest.clip.id);
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
          <span className="timeline-session">调用顺序</span>
        </div>
        <div className="tool-cluster">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setZoom(1);
              setCursorId(null);
              setFollow(true);
            }}
          >
            默认视图
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="缩小时间轴"
            onClick={() => setZoom((z) => Math.max(0.8, z - 0.15))}
          >
            <ZoomOut />
          </Button>
          <input
            aria-label="时间轴缩放"
            className="timeline-zoom"
            type="range"
            min="0.8"
            max="1.8"
            step="0.05"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="放大时间轴"
            onClick={() => setZoom((z) => Math.min(1.8, z + 0.15))}
          >
            <ZoomIn />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={follow ? "active-tool" : ""}
            onClick={() => {
              setFollow(!follow);
              setCursorId(null);
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
                setCursorId(null);
                if (viewport.current) {
                  viewport.current.scrollLeft = 0;
                  viewport.current.scrollTop = 0;
                }
              }}
            >
              <Trash2 />
            </Button>
          </Tip>
        </div>
      </div>
      <div className="timeline-body">
        <div
          ref={viewport}
          className={`timeline-viewport ${hand ? "pan-mode" : ""}`}
          onPointerDown={startDrag}
          onPointerMove={(event) => {
            if (drag.current && viewport.current) {
              viewport.current.scrollLeft =
                drag.current.scrollX - (event.clientX - drag.current.x);
              viewport.current.scrollTop =
                drag.current.scrollY - (event.clientY - drag.current.y);
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
          <div
            className="timeline-canvas"
            style={{
              width: width + size.labels,
              gridTemplateRows: `30px ${heights.map((h) => `${h}px`).join(" ")}`,
            }}
          >
            <div className="track-label-head">
              轨道<span>04</span>
            </div>
            <div className="timeline-ruler">
              {ticks.map((item) => (
                <span
                  key={item.clip.id}
                  style={{ left: item.x }}
                  title={new Date(item.clip.start).toLocaleTimeString("zh-CN", {
                    hour12: false,
                  })}
                >
                  #{String(item.index + 1).padStart(3, "0")}
                </span>
              ))}
            </div>
            {tracks.map((track, i) => (
              <div className="timeline-row" key={track.id}>
                <div className="track-label">
                  <track.Icon size={18} />
                  <div>
                    {track.label}
                    <small>{track.sub}</small>
                  </div>
                  <ChevronRight size={12} />
                </div>
                <div className="timeline-track" data-track={track.id}>
                  {layout.items
                    .filter((item) => item.clip.track === track.id)
                    .map((item) => {
                      const { clip } = item;
                      return (
                        <button
                          key={clip.id}
                          className={`timeline-clip loop-${clip.loop} state-${clip.state} ${selectedId === clip.id ? "is-selected" : ""}`}
                          style={
                            {
                              left: item.x,
                              top:
                                (heights[i] - laneCounts[i] * 36) / 2 +
                                clip.lane * 36 +
                                3,
                              width: item.width,
                              "--link-in": clip.parentId
                                ? linkColor(clip.parentId)
                                : undefined,
                              "--link-out": linkColor(clip.id),
                            } as CSSProperties
                          }
                          onClick={() => {
                            if (hand) return;
                            onSelect(clip);
                            setCursorId(clip.id);
                            setFollow(false);
                          }}
                          title={`${clip.title} · ${clip.precise ? `${(((clip.end ?? now) - clip.start) / 1000).toFixed(2)}s` : "事件时刻"}${clip.state === "running" ? " · 执行中" : ""}`}
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
              </div>
            ))}
            {!!clips.length && (
              <div className="playhead" style={{ left: size.labels + playX }}>
                <i />
              </div>
            )}
          </div>
        </div>
        {!clips.length && (
          <div className="timeline-empty">
            <Cable size={23} />
            <strong>每一次调用，都在这里展开</strong>
            <span>发出任务后，浏览节点的顺序与并行关系。</span>
          </div>
        )}
      </div>
      <footer className="timeline-footer">
        <span>
          <i className={`dot ${running ? "fast" : ""}`} />
          {running ? "正在记录" : "等待下一次调用"}
        </span>
        <span>按顺序展示 · 真实耗时见节点详情</span>
        <span>只读执行记录</span>
      </footer>
    </section>
  );
}
