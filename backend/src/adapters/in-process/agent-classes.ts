import { BusAgentError } from '../../common/errors.js';
import type { BusEvent } from '../../protocol/envelope.js';
import type { AgentRuntimeConfig } from '../../protocol/agent-runtime-config.js';
import type { AgentPublishInput } from '../../protocol/ingress.js';
import type { HealthStatus } from '../../protocol/health.js';

/**
 * Publish input for in-process agents. The host injects `source_agent_id` from
 * the agent being handled, so agents never spoof a source identity.
 */
export type InProcessPublishInput = Omit<AgentPublishInput, 'source_agent_id'>;

/** Context handed to an in-process agent for a single delivered event. */
export interface InProcessEventContext {
  event: BusEvent;
  agentConfig: AgentRuntimeConfig;
  /** Publishes a follow-up event back through the host ingress. */
  publish(input: InProcessPublishInput): Promise<void>;
}

/**
 * An in-process agent: a plain TypeScript class mounted through the static
 * registration table (spec §9). Packages only reference an existing
 * `registration_key`; the host never loads arbitrary code from strings.
 */
export interface InProcessAgent {
  readonly registrationKey: string;
  handle(context: InProcessEventContext): Promise<void> | void;
  health?(): HealthStatus | Promise<HealthStatus>;
  close?(): Promise<void>;
}

/** Static in-process agent registry (spec §9). */
export class AgentClasses {
  private static readonly registry = new Map<string, InProcessAgent>();

  static register(key: string, agent: InProcessAgent): void {
    if (agent.registrationKey !== key) {
      throw new BusAgentError(
        'CONFIG_INVALID',
        `Registration key mismatch: provided "${key}", agent declares "${agent.registrationKey}"`,
      );
    }
    if (AgentClasses.registry.has(key)) {
      throw new BusAgentError(
        'AGENT_ID_CONFLICT',
        `In-process registration key already registered: ${key}`,
      );
    }
    AgentClasses.registry.set(key, agent);
  }

  static get(key: string): InProcessAgent | undefined {
    return AgentClasses.registry.get(key);
  }

  static has(key: string): boolean {
    return AgentClasses.registry.has(key);
  }
}
