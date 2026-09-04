import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Logger } from '../common/logger.js';
import { BusAgentError } from '../common/errors.js';
import { Clock } from '../common/clock.js';
import { delay } from '../common/delay.js';
import { HostConfig } from '../config/host-config.js';
import { loadPackages, type LoadedPackage } from '../package/package-loader.js';
import { loadApp } from '../app/app-loader.js';
import type { AppSnapshot } from './startup-snapshot.js';
import { AgentClasses } from '../adapters/in-process/agent-classes.js';
import { PackageInstaller } from '../package/package-installer.js';
import { AppValidator } from '../app/app-validator.js';
import { StartupSnapshotBuilder } from '../app/startup-snapshot-builder.js';
import { SnapshotsWriter } from '../app/snapshots-writer.js';
import { RuntimeState } from '../app/runtime-state.service.js';
import { RegistryService } from '../registry/registry.service.js';
import { LeaseManager } from '../leases/lease-manager.service.js';
import { MigrationRunner } from '../persistence/db/migrate.js';
import { DatabaseConnection } from '../persistence/db/client.js';
import { AgentsRepository } from '../persistence/repositories/agents.repository.js';
import { DeliveryService } from '../bus/delivery/delivery.service.js';

/**
 * Host startup lifecycle (spec §4, §12):
 * load packages -> install (global agent_id conflict detection) -> load/validate
 * app -> persist snapshots -> register in-process agents -> init delivery queues
 * -> recover from MySQL -> await required service registrations -> ready.
 *
 * Any validation failure aborts startup: the process must not run with a
 * partial configuration.
 */
@Injectable()
export class HostRuntimeService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(HostRuntimeService.name);
  private state: 'starting' | 'ready' | 'stopping' | 'failed' = 'starting';

  constructor(
    private readonly config: HostConfig,
    private readonly clock: Clock,
    private readonly installer: PackageInstaller,
    private readonly validator: AppValidator,
    private readonly snapshotBuilder: StartupSnapshotBuilder,
    private readonly snapshotsWriter: SnapshotsWriter,
    private readonly runtime: RuntimeState,
    private readonly registry: RegistryService,
    private readonly leases: LeaseManager,
    private readonly migrations: MigrationRunner,
    private readonly db: DatabaseConnection,
    private readonly agentsRepo: AgentsRepository,
    private readonly delivery: DeliveryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.start();
    } catch (error) {
      this.state = 'failed';
      this.logger.error(this.structuredDiagnostic(error));
      throw error;
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.state = 'stopping';
    this.logger.info(`Host shutting down (signal=${signal ?? 'unknown'})`);
    await this.delivery.shutdown();
    await this.db.close().catch(() => undefined);
  }

  get currentState(): string {
    return this.state;
  }

  private async start(): Promise<void> {
    this.logger.info('BusAgent host starting');

    await this.migrations.up();
    this.logger.info('database schema ready');

    const packages: LoadedPackage[] = await loadPackages(this.config.packageDir);
    this.logger.info(`loaded ${packages.length} package(s)`);
    this.installer.installAll(packages);

    const resolved = await loadApp(this.config.appFile);
    this.validator.validate(resolved);

    const snapshot = this.snapshotBuilder.build(resolved, this.clock.now());
    this.runtime.set(snapshot);

    await this.agentsRepo.replaceAll(this.registry.all());
    await this.snapshotsWriter.writePackages(packages);
    await this.snapshotsWriter.writeApp(snapshot, resolved);

    this.registerInProcessAgents();
    this.delivery.init(snapshot);
    await this.delivery.recoverFromMysql();

    // Readiness is awaited separately by the entrypoint (main.ts) after the
    // HTTP server is bound, so external agents can actually reach
    // /internal/registrations while the host waits for them (spec §4 step 6).
  }

  /**
   * Blocks until every required agent holds an active lease, then marks the
   * app `ready`. Called after the server is listening: required external
   * agents register through the live registration endpoint. Throws NOT_READY
   * when the registration window elapses (spec §4 step 8).
   */
  async awaitReady(): Promise<void> {
    const snapshot = this.runtime.current;
    const required = snapshot.agentIds.filter(
      (id) => snapshot.agents.get(id)?.required === true,
    );
    const isSettled = (): string[] =>
      required.filter((id) => !this.leases.isActive(id));

    const missing = isSettled();
    if (missing.length === 0) {
      this.markReady(snapshot);
      return;
    }

    const deadline = this.clock.nowMs() + this.config.registrationWaitTimeoutMs;
    while (this.clock.nowMs() < deadline) {
      await delay(500);
      if (isSettled().length === 0) {
        this.markReady(snapshot);
        return;
      }
    }

    this.state = 'failed';
    throw new BusAgentError(
      'NOT_READY',
      `Required agents did not register within ${this.config.registrationWaitTimeoutMs}ms: ${isSettled().join(', ')}`,
      { missingAgents: isSettled(), timeoutMs: this.config.registrationWaitTimeoutMs },
    );
  }

  private markReady(snapshot: AppSnapshot): void {
    this.state = 'ready';
    this.logger.info(
      `Host ready (app=${snapshot.appId}, agents=[${snapshot.agentIds.join(', ')}])`,
    );
  }

  private registerInProcessAgents(): void {
    for (const agent of this.registry.all()) {
      if (agent.endpoint.adapter === 'in-process') {
        const key = agent.endpoint.registration_key;
        if (!AgentClasses.has(key)) {
          throw new BusAgentError(
            'AGENT_NOT_INSTALLED',
            `In-process agent registration key not registered: ${key}`,
            { agentId: agent.agentId },
          );
        }
        this.leases.registerInProcess(agent.agentId);
        this.logger.info(`In-process agent ${agent.agentId} registered via key ${key}`);
      }
    }
  }

  private structuredDiagnostic(error: unknown): {
    message: string;
    code?: string;
    detail?: unknown;
    stack?: unknown;
  } {
    if (error instanceof BusAgentError) {
      return { message: error.message, code: error.code, detail: error.detail };
    }
    return { message: (error as Error).message, stack: (error as Error).stack };
  }
}
