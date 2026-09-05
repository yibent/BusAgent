import type { RobotRuntimeStatus } from "../hooks/useRobotStatus";

const phaseNames: Record<string, string> = {
  grounding: "定位目标", approach: "接近观察位姿", observe: "腕部观察",
  generate: "生成抓取候选", pregrasp: "接近抓取位姿", servo: "视觉微调",
  close: "闭合夹爪", verify_close: "夹持验证", lift: "试抬升",
  verify_lift: "抬升验证", recovery: "恢复处理中",
};
const stateNames: Record<string, string> = {
  accepted: "已接收", started: "执行中", completed: "已完成",
  failed: "未完成", cancelled: "已中断",
};

/** Read-only monitor. Instructions and retry decisions stay in conversation. */
export function GraspPanel({ status, connected }: {
  status: RobotRuntimeStatus | null;
  connected: boolean;
}) {
  const job = status?.grasp;
  const metrics = job?.result?.metrics;
  const running = job?.state === "started" || job?.state === "accepted";
  const waiting = connected && job?.retry_available === true;
  const uncertain = metrics?.recovery_stop_reason === "payload_uncertain_do_not_open";
  return <section className="console-card grasp-panel" aria-labelledby="grasp-heading">
    <div className="card-heading">
      <div><span className="section-kicker">CLOSED-LOOP GRASP</span><h2 id="grasp-heading">抓取执行状态</h2></div>
      <span className={`task-state ${job?.state === "failed" && !waiting ? "failed" : job?.state === "completed" ? "done" : ""}`}>
        {!connected ? "状态离线" : waiting ? "等待对话指令" : stateNames[job?.state ?? ""] ?? "待命"}
      </span>
    </div>
    <p className="grasp-intro">{connected && status?.capabilities?.grasp?.dual_camera_default
      ? "双相机默认启用：顶部定位、腕部闭环、固定相机辅助验证。"
      : "等待控制器报告双相机抓取能力。"} 相机画面仍在 Isaac 查看。</p>
    <div className="grasp-live" aria-live="polite">
      <div className="grasp-live-heading"><strong>{running ? phaseNames[job?.phase ?? ""] ?? "处理中" : "最近抓取结果"}</strong>
        <span>尝试 {metrics?.recovery_attempts ?? job?.grasp?.attempt ?? 0} / {job?.grasp?.max_attempts ?? "—"}</span></div>
      <p>{job?.message ?? "尚未收到抓取执行反馈。通过对话下达抓取指令即可。"}</p>
      {!connected && job && <p className="controller-error">以下是上次采样，不能据此确认当前仍在执行。</p>}
      {waiting && <p className="grasp-hint">尚未重试。请在对话中决定下一步，例如“再试一次”或“停止”。</p>}
      {uncertain && <p className="grasp-warning">持物状态不确定：保持夹爪，不自动松爪或再次抓取。</p>}
      {metrics && <dl className="grasp-results">
        <div><dt>模型调用</dt><dd>{metrics.total_model_calls ?? metrics.model_calls ?? "—"}</dd></div>
        <div><dt>侧向观察移动</dt><dd>{metrics.total_active_view_moves ?? metrics.active_view_moves ?? "—"}</dd></div>
        <div><dt>固定相机验证</dt><dd>{({ confirmed: "确认", contradiction: "证据冲突", unknown: "未知", inconclusive: "不确定" } as Record<string, string>)[String(metrics.scene_verification)] ?? "未提供"}</dd></div>
      </dl>}
      {job && <details><summary>执行诊断与每次尝试</summary><pre>{JSON.stringify(job, null, 2)}</pre></details>}
    </div>
    <p className="grasp-hint">失败后的重新观察、重试通过对话控制，不自动执行。放置未实现。</p>
  </section>;
}
