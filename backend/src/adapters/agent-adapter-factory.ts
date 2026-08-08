import { Injectable } from '@nestjs/common';
import type { InstalledAgent } from '../registry/installed-agent.js';
import type { AgentAdapter } from './agent-adapter.js';
import { HttpAgentAdapter } from './http/http-agent-adapter.js';
import { InProcessAgentAdapter } from './in-process/in-process-agent-adapter.js';

/**
 * Builds (and caches) the adapter for each installed agent based on its
 * Package endpoint declaration (spec §9).
 */
@Injectable()
export class AgentAdapterFactory {
  private readonly cache = new Map<string, AgentAdapter>();

  constructor(private readonly inProcess: InProcessAgentAdapter) {}

  forAgent(agent: InstalledAgent): AgentAdapter {
    let adapter = this.cache.get(agent.agentId);
    if (!adapter) {
      adapter =
        agent.endpoint.adapter === 'http'
          ? new HttpAgentAdapter(agent.endpoint.event_url, agent.endpoint.health_url)
          : this.inProcess;
      this.cache.set(agent.agentId, adapter);
    }
    return adapter;
  }
}
