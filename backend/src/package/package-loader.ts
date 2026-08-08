import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BusAgentError } from '../common/errors.js';
import { isPathInside } from '../common/path-safety.js';
import { loadJsonSchema } from './json-schema-loader.js';
import {
  type AgentDeclaration,
  type PackageFile,
  PackageFileSchema,
} from './package-config.js';

/** A package agent declaration plus its resolved configuration schema. */
export type PackageAgent = AgentDeclaration & {
  configurationSchema: Readonly<Record<string, unknown>> | null;
  configurationSchemaPath?: string;
};

/** A successfully loaded `*.package.json` file. */
export interface LoadedPackage {
  filePath: string;
  packageId: string;
  packageVersion: string;
  agents: PackageAgent[];
}

function parseJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new BusAgentError('CONFIG_INVALID', `File is not valid JSON: ${filePath}`);
  }
}

function parsePackageFile(value: unknown, filePath: string): PackageFile {
  const result = PackageFileSchema.safeParse(value);
  if (!result.success) {
    throw new BusAgentError('CONFIG_INVALID', `Invalid package file: ${filePath}`, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

/** Loads every `*.package.json` in `packageDir` and resolves config schema files. */
export async function loadPackages(packageDir: string): Promise<LoadedPackage[]> {
  let entries;
  try {
    entries = await readdir(packageDir, { withFileTypes: true });
  } catch {
    throw new BusAgentError(
      'CONFIG_INVALID',
      `Package directory not readable: ${packageDir}`,
    );
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.package.json'));
  if (files.length === 0) {
    throw new BusAgentError(
      'CONFIG_INVALID',
      `No *.package.json files found in ${packageDir}`,
    );
  }
  const result: LoadedPackage[] = [];
  for (const entry of files) {
    const filePath = join(packageDir, entry.name);
    const raw = await readFile(filePath, 'utf8');
    const pkg = parsePackageFile(parseJson(raw, filePath), filePath);
    const agents: PackageAgent[] = [];
    for (const declaration of pkg.agents) {
      let configurationSchema: Readonly<Record<string, unknown>> | null = null;
      let configurationSchemaPath: string | undefined;
      if (declaration.configuration_schema !== undefined) {
        const schemaPath = resolve(join(packageDir, declaration.configuration_schema));
        if (!isPathInside(packageDir, schemaPath)) {
          throw new BusAgentError(
            'PATH_ESCAPE',
            `configuration_schema escapes the package directory: ${declaration.configuration_schema}`,
            { packageFile: filePath, agentId: declaration.agent_id },
          );
        }
        configurationSchema = await loadJsonSchema(schemaPath);
        configurationSchemaPath = declaration.configuration_schema;
      }
      agents.push({
        ...declaration,
        configurationSchema,
        ...(configurationSchemaPath !== undefined ? { configurationSchemaPath } : {}),
      });
    }
    result.push({
      filePath,
      packageId: pkg.package.id,
      packageVersion: pkg.package.version,
      agents,
    });
  }
  return result;
}
