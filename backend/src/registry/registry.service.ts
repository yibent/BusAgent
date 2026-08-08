import { Injectable } from '@nestjs/common';
import { BusAgentError } from '../common/errors.js';
import type { LoadedPackage, PackageAgent } from '../package/package-loader.js';
import type { InstalledAgent } from './installed-agent.js';

/**
 * Global agent registry (spec §5, §8). `agent_id` is unique across the whole
 * BusAgent instance; installing a package that conflicts fails the entire
 * package (spec §14).
 */
@Injectable()
export class RegistryService {
  private readonly agents = new Map<string, InstalledAgent>();

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  get(agentId: string): InstalledAgent | undefined {
    return this.agents.get(agentId);
  }

  all(): InstalledAgent[] {
    return [...this.agents.values()];
  }

  get size(): number {
    return this.agents.size;
  }

  installPackage(pkg: LoadedPackage): void {
    for (const declaration of pkg.agents) {
      if (this.agents.has(declaration.agent_id)) {
        const existing = this.agents.get(declaration.agent_id);
        throw new BusAgentError(
          'AGENT_ID_CONFLICT',
          `Global agent_id conflict: ${declaration.agent_id}`,
          {
            incomingPackage: pkg.packageId,
            existingPackage: existing?.packageId,
          },
        );
      }
      this.agents.set(declaration.agent_id, toInstalledAgent(declaration, pkg));
    }
  }
}

function toInstalledAgent(
  declaration: PackageAgent,
  pkg: LoadedPackage,
): InstalledAgent {
  return {
    agentId: declaration.agent_id,
    packageId: pkg.packageId,
    packageVersion: pkg.packageVersion,
    endpoint: declaration.endpoint,
    consumes: declaration.consumes,
    produces: declaration.produces,
    configurationSchema: declaration.configurationSchema,
    ...(declaration.configurationSchemaPath !== undefined
      ? { configurationSchemaPath: declaration.configurationSchemaPath }
      : {}),
    concurrency: declaration.concurrency,
    retry: declaration.retry,
    permissions: declaration.permissions,
  };
}
