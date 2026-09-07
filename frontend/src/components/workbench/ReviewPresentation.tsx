import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Brain,
  Check,
  Eye,
  Hand,
  Layers3,
  Play,
  RotateCcw,
  ScanLine,
  Workflow,
  ZoomIn,
} from "lucide-react";
import { Logo } from "./Logo";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import "@/review.css";

const chapters = [
  "欢迎",
  "访问准备",
  "并行响应",
  "执行时间轴",
  "视觉感知",
  "记忆与学习",
  "抓取与放置",
  "场景与对话",
  "仿真工作台",
];
export const isReviewLive = (step: number) => [3, 7, 8].includes(step);

function Figure({
  src,
  alt,
  caption,
}: {
  src: string;
  alt: string;
  caption: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <figure className="review-figure">
      <button onClick={() => setOpen(true)} aria-label={`放大：${alt}`}>
        <img src={src} alt={alt} />
        <span>
          <ZoomIn size={14} /> 点击放大
        </span>
      </button>
      <figcaption>{caption}</figcaption>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="review-image-dialog">
          <DialogTitle>{alt}</DialogTitle>
          <DialogDescription>{caption}</DialogDescription>
          <img src={src} alt={alt} />
        </DialogContent>
      </Dialog>
    </figure>
  );
}

function ParallelTimeline() {
  const [playing, setPlaying] = useState(false);
  const [run, setRun] = useState(0);
  return (
    <div className="review-comparison">
      <div className="review-chart-top">
        <span>相同指令、模型与硬件 · 两种调度方式</span>
        <button
          onClick={() => {
            setPlaying(true);
            setRun((v) => v + 1);
          }}
        >
          <Play size={13} /> 播放示意
        </button>
      </div>
      <div
        className={`review-chart ${playing ? "playing" : ""}`}
        key={run}
        onAnimationEnd={() => setPlaying(false)}
      >
        <div className="review-ruler">
          <span />
          {[0, 1, 2, 3, 4, 5].map((s) => (
            <span key={s}>{s} s</span>
          ))}
        </div>
        <div className="review-lane serial">
          <b>
            串行基线<small>单主模型</small>
          </b>
          <div className="review-track">
            <span style={{ left: 0, width: "62%" }}>
              转写 / 理解 / 视觉 / 规划
            </span>
            <span style={{ left: "62%", width: "34%" }}>回复 / 语音合成</span>
            <em style={{ left: "62%" }}>3.4 s 启动</em>
            <strong>5.2 s 首句</strong>
          </div>
        </div>
        <div className="review-lane">
          <b>
            BusAgent<small>对话 / 语音</small>
          </b>
          <div className="review-track">
            <span
              className="chart-speech"
              style={{ left: "11%", width: "31%" }}
            >
              流式语音
            </span>
            <em style={{ left: "11%" }}>0.62 s 首句</em>
          </div>
        </div>
        <div className="review-lane">
          <b>理解 / 规划</b>
          <div className="review-track">
            <span className="chart-slow" style={{ left: "7%", width: "26%" }}>
              理解 / 规划 / 校验
            </span>
          </div>
        </div>
        <div className="review-lane">
          <b>视觉 / 抓取</b>
          <div className="review-track">
            <span className="chart-fast" style={{ left: "13%", width: "20%" }}>
              视觉 / 抓取
            </span>
          </div>
        </div>
        <div className="review-lane">
          <b>
            arm-01<small>机械臂执行</small>
          </b>
          <div className="review-track">
            <span
              className="chart-motion"
              style={{ left: "33%", width: "37%" }}
            >
              抓取 / 搬运 / 放置
            </span>
            <em style={{ left: "33%" }}>1.8 s 启动</em>
            <strong style={{ left: "71%" }}>3.8 s 完成</strong>
          </div>
        </div>
        {playing && <div className="review-playhead" />}
      </div>
      <p className="review-footnote">
        方案示意，非当前系统实测。只并行无依赖的工作，机械臂在规划与校验通过后启动。
      </p>
    </div>
  );
}

function Highlights({
  targets,
}: {
  targets: { selector: string; label: string }[];
}) {
  const [rects, setRects] = useState<
    {
      top: number;
      left: number;
      width: number;
      height: number;
      label: string;
    }[]
  >([]);
  const key = JSON.stringify(targets);
  useEffect(() => {
    const selected = JSON.parse(key) as typeof targets;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setRects(
          selected.flatMap(({ selector, label }) => {
            const element = document.querySelector(selector);
            if (!element) return [];
            const r = element.getBoundingClientRect();
            if (!r.width || !r.height) return [];
            const boundary = element
              .closest(".review-live-surface")
              ?.getBoundingClientRect();
            const top = Math.max(r.top, boundary?.top ?? r.top);
            const bottom = Math.min(r.bottom, boundary?.bottom ?? r.bottom);
            if (bottom <= top) return [];
            return [
              {
                top: top + 2,
                left: r.left + 2,
                width: r.width - 4,
                height: bottom - top - 4,
                label,
              },
            ];
          }),
        ),
      );
    };
    const observer = new ResizeObserver(measure);
    selected.forEach(({ selector }) => {
      const el = document.querySelector(selector);
      if (el) observer.observe(el);
    });
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [key]);
  return (
    <div className="review-highlights" aria-hidden="true">
      {rects.map((r) => (
        <div
          className={`review-highlight ${r.width < 100 ? "review-small-target" : ""}`}
          key={r.label}
          style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
        >
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export function ReviewPresentation({
  step,
  onStep,
  onFinish,
  children,
}: {
  step: number;
  onStep: (step: number) => void;
  onFinish: () => void;
  children?: ReactNode;
}) {
  const live = isReviewLive(step);
  const [focus, setFocus] = useState(0);
  useEffect(() => setFocus(0), [step]);
  const targets =
    step === 3
      ? [{ selector: ".timeline-panel", label: "执行时间轴" }]
      : step === 7
        ? [
            {
              selector: focus === 0 ? ".scene-cards" : ".voice-orb",
              label:
                focus === 0
                  ? "① 选择场景 → 进入仿真"
                  : "② 点击头像开始 / 结束聆听",
            },
          ]
        : [
            {
              selector: focus === 0 ? ".inspector-panel" : ".preview-panel",
              label:
                focus === 0
                  ? "功能面板 · 点击标签切换"
                  : "仿真监视器 · 多视角观察",
            },
          ];
  return (
    <section
      className={`review-presentation review-page-${step + 1} ${live ? "is-live" : ""}`}
      aria-label="挑战杯评审导览"
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "ArrowRight") {
          e.preventDefault();
          onStep(Math.min(8, step + 1));
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onStep(Math.max(0, step - 1));
        }
      }}
      tabIndex={0}
    >
      <div className="review-topline">
        <span>
          CHALLENGE CUP <i /> 评审导览
        </span>
        <button onClick={onFinish}>
          进入工作台 <ArrowUpRight size={14} />
        </button>
      </div>
      <div
        className={`review-content ${live ? "review-live-intro" : ""}`}
        key={step}
      >
        {step === 0 && (
          <div className="review-welcome">
            <div className="review-welcome-copy">
              <span className="review-kicker">面向工业现场的交互式智能体</span>
              <h1>
                刘工智能
                <span>
                  听懂所需，
                  <br />
                  协同执行。
                </span>
              </h1>
              <p>本项目由秒随项目组开发</p>
              <button className="review-primary" onClick={() => onStep(1)}>
                开始了解 <ArrowRight size={17} />
              </button>
              <div className="review-signature">
                MIAOSUI PROJECT TEAM <span>感知 / 决策 / 执行</span>
              </div>
            </div>
            <div className="review-brand-stage">
              <div className="review-orbit orbit-one" />
              <div className="review-orbit orbit-two" />
              <span className="review-orbit-label">LIUGONG INTELLIGENCE</span>
              <Logo className="review-hero-logo" alt="刘工智能 Logo" />
              <span className="review-brand-caption">您的工业智能伙伴</span>
            </div>
          </div>
        )}
        {step === 1 && (
          <>
            <div className="review-heading">
              <span className="review-kicker">01 / 访问准备</span>
              <h1>
                从正确的入口，
                <br className="review-mobile-break" />
                开始语音交互。
              </h1>
              <p>
                为了确保最佳效果，请返回 GPUFree 控制台，选择“自定义服务”，复制{" "}
                <strong>8991</strong>{" "}
                对应的端口链接，并在浏览器中打开。否则我们将无法为您提供语音交互能力。
              </p>
            </div>
            <div className="review-access-steps">
              <span>
                <b>1</b> GPUFree 控制台
              </span>
              <ArrowRight />
              <span>
                <b>2</b> 自定义服务
              </span>
              <ArrowRight />
              <span>
                <b>3</b> 复制 8991 链接
              </span>
              <ArrowRight />
              <span>
                <b>4</b> 浏览器打开
              </span>
            </div>
            <Figure
              src="/review/gpufree-service.png"
              alt="GPUFree 控制台中自定义服务的 8991 端口入口"
              caption="打开链接后，请允许浏览器使用麦克风。"
            />
          </>
        )}
        {step === 2 && (
          <>
            <div className="review-heading">
              <span className="review-kicker">02 / 并行响应</span>
              <h1>
                一边与您聊天，
                <br />
                一边把工作做好。
              </h1>
              <p>
                刘工智能基于 BusAgent
                的并行流式架构，让对话、感知与规划协同推进；工作进行中，依旧能对您的要求作出超高速响应。
              </p>
            </div>
            <ParallelTimeline />
          </>
        )}
        {step === 3 && (
          <>
            <div className="review-heading">
              <span className="review-kicker">03 / 看见协同</span>
              <h1>每一步执行，都有迹可循。</h1>
              <p>
                基于并行能力，提升机械臂场景的任务处理速度与信息同步效率。您可以在下方时间轴查看执行进度与调度策略。
              </p>
            </div>
            <div className="review-tour-copy">
              <div className="review-loop-legend">
                <span>
                  <i className="dot fast" /> 快环 · 机械臂端
                </span>
                <span>
                  <i className="dot slow" /> 慢环 · 服务端
                </span>
              </div>
              <p>
                快慢环对应不同的推理端与调度策略，分别以绿色和蓝色呈现。节点块末尾的颜色，与它唤起的节点起点颜色对应。点击节点可查看详情。
              </p>
              <small>下方为实时工作台；暂无任务时，时间轴保持空白。</small>
            </div>
          </>
        )}
        {step === 4 && (
          <>
            <div className="review-heading">
              <span className="review-kicker">04 / 视觉感知</span>
              <h1>看得清，更要反应快。</h1>
            </div>
            <div className="review-vision-layout">
              <div className="review-vision-copy">
                <div>
                  <span className="review-loop-label fast">
                    <ScanLine size={16} /> 快环感知
                  </span>
                  <h2>YOLOE × SAM2-Tiny</h2>
                  <p>
                    由秒随团队针对工业场景特别微调，提供快速的开放词汇检测与长期记忆能力，在
                    RK3588 设备上实现毫秒级响应。
                  </p>
                </div>
                <div>
                  <span className="review-loop-label slow">
                    <Eye size={16} /> 增强感知
                  </span>
                  <h2>SAM3 × Florence</h2>
                  <p>
                    提供增强的图像处理能力。基于 BusAgent 异步架构，一台 Mac
                    mini 可以同时以平均 500 ms 的响应速度服务数十台机械臂。
                  </p>
                </div>
              </div>
              <div>
                <Figure
                  src="/review/sam2-industrial.png"
                  alt="团队微调 SAM2-Tiny 对密集金属零件的分割结果"
                  caption="基于团队微调的 SAM2-Tiny 完成图像分割，仅用 40 ms 响应。"
                />
                <div className="review-metric">
                  <strong>
                    40<span>ms</span>
                  </strong>
                  <span>
                    密集工业零件
                    <br />
                    图像分割响应
                  </span>
                </div>
              </div>
            </div>
            <p className="review-footnote">
              性能数据由秒随团队提供；不同模型、硬件与负载下的实际表现，以对应测试条件为准。
            </p>
          </>
        )}
        {step === 5 && (
          <>
            <div className="review-heading">
              <span className="review-kicker">05 / 记忆与学习</span>
              <h1>
                每一次协作，
                <br />
                都成为下一次的经验。
              </h1>
              <p>
                刘工智能具备图像记忆、文字记忆与动作记忆能力，并能够在不同机械臂间有选择地高效传递。
              </p>
            </div>
            <div className="review-memory">
              {[
                {
                  icon: Eye,
                  name: "图像记忆",
                  detail: "记住所见",
                  sub: "物体特征 · 场景经验",
                },
                {
                  icon: Brain,
                  name: "文字记忆",
                  detail: "理解所需",
                  sub: "任务上下文 · 用户偏好",
                },
                {
                  icon: Hand,
                  name: "动作记忆",
                  detail: "复用所学",
                  sub: "执行策略 · 动作经验",
                },
              ].map(({ icon: Icon, name, detail, sub }, i) => (
                <div key={name}>
                  <span className="review-memory-index">0{i + 1}</span>
                  <Icon size={30} strokeWidth={1.3} />
                  <h2>{name}</h2>
                  <p>{detail}</p>
                  <small>{sub}</small>
                </div>
              ))}
            </div>
            <div className="review-learning-line">
              <span>新经验</span>
              <ArrowRight />
              <span>选择性共享</span>
              <ArrowRight />
              <span>快环复用</span>
              <ArrowRight />
              <strong>持续进步</strong>
            </div>
            <p className="review-closing-copy">
              依托学习能力与快慢环机制，同样的任务，在自然交互中不断提升速度与准确度。
            </p>
          </>
        )}
        {step === 6 && (
          <>
            <div className="review-heading">
              <span className="review-kicker">06 / 机械动作</span>
              <h1>
                简单任务迅速完成，
                <br />
                复杂动作从容应对。
              </h1>
              <p>
                机械动作同样支持快慢环选择，让不同难度的任务获得适合的执行方案。
              </p>
            </div>
            <div className="review-motion-flow">
              <div className="review-motion-entry">
                <Workflow size={26} />
                <h2>任务决策</h2>
                <span>理解目标 · 选择策略</span>
              </div>
              <div className="review-motion-branches">
                <div className="review-motion-route fast">
                  <span className="review-loop-label fast">快环</span>
                  <h2>轻量动作算法</h2>
                  <p>常规抓取与放置，快速执行。</p>
                </div>
                <div className="review-motion-route slow">
                  <span className="review-loop-label slow">慢环</span>
                  <h2>
                    GraspGenX <span>×</span> AnyPlace
                  </h2>
                  <p>怎么抓 + 怎么放，协同生成抓放方案。</p>
                </div>
              </div>
              <div className="review-motion-entry">
                <Hand size={26} />
                <h2>机械臂执行</h2>
                <span>抓取 · 搬运 · 放置</span>
              </div>
            </div>
            <p className="review-closing-copy">
              面向多机械臂协同服务，GraspGenX 与 AnyPlace
              的抓放方案兼顾速度与精度，追求超越主流 VLA 模型的表现。
            </p>
            <p className="review-footnote">
              此处介绍团队技术方案；与 VLA
              的性能比较需在相同任务、硬件与评测条件下验证。
            </p>
          </>
        )}
        {step === 7 && (
          <>
            <div className="review-heading">
              <span className="review-kicker">07 / 亲自试一试</span>
              <h1>选择场景，叫一声刘工。</h1>
              <p>
                在场景页选择需要的工作台，点击“进入仿真”完成切换。右下角的刘工头像是对话入口：点击开始，再次点击关闭收听模式。
              </p>
            </div>
            <div className="review-tour-copy">
              <div className="review-focus-tabs">
                <button aria-pressed={focus === 0} onClick={() => setFocus(0)}>
                  <Layers3 size={14} /> 场景切换
                </button>
                <button aria-pressed={focus === 1} onClick={() => setFocus(1)}>
                  <AudioLines size={14} /> 语音入口
                </button>
              </div>
              <p>
                您可以直接操作下方真实界面。切换场景会更新仿真工作台；浏览导览本身不会移动机械臂或开启麦克风。
              </p>
            </div>
          </>
        )}
        {step === 8 && (
          <>
            <div className="review-heading">
              <span className="review-kicker">08 / 仿真工作台</span>
              <h1>观察、操作、验证。</h1>
              <p>
                功能面板用于查看节点详情、物体属性、机械臂状态与对话记录；仿真监视器用于多视角观察执行过程。
              </p>
            </div>
            <div className="review-tour-copy">
              <div className="review-focus-tabs">
                <button aria-pressed={focus === 0} onClick={() => setFocus(0)}>
                  功能面板
                </button>
                <button aria-pressed={focus === 1} onClick={() => setFocus(1)}>
                  仿真监视器
                </button>
              </div>
              <p>
                {focus === 0
                  ? "点击左侧标签切换功能，选中时间轴节点查看调用详情；拖动面板分隔线可调整布局。"
                  : "切换摄像机视角、放大画面观察细节。监视器还提供中断、回到待机位和重置入口，请在需要时使用。"}
              </p>
            </div>
          </>
        )}
      </div>
      {live && <div className="review-live-surface">{children}</div>}
      {live && <Highlights targets={targets} />}
      <footer className="review-navigation">
        <div className="review-page-count" aria-live="polite">
          <strong>{String(step + 1).padStart(2, "0")}</strong>
          <span>/ 09</span>
          <span>{chapters[step]}</span>
        </div>
        <nav aria-label="评审章节">
          {chapters.map((title, i) => (
            <button
              key={title}
              aria-label={`第 ${i + 1} 页：${title}`}
              title={title}
              aria-current={step === i ? "step" : undefined}
              onClick={() => onStep(i)}
            >
              <span />
            </button>
          ))}
        </nav>
        <div className="review-page-actions">
          <button
            disabled={step === 0}
            onClick={() => onStep(step - 1)}
            aria-label="上一页"
          >
            <ArrowLeft size={16} />
          </button>
          {step === 8 ? (
            <>
              <button onClick={() => onStep(0)} aria-label="重新浏览">
                <RotateCcw size={15} />
              </button>
              <button className="review-primary" onClick={onFinish}>
                开始体验 <Check size={15} />
              </button>
            </>
          ) : (
            <button className="review-primary" onClick={() => onStep(step + 1)}>
              下一页 <ArrowRight size={16} />
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
