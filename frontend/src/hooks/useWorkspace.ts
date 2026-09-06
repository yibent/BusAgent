import { useCallback, useEffect, useState } from "react";
import { getWorkspace, type WorkspaceState } from "@/lib/workspace-api";
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setWorkspace(await getWorkspace());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "场景服务暂未连接");
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { workspace, error, refresh };
}
