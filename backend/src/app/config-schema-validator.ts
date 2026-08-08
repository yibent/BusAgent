import { Injectable } from '@nestjs/common';
import { Ajv, type ValidateFunction } from 'ajv';
import { BusAgentError } from '../common/errors.js';
import { sha256Hex } from '../common/sha.js';
import { stableStringify } from '../common/json.js';

/**
 * Validates App-provided agent config against the agent's `configuration_schema`
 * (spec §6). Schema files are compiled once and cached.
 */
@Injectable()
export class ConfigSchemaValidator {
  private readonly cache = new Map<string, ValidateFunction>();

  validate(
    schema: Readonly<Record<string, unknown>>,
    config: unknown,
    context: string,
  ): void {
    const cacheKey = sha256Hex(stableStringify(schema));
    let validate = this.cache.get(cacheKey);
    if (validate === undefined) {
      const ajv = new Ajv({ strict: false, allErrors: true });
      try {
        validate = ajv.compile(schema);
      } catch (error) {
        throw new BusAgentError(
          'SCHEMA_INVALID',
          `Invalid configuration schema for ${context}`,
          {
            error: (error as Error).message,
          },
        );
      }
      this.cache.set(cacheKey, validate);
    }
    if (!validate(config)) {
      throw new BusAgentError(
        'CONFIG_INVALID',
        `Agent config does not conform to its configuration schema (${context})`,
        {
          errors: validate.errors,
        },
      );
    }
  }
}
