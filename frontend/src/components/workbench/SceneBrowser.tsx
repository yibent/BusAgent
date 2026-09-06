import {
  ArrowUpRight,
  Box,
  Check,
  Layers3,
  Loader2,
  Radio,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WorkspaceState, ScenePreset } from "@/lib/workspace-api";
import { presets, arenaUrl } from "@/lib/workspace-api";
function SceneDiagram({ kind }: { kind: string }) {
  return (
    <svg
      className={`scene-diagram ${kind}`}
      viewBox="0 0 440 230"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id={`grid-${kind}`}
          width="24"
          height="24"
          patternUnits="userSpaceOnUse"
        >
          <path d="M 24 0 H 0 V 24" stroke="#343a3f" strokeWidth=".5" />
        </pattern>
      </defs>
      <rect
        x="34"
        y="16"
        width="372"
        height="200"
        rx="4"
        fill="#242a2e"
        stroke="#485158"
      />
      <rect
        x="34"
        y="16"
        width="372"
        height="200"
        fill={`url(#grid-${kind})`}
      />
      <path d="M70 180 H92 M81 169 V191" stroke="#6d777f" />
      <circle cx="130" cy="134" r="41" stroke="#55616a" strokeDasharray="3 5" />
      <circle cx="130" cy="134" r="21" fill="#757d83" stroke="#a2a9ad" />
      <path
        d="M130 134 L174 114 L191 78"
        stroke="#414c54"
        strokeWidth="26"
        strokeLinecap="round"
      />
      <path
        d="M130 134 L174 114 L191 78"
        stroke="#d7dadb"
        strokeWidth="19"
        strokeLinecap="round"
      />
      <circle cx="174" cy="114" r="10" fill="#8b979f" />
      <path
        d="M191 78 L204 73 M200 67 L207 78"
        stroke="#e4e5e6"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <rect
        x={kind === "sort" ? 219 : 236}
        y={kind === "sort" ? 132 : 104}
        width="23"
        height="23"
        rx="2"
        fill="#c25b53"
        stroke="#e49b93"
      />
      <circle
        cx={kind === "sort" ? 289 : 280}
        cy={kind === "sort" ? 75 : 117}
        r="13"
        fill="#c69a4c"
        stroke="#e4c482"
      />
      <rect
        x="295"
        y="153"
        width="62"
        height="36"
        rx="2"
        fill="#446b98"
        fillOpacity=".45"
        stroke="#6687b0"
      />
      {kind === "stack" && (
        <>
          <path
            d="M249 88 V60 H324 V139"
            stroke="#98a4ad"
            strokeDasharray="4 4"
          />
          <path d="m318 132 6 8 6-8" stroke="#98a4ad" />
        </>
      )}
      <text x="51" y="39" fill="#7f8b94" fontFamily="monospace" fontSize="9">
        PANDA / {kind.toUpperCase()}
      </text>
      <text x="343" y="204" fill="#69757c" fontFamily="monospace" fontSize="8">
        TOP VIEW
      </text>
    </svg>
  );
}
export function SceneBrowser({
  workspace,
  error,
  selected,
  onSelect,
  onEnter,
  loading,
  onRefresh,
}: {
  workspace: WorkspaceState | null;
  error: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onEnter: () => void;
  loading: boolean;
  onRefresh: () => void;
}) {
  const scenes = workspace?.scenes ?? presets;
  const chosen = scenes.find((s) => s.id === selected);
  return (
    <main className="scene-browser">
      <div className="scene-heading">
        <div>
          <div className="eyebrow">WORKSPACE / SCENES</div>
          <h1>从一个场景开始。</h1>
          <p>选择工作台，连接机械臂，开始你的下一次实验。</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw />
          刷新场景
        </Button>
      </div>
      {error && (
        <div className="inline-notice" role="status">
          场景服务暂未连接 · {error}
        </div>
      )}
      <div className="scene-section-label">
        <span>
          <Layers3 size={14} />
          工作台预设
        </span>
        <span>{scenes.length.toString().padStart(2, "0")} SCENES</span>
      </div>
      <div className="scene-cards">
        {scenes.map((scene: ScenePreset, index) => (
          <button
            className={`scene-card ${selected === scene.id ? "selected" : ""}`}
            key={scene.id}
            onClick={() => onSelect(scene.id)}
            aria-pressed={selected === scene.id}
          >
            <div className="scene-art">
              <SceneDiagram kind={scene.kind} />
              {scene.kind === "live" && (
                <img
                  src={arenaUrl("/api/frame/scene.jpg")}
                  alt="当前工作台画面"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              )}
              <span className="scene-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              {selected === scene.id && (
                <span className="scene-check">
                  <Check size={13} />
                </span>
              )}
            </div>
            <div className="scene-card-body">
              <div className="scene-name">
                {scene.name}
                <ArrowUpRight size={16} />
              </div>
              <p>{scene.description}</p>
              <footer>
                <span>
                  <Box size={12} />
                  Franka Panda
                </span>
                <span>
                  {scene.active || scene.id === workspace?.scene_id ? (
                    <>
                      <i className="dot fast" />
                      运行中
                    </>
                  ) : (
                    "预设布局"
                  )}
                </span>
              </footer>
            </div>
          </button>
        ))}
      </div>
      <div className="scene-start-bar">
        <div className="scene-selected-icon">
          <Radio size={20} />
        </div>
        <div>
          <strong>{chosen ? chosen.name : "选择场景以进入仿真"}</strong>
          <p>
            {chosen
              ? !workspace?.available && chosen.id !== "current"
                ? "此预设需仿真端启用场景接口。可先连接当前工作台。"
                : "进入后可查看实时画面、发出任务并浏览执行时间轴。"
              : "场景配置和执行记录将在同一个工作区中呈现。"}
          </p>
        </div>
        <Button
          onClick={onEnter}
          disabled={
            !selected ||
            loading ||
            !workspace ||
            (!workspace.available && selected !== "current")
          }
          className="enter-button"
        >
          {loading ? <Loader2 className="animate-spin" /> : null}进入仿真
          <ArrowUpRight size={16} />
        </Button>
      </div>
      <div className="scene-footnote">
        <span>
          <i className={`dot ${workspace ? "fast" : ""}`} />
          {workspace ? "已发现仿真服务" : "等待仿真服务连接"}
        </span>
        <span>ISAAC SIM · ISAACLAB ARENA · PANDA</span>
      </div>
    </main>
  );
}
