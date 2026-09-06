import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Move3D,
  Rotate3D,
  Square,
} from "lucide-react";
import { useManualMotion, type ManualTarget } from "@/hooks/useManualMotion";
import { Button } from "@/components/ui/button";
export function MotionPad({
  target,
  disabled,
  onRefresh,
}: {
  target: ManualTarget;
  disabled: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"position" | "rotation">("position");
  const [plane, setPlane] = useState("XY");
  const [frame, setFrame] = useState<"world" | "tool">("world");
  const [step, setStep] = useState(5);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const motion = useManualMotion({ ...target, frame }, onRefresh);
  const press = useRef<{
    timer: ReturnType<typeof setTimeout>;
    held: boolean;
    axis: number;
    sign: number;
  } | null>(null);
  const dragging = useRef(false);
  const axes = plane.split("").map((axis) => "XYZ".indexOf(axis));
  const third = [0, 1, 2].find((axis) => !axes.includes(axis))!;
  const unit = mode === "position" ? "mm" : "°";
  function velocity(axis: number, amount: number) {
    const vector = [0, 0, 0];
    vector[axis] = (amount * step * 4) / (mode === "position" ? 1000 : 1);
    return mode === "position"
      ? { linear: vector, angular: [0, 0, 0] }
      : { linear: [0, 0, 0], angular: vector };
  }
  function cancel() {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
    dragging.current = false;
    setKnob({ x: 0, y: 0 });
    motion.stop();
  }
  useEffect(() => {
    const hide = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hide);
    return () => {
      cancel();
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  function begin(axis: number, sign: number) {
    if (disabled || motion.busy || press.current) return;
    const row = {
      timer: setTimeout(() => {
        row.held = true;
        void motion.start(velocity(axis, sign));
      }, 280),
      held: false,
      axis,
      sign,
    };
    press.current = row;
  }
  function release() {
    const row = press.current;
    if (!row) return;
    clearTimeout(row.timer);
    press.current = null;
    if (row.held) motion.stop();
    else {
      const vector = [0, 0, 0];
      vector[row.axis] = (row.sign * step) / (mode === "position" ? 1000 : 1);
      void motion.jog(
        mode === "position" ? vector : [0, 0, 0],
        mode === "rotation" ? vector : [0, 0, 0],
      );
    }
  }
  function direction(
    axis: number,
    sign: number,
    Icon: typeof ArrowUp,
    className: string,
  ) {
    const label = `${mode === "position" ? "移动" : "旋转"} ${"XYZ"[axis]}${sign > 0 ? "+" : "−"}`;
    return (
      <button
        className={`direction-key ${className}`}
        aria-label={label}
        title={label}
        disabled={disabled}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          begin(axis, sign);
        }}
        onPointerUp={release}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (press.current) cancel();
        }}
        onKeyDown={(e) => {
          if ([" ", "Enter"].includes(e.key) && !e.repeat) {
            e.preventDefault();
            begin(axis, sign);
          }
        }}
        onKeyUp={(e) => {
          if ([" ", "Enter"].includes(e.key)) {
            e.preventDefault();
            release();
          }
        }}
        onBlur={cancel}
      >
        <Icon size={16} />
        <span>
          {"XYZ"[axis]}
          {sign > 0 ? "+" : "−"}
        </span>
      </button>
    );
  }
  function stick(e: PointerEvent<HTMLDivElement>, start = false) {
    const bounds = e.currentTarget.getBoundingClientRect(),
      radius = bounds.width * 0.34;
    let x = (e.clientX - bounds.x - bounds.width / 2) / radius,
      y = (e.clientY - bounds.y - bounds.height / 2) / radius;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    if (length < 0.12) {
      x = 0;
      y = 0;
    }
    setKnob({ x: x * radius, y: y * radius });
    const vector = [0, 0, 0];
    vector[axes[0]] = (x * step * 4) / (mode === "position" ? 1000 : 1);
    vector[axes[1]] = (-y * step * 4) / (mode === "position" ? 1000 : 1);
    const value =
      mode === "position"
        ? { linear: vector, angular: [0, 0, 0] }
        : { linear: [0, 0, 0], angular: vector };
    if (start) void motion.start(value);
    else motion.update(value);
  }
  return (
    <div
      className="motion-pad"
      aria-label={target.target === "robot" ? "机械臂操作区" : "物体操作区"}
    >
      <div className="inspector-subhead">
        <Move3D size={13} />
        {target.target === "robot" ? "末端手动移动" : "物体微调"}
        <span>{motion.busy ? "正在移动" : "实时控制"}</span>
      </div>
      <div className="motion-settings">
        <div className="motion-mode" role="group" aria-label="移动方式">
          <button
            aria-pressed={mode === "position"}
            disabled={motion.busy}
            onClick={() => {
              setMode("position");
              setStep(5);
            }}
          >
            <Move3D size={13} />
            位置
          </button>
          <button
            aria-pressed={mode === "rotation"}
            disabled={motion.busy}
            onClick={() => {
              setMode("rotation");
              setStep(5);
            }}
          >
            <Rotate3D size={13} />
            旋转
          </button>
        </div>
        <label>
          平面
          <select
            aria-label="操作平面"
            value={plane}
            disabled={motion.busy}
            onChange={(e) => setPlane(e.target.value)}
          >
            {["XY", "XZ", "YZ"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          步长
          <select
            aria-label="移动步长"
            value={step}
            disabled={motion.busy}
            onChange={(e) => setStep(Number(e.target.value))}
          >
            {[1, 5, 10, 25].map((n) => (
              <option value={n} key={n}>
                {n} {unit}
              </option>
            ))}
          </select>
        </label>
        {target.target === "robot" && (
          <label>
            坐标
            <select
              aria-label="控制坐标系"
              value={frame}
              disabled={motion.busy}
              onChange={(e) => setFrame(e.target.value as typeof frame)}
            >
              <option value="world">世界</option>
              <option value="tool">工具</option>
            </select>
          </label>
        )}
      </div>
      <div className="motion-surfaces">
        <div className="direction-pad" role="group" aria-label="十字键">
          {direction(axes[1], 1, ArrowUp, "north")}
          {direction(axes[0], -1, ArrowLeft, "west")}
          <Button
            size="icon"
            variant="ghost"
            className="pad-stop"
            aria-label="停止手动移动"
            onClick={cancel}
          >
            <Square size={13} />
          </Button>
          {direction(axes[0], 1, ArrowRight, "east")}
          {direction(axes[1], -1, ArrowDown, "south")}
        </div>
        <div
          className="joystick"
          role="group"
          aria-label="平面摇杆"
          aria-disabled={disabled}
          data-active={motion.busy}
          onPointerDown={(e) => {
            if (disabled || motion.busy || e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            dragging.current = true;
            stick(e, true);
          }}
          onPointerMove={(e) => {
            if (dragging.current) stick(e);
          }}
          onPointerUp={cancel}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
        >
          <span className="joystick-cross" />
          <span className="joystick-axis">{plane}</span>
          <span
            className="joystick-knob"
            style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
          />
        </div>
        <div className="depth-keys">
          {direction(third, 1, ArrowUp, "")}
          {direction(third, -1, ArrowDown, "")}
        </div>
      </div>
      <p className="field-help motion-help">
        单击按步长移动；按住或拖动连续移动，松开停止。
        {motion.busy && "正在读取实际位置…"}
      </p>
      {motion.error && (
        <p className="motion-error" role="alert">
          {motion.error}
        </p>
      )}
    </div>
  );
}
