/**
 * Per-agent runtime configuration passed to `AgentAdapter.deliver(event, config)`.
 * Carries everything the adapter needs to reach the agent plus the App-provided
 * configuration values that were validated against the Package configuration schema.
 */
export interface AgentRuntimeConfig {
  appId: string;
  agentId: string;
  config: Record<string, unknown>;
  adapter: 'http' | 'in-process';
  eventUrl?: string;
  healthUrl?: string;
  registrationKey?: string;
}
