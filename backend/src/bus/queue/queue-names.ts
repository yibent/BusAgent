/** Logical queue name (spec §10): one in-process queue per app_id + agent_id. */
export function queueName(appId: string, agentId: string): string {
  return `busagent:${appId}:${agentId}`;
}
