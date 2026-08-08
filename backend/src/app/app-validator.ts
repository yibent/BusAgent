import { Injectable } from '@nestjs/common';
import { BusAgentError } from '../common/errors.js';
import type { ResolvedApp } from './app-loader.js';
import { ConfigSchemaValidator } from './config-schema-validator.js';
import { RegistryService } from '../registry/registry.service.js';

/**
 * App validation (spec §6): referenced agents installed, event contract match,
 * retry override within the Package cap, config conforming to the declared
 * configuration schema, route targets within the App's allowed set, and no
 * agent consuming/producing the same event type (forbidden self-loop).
 */
@Injectable()
export class AppValidator {
  constructor(
    private readonly registry: RegistryService,
    private readonly configSchemaValidator: ConfigSchemaValidator,
  ) {}

  validate(resolved: ResolvedApp): void {
    const app = resolved.config;
    const agentIds = new Set<string>();

    for (const entry of app.agents) {
      const installed = this.registry.get(entry.agent_id);
      if (!installed) {
        throw new BusAgentError(
          'AGENT_NOT_INSTALLED',
          `App references an agent not installed by any package: ${entry.agent_id}`,
          { appId: app.app.id },
        );
      }
      agentIds.add(entry.agent_id);

      const overlap = installed.consumes.filter((et) =>
        installed.produces.includes(et),
      );
      if (overlap.length > 0) {
        throw new BusAgentError(
          'CONFIG_INVALID',
          `Agent ${entry.agent_id} consumes and produces the same event type: ${overlap.join(', ')}`,
          { appId: app.app.id },
        );
      }

      if (
        entry.retry_override &&
        entry.retry_override.max_attempts > installed.retry.max_attempts
      ) {
        throw new BusAgentError(
          'CONFIG_INVALID',
          `App retry override (${entry.retry_override.max_attempts}) exceeds the Package cap (${installed.retry.max_attempts}) for ${entry.agent_id}`,
          { appId: app.app.id, agentId: entry.agent_id },
        );
      }

      if (installed.configurationSchema) {
        this.configSchemaValidator.validate(
          installed.configurationSchema,
          entry.config,
          `agent ${entry.agent_id}`,
        );
      }
    }

    for (const route of app.routes) {
      for (const target of route.to) {
        if (!agentIds.has(target)) {
          throw new BusAgentError(
            'CONFIG_INVALID',
            `Route for ${route.event} targets an agent that is not in the App: ${target}`,
            { appId: app.app.id },
          );
        }
        const installed = this.registry.get(target);
        if (installed && !installed.consumes.includes(route.event)) {
          throw new BusAgentError(
            'CONFIG_INVALID',
            `Route for ${route.event} targets ${target}, which does not consume it`,
            { appId: app.app.id },
          );
        }
      }
      if (route.from) {
        for (const source of route.from) {
          const installed = this.registry.get(source);
          if (!installed) {
            throw new BusAgentError(
              'AGENT_NOT_INSTALLED',
              `Route for ${route.event} lists ${source} as source, which is not installed`,
              { appId: app.app.id },
            );
          }
          if (!installed.produces.includes(route.event)) {
            throw new BusAgentError(
              'CONFIG_INVALID',
              `Route for ${route.event} lists ${source} as source, which does not produce it`,
              { appId: app.app.id },
            );
          }
        }
      }
    }
  }
}
