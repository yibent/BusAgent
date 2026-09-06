import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspace, type WorkspaceState } from "@/lib/workspace-api";
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const next = await getWorkspace();
      if (current !== sequence.current) return;
      setWorkspace(next);
      setError(null);
    } catch (e) {
      if (current !== sequence.current) return;
      setError(e instanceof Error ? e.message : "场景服务暂未连接");
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { workspace, error, refresh };
}
