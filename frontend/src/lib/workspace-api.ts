export interface ScenePreset {
  id: string;
  name: string;
  description: string;
  kind: string;
  count?: number;
  active?: boolean;
}
export interface SceneObject {
  id: string;
  name: string;
  shape?: string;
  position?: number[];
  rotation?: number[];
  size?: number[];
  color?: number[];
  editable?: boolean;
}
export interface WorkspaceState {
  available: boolean;
  scene_id: string;
  scenes: ScenePreset[];
  objects: SceneObject[];
  controller?: {
    position_tolerance_m: number;
    rotation_tolerance_deg: number;
    max_steps: number;
  };
  camera?: { width: number; height: number };
}
export const presets: ScenePreset[] = [
  {
    id: "initial",
    name: "基础抓放",
    description: "在开放工作台上练习拿取、转移与放置。",
    kind: "pick",
    count: 3,
  },
  {
    id: "sorting",
    name: "桌面整理",
    description: "分散摆放桌面物体，观察连续任务的执行。",
    kind: "sort",
    count: 3,
  },
  {
    id: "precision",
    name: "精确摆放",
    description: "紧凑的目标布局，用于定位与堆叠实验。",
    kind: "stack",
    count: 3,
  },
];
const base = (import.meta.env.VITE_ARENA_HTTP_URL ?? "").replace(/\/$/, "");
export const arenaUrl = (path: string) => `${base}${path}`;
export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(arenaUrl(path), {
    cache: "no-store",
    signal: signal ?? AbortSignal.timeout(12000),
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const raw = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`服务未提供此接口（${response.status}）`);
  }
  if (!response.ok || data.ok === false)
    throw new Error(
      String(data.message ?? data.error ?? `请求失败（${response.status}）`),
    );
  return data as T;
}
export async function getWorkspace(): Promise<WorkspaceState> {
  try {
    return {
      ...(await request<WorkspaceState>("/api/workspace")),
      available: true,
    };
  } catch {
    const capabilities = await request<{
      objects?: Record<string, unknown>[];
      destinations?: Record<string, unknown>[];
    }>("/api/capabilities");
    const rows = [
      ...(capabilities.objects ?? []),
      ...(capabilities.destinations ?? []),
    ];
    const unique = [
      ...new Map(rows.map((row) => [String(row.name), row])).values(),
    ];
    return {
      available: false,
      scene_id: "current",
      scenes: [
        {
          id: "current",
          name: "当前工作台",
          description: "连接服务器上正在运行的 Panda 场景。",
          kind: "live",
          active: true,
        },
        ...presets,
      ],
      objects: unique.map((row) => ({
        id: String(row.name),
        name: String(row.label ?? row.name),
        position: row.position as number[] | undefined,
        size: row.size as number[] | undefined,
        color: row.color as number[] | undefined,
        shape: row.shape as string | undefined,
        editable: false,
      })),
    };
  }
}
export async function runCommand(
  skill: string,
  params: Record<string, unknown> = {},
) {
  const command_id = crypto.randomUUID();
  let result = await request<{ ok: boolean; state: string; message: string }>(
    "/api/command",
    { command_id, skill, params },
  );
  const deadline = Date.now() + 30000;
  while (["accepted", "running"].includes(result.state)) {
    if (Date.now() > deadline)
      throw new Error("指令已提交，仍在执行；请查看机器人状态。");
    await new Promise((resolve) => setTimeout(resolve, 350));
    result = await request(`/api/commands/${command_id}`);
  }
  return result;
}
export async function editWorkspace(
  action: string,
  values: Record<string, unknown> = {},
) {
  return runCommand("workspace", { action, ...values });
}
