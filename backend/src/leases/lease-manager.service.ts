import { Injectable, OnModuleInit } from '@nestjs/common';
import { BusAgentError } from '../common/errors.js';
import { Clock } from '../common/clock.js';
import {
  LEASE_RENEW_INTERVAL_SECONDS,
  LEASE_TTL_SECONDS,
} from '../protocol/registration.js';
import { RegistrationsRepository } from '../persistence/repositories/registrations.repository.js';

export interface LeaseRecord {
  agentId: string;
  endpointUrl: string;
  instanceVersion: string;
  leaseExpiresAtMs: number;
  registeredAtMs: number;
  lastRenewedAtMs: number;
}

export const LEASE_TTL_MS = LEASE_TTL_SECONDS * 1000;
export const LEASE_RENEW_INTERVAL_MS = LEASE_RENEW_INTERVAL_SECONDS * 1000;

/**
 * Health lease management (spec §8): fixed 30s TTL, renewal every 10s, at most
 * one active instance per `agent_id`. In-process agents are always active.
 */
@Injectable()
export class LeaseManager implements OnModuleInit {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly inProcess = new Set<string>();

  constructor(
    private readonly clock: Clock,
    private readonly registrationsRepo: RegistrationsRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.registrationsRepo.findAll();
    for (const row of rows) {
      this.leases.set(row.agentId, row);
    }
  }

  registerInProcess(agentId: string): void {
    this.inProcess.add(agentId);
  }

  isInProcess(agentId: string): boolean {
    return this.inProcess.has(agentId);
  }

  isActive(agentId: string): boolean {
    if (this.inProcess.has(agentId)) {
      return true;
    }
    const lease = this.leases.get(agentId);
    if (!lease) {
      return false;
    }
    return lease.leaseExpiresAtMs > this.clock.nowMs();
  }

  /**
   * Registers or renews an external agent. Returns 'registered' for a brand-new
   * lease and 'renewed' when the request matches the active instance. A request
   * for an `agent_id` whose lease is still active but with a different URL or
   * instance version is a conflict.
   */
  async registerExternal(
    agentId: string,
    endpointUrl: string,
    instanceVersion: string,
  ): Promise<'registered' | 'renewed'> {
    const now = this.clock.nowMs();
    const existing = this.leases.get(agentId);
    if (existing && existing.leaseExpiresAtMs > now) {
      if (
        existing.endpointUrl !== endpointUrl ||
        existing.instanceVersion !== instanceVersion
      ) {
        throw new BusAgentError(
          'REGISTRATION_CONFLICT',
          `agent ${agentId} already has an active lease and cannot be re-registered with a different instance`,
          {
            existingEndpointUrl: existing.endpointUrl,
            incomingEndpointUrl: endpointUrl,
          },
        );
      }
      const renewed: LeaseRecord = {
        ...existing,
        leaseExpiresAtMs: now + LEASE_TTL_MS,
        lastRenewedAtMs: now,
      };
      this.leases.set(agentId, renewed);
      await this.registrationsRepo.upsert(renewed);
      return 'renewed';
    }
    const record: LeaseRecord = {
      agentId,
      endpointUrl,
      instanceVersion,
      leaseExpiresAtMs: now + LEASE_TTL_MS,
      registeredAtMs: now,
      lastRenewedAtMs: now,
    };
    this.leases.set(agentId, record);
    await this.registrationsRepo.upsert(record);
    return 'registered';
  }

  activeAgentIds(): string[] {
    return [...this.leases.keys()].filter((id) => this.isActive(id));
  }
}
