/** Fixed queue naming scheme (spec §10): one BullMQ queue per app_id + agent_id. */
export function queueName(appId: string, agentId: string): string {
  return `busagent:${appId}:${agentId}`;
}
