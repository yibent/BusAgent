import { Injectable } from '@nestjs/common';
import { Logger } from '../common/logger.js';
import { BusAgentError } from '../common/errors.js';
import { statusForCode } from '../common/http-status.js';
import { LEASE_TTL_SECONDS, RegistrationSchema } from '../protocol/registration.js';
import { LeaseManager } from '../leases/lease-manager.service.js';
import { AuditService } from '../observability/audit.service.js';
import { RegistryService } from './registry.service.js';

export interface HttpResult {
  status: number;
  body: unknown;
}

/**
 * `POST /internal/registrations` handler (spec §8). Registration is an
 * availability announcement only: it never creates agents and cannot widen
 * Package permissions. Content must match the Package's fixed URL.
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger('Registration');

  constructor(
    private readonly registry: RegistryService,
    private readonly leases: LeaseManager,
    private readonly audit: AuditService,
  ) {}

  async handle(body: unknown): Promise<HttpResult> {
    const parsed = RegistrationSchema.safeParse(body);
    if (!parsed.success) {
      return {
        status: 400,
        body: { error: 'ENVELOPE_INVALID', detail: parsed.error.issues },
      };
    }
    const { agent_id, endpoint_url, instance_version } = parsed.data;

    const installed = this.registry.get(agent_id);
    if (!installed) {
      return {
        status: 404,
        body: {
          error: 'AGENT_NOT_INSTALLED',
          message: `agent not installed: ${agent_id}`,
        },
      };
    }
    if (installed.endpoint.adapter !== 'http') {
      return {
        status: 400,
        body: {
          error: 'REGISTRATION_MISMATCH',
          message: `${agent_id} is not an HTTP agent; it is registered in-process by the host`,
        },
      };
    }
    if (installed.endpoint.event_url !== endpoint_url) {
      return {
        status: 400,
        body: {
          error: 'REGISTRATION_MISMATCH',
          message: `endpoint_url does not match the Package's fixed URL for ${agent_id}`,
        },
      };
    }

    try {
      const outcome = await this.leases.registerExternal(
        agent_id,
        endpoint_url,
        instance_version,
      );
      await this.audit.append(`registration.${outcome}`, 'agent', agent_id, {
        instanceVersion: instance_version,
      });
      const status = outcome === 'registered' ? 201 : 200;
      this.logger.info(`${outcome} ${agent_id} v=${instance_version}`);
      return {
        status,
        body: { agent_id, lease_ttl_seconds: LEASE_TTL_SECONDS, outcome },
      };
    } catch (error) {
      if (error instanceof BusAgentError) {
        this.logger.warn(`${error.code}: ${error.message}`);
        return {
          status: statusForCode(error.code),
          body: { error: error.code, message: error.message },
        };
      }
      throw error;
    }
  }
}
