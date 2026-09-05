import { useEffect, useMemo, useState } from "react";

export interface DetectionStatus {
  label?: string;
  score?: number;
  track_id?: number | null;
}

export interface CameraViewStatus {
  stats?: {
    path?: string;
    frame_idx?: number;
    fast_ms?: number;
    slow_ms?: number;
  };
  detections?: DetectionStatus[];
}

export interface RobotRuntimeStatus {
  capabilities?: {
    skills?: string[];
    unsupported?: string[];
    message?: string;
  };
  motion?: {
    mode?: string;
    active_command_id?: string | null;
    joint_positions_deg?: Record<string, number>;
    tool_position_world_m?: number[];
    last_command?: {
      skill?: string;
      state?: string;
      message?: string;
      max_joint_error_deg?: number;
    };
  };
  prompt?: string;
  prompt_version?: number;
  find_epoch?: number;
  fast_backend?: string;
  slow_interval?: number;
  follow_enabled?: boolean;
  models?: Record<string, unknown>;
  views?: Record<string, CameraViewStatus>;
  error?: string | null;
}

function apiBaseUrl(): string {
  return (import.meta.env.VITE_BUSAGENT_HTTP_URL?.trim() ?? "").replace(
    /\/$/,
    "",
  );
}

export function useRobotStatus() {
  const [status, setStatus] = useState<RobotRuntimeStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const baseUrl = useMemo(apiBaseUrl, []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`${baseUrl}/v1/robot/status`, {
          cache: "no-store",
        });
        const raw = await response.text();
        let body: RobotRuntimeStatus & { error?: string } = {};
        if (raw) {
          try {
            body = JSON.parse(raw) as RobotRuntimeStatus & { error?: string };
          } catch {
            body = {};
          }
        }
        if (!response.ok) {
          throw new Error(
            body.error || `BusAgent 状态接口不可用（HTTP ${response.status}）`,
          );
        }
        if (!disposed) {
          setStatus(body);
          setConnected(true);
          setError(body.error ?? null);
          setLastUpdated(Date.now());
        }
      } catch (reason) {
        if (!disposed) {
          setConnected(false);
          setError(
            reason instanceof Error ? reason.message : "无法连接机器人控制器",
          );
        }
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [baseUrl]);

  return { status, connected, error, lastUpdated };
}
