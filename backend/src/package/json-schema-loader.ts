import { readFile } from 'node:fs/promises';
import { BusAgentError } from '../common/errors.js';

/** Loads and validates a JSON Schema file referenced by a Package. */
export async function loadJsonSchema(
  filePath: string,
): Promise<Readonly<Record<string, unknown>>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw new BusAgentError(
      'SCHEMA_MISSING',
      `Configuration schema file not found: ${filePath}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BusAgentError(
      'SCHEMA_INVALID',
      `Configuration schema is not valid JSON: ${filePath}`,
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BusAgentError(
      'SCHEMA_INVALID',
      `Configuration schema must be a JSON object: ${filePath}`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}
