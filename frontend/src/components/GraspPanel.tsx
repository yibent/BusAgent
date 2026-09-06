import type { RobotRuntimeStatus } from "../hooks/useRobotStatus";
const stateNames: Record<string, string> = {accepted: "已接收", running: "执行中", completed: "已完成", failed: "未完成", cancelled: "已中断"};

export function GraspPanel({status, connected}: {status: RobotRuntimeStatus | null; connected: boolean}) {
  status = status ?? {};
  const result = ["grasp", "pick_place", "place_held"].includes(status.last_result?.skill ?? "") ? status.last_result : undefined;
  const active = Boolean(status.command_id);
  const phases: Record<string, string> = {
    idle: "待命", planning: "观察目标", grasp_candidates: "生成抓取候选", selected_grasp: "选择抓取姿态",
    pregrasp: "接近目标", approach: "下降抓取", close_gripper: "夹紧物体", lift: "抬升物体",
    lift_verified: "抬升已验证", placement_inference: "生成放置候选", placement_candidates: "筛选放置姿态",
    selected_placement: "准备放置", transport: "搬运物体", place_approach: "下降放置", release: "释放物体", retreat: "退离目标",
    observation: "获取目标点云", settle_grasp: "稳定夹持", finish: "验证放置结果",
    attempt_started: "开始执行", attempt_finished: "检查执行结果", model_fallback: "升级模型处理",
    fallback_keep_grasp: "保留抓取，升级放置", fallback_reobserve: "重新观察目标", fallback_retreat: "退离后重新抓取",
    holding_resumed: "继续放置手中物体", held_geometry_reused: "沿用持物几何", free_space_selected: "已选定空闲放置位置"
  };
  const evaluation = result?.evaluation;
  const routeName = result?.fallback_used ? "快速尝试 → 模型增强" : result?.route?.placement === "official_pick_place" || result?.route?.grasp === "official_pick_place" ? "官方快速抓放" : "模型增强";
  return <section className="console-card grasp-panel" aria-labelledby="grasp-heading">
    <div className="card-heading"><div><span className="section-kicker">PANDA · PICK & PLACE</span><h2 id="grasp-heading">抓放任务</h2></div>
      <span className={`task-state ${result?.ok && !active ? "done" : ""}`}>{!connected ? "离线" : active ? "执行中" : result ? stateNames[result.state] ?? result.state : "待命"}</span>
    </div>
    <p className="grasp-intro">简单任务优先快速抓放；复杂任务或快速执行失败时，自动调用模型增强。</p>
    <div className="grasp-live" aria-live="polite"><strong>{phases[status.phase ?? "idle"] ?? status.phase}</strong>
      <p>{active ? "正在根据相机观察执行任务。" : result?.message ?? "可发送：把红色方块放到蓝色区域。"}</p>
      <p>当前持物：{status.holding?.verified ? status.holding.label ?? status.held_object : status.held_object ? "夹持待确认" : "无"}</p>
      {!active && result?.route && <p>{routeName}{result.elapsed_s != null ? ` · ${result.elapsed_s.toFixed(1)} 秒` : ""}</p>}
      {evaluation && <dl className="grasp-results">
        <div><dt>实际抬升</dt><dd>{(evaluation.max_lift_m * 100).toFixed(1)} cm</dd></div>
        <div><dt>距区域中心</dt><dd>{evaluation.destination_xy_error_m == null ? "—" : (evaluation.destination_xy_error_m * 1000).toFixed(1) + " mm"}</dd></div>
        <div><dt>物理验证</dt><dd>{evaluation.physical_success ? "通过" : "未通过"}</dd></div>
      </dl>}
    </div>
    <p className="grasp-hint">拿起后可单独说“放到蓝色托盘”或“在桌子上找个空位放下”。普通放置优先快环，随时可以停止。</p>
  </section>;
}
