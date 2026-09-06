import { useEffect, useRef, useState } from "react";
import { editWorkspace, request } from "@/lib/workspace-api";
export type ManualTarget = {
  target: "robot" | "object";
  id?: string;
  frame?: "world" | "tool";
};
type Velocity = { linear: number[]; angular: number[] };
type Gesture = { id: string; velocity: Velocity; released: boolean };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function useManualMotion(
  target: ManualTarget,
  onRefresh: () => Promise<void>,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const gesture = useRef<Gesture | null>(null);
  const executing = useRef(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  function stop() {
    const current = gesture.current;
    if (!current) return;
    current.released = true;
    void request("/api/teleop", { command_id: current.id, stop: true }).catch(
      () => {},
    );
  }
  useEffect(() => {
    const cancel = () => stop();
    const hidden = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      stop();
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pagehide", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [target.target, target.id, target.frame]);
  async function jog(translation: number[], rotation: number[]) {
    if (executing.current) return;
    executing.current = true;
    setBusy(true);
    setError("");
    try {
      await editWorkspace("jog", { ...target, translation, rotation });
    } catch (e) {
      setError(e instanceof Error ? e.message : "移动失败");
    } finally {
      executing.current = false;
      setBusy(false);
      await refresh.current();
    }
  }
  function update(velocity: Velocity) {
    if (gesture.current && !gesture.current.released)
      gesture.current.velocity = velocity;
  }
  async function start(velocity: Velocity) {
    if (executing.current) return;
    executing.current = true;
    const current: Gesture = {
      id: crypto.randomUUID(),
      velocity,
      released: false,
    };
    gesture.current = current;
    setBusy(true);
    setError("");
    try {
      const accepted = await request<{
        ok: boolean;
        state: string;
        message: string;
      }>("/api/command", {
        command_id: current.id,
        skill: "workspace",
        params: { action: "teleop", ...target, ...velocity },
      });
      if (!["accepted", "running"].includes(accepted.state))
        throw new Error(accepted.message);
      while (!current.released) {
        await request(
          "/api/teleop",
          { command_id: current.id, ...current.velocity },
          AbortSignal.timeout(1000),
        );
        await pause(100);
      }
    } catch (e) {
      if (!current.released)
        setError(e instanceof Error ? e.message : "手动移动已停止");
    } finally {
      // Also stop after a late start response, if release happened during its request.
      current.released = true;
      await request(
        "/api/teleop",
        { command_id: current.id, stop: true },
        AbortSignal.timeout(1000),
      ).catch(() => {});
      const deadline = Date.now() + 4000;
      try {
        while (Date.now() < deadline) {
          const result = await request<{ state: string; message: string }>(
            `/api/commands/${current.id}`,
            undefined,
            AbortSignal.timeout(1000),
            { allowFailedResult: true },
          );
          if (!["accepted", "running"].includes(result.state)) {
            if (result.state === "failed") setError(result.message);
            break;
          }
          await pause(100);
        }
      } catch {
        /* The server lease expires even if the browser loses connectivity. */
      }
      if (gesture.current === current) gesture.current = null;
      executing.current = false;
      setBusy(false);
      await refresh.current();
    }
  }
  return { busy, error, jog, start, update, stop };
}
