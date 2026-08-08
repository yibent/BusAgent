import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { BusAgentError } from '../common/errors.js';
import { isPathInside } from '../common/path-safety.js';
import { sha256Hex } from '../common/sha.js';
import { type AppFile, AppFileSchema } from './app-config.js';

export interface ResolvedAgentFiles {
  /** Path as written in the App config, relative to the App file. */
  relativePath: string;
  absolutePath: string;
  promptSha256: string;
  contentLength: number;
}

/** An App file loaded with its directory-relative prompt/config files resolved. */
export interface ResolvedApp {
  filePath: string;
  appDir: string;
  config: AppFile;
  appId: string;
  appVersion: string;
  /** agent_id -> resolved prompt file (only for agents that declare prompt_file). */
  resolvedFiles: Map<string, ResolvedAgentFiles>;
  /** sha256 of the raw App JSON file. */
  sha256: string;
}

function parseJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new BusAgentError('CONFIG_INVALID', `File is not valid JSON: ${filePath}`);
  }
}

/**
 * Loads an App file, resolves every `prompt_file` reference relative to the
 * App directory and rejects any path escaping it with `..` (spec §6).
 */
export async function loadApp(appFile: string): Promise<ResolvedApp> {
  const appDir = dirname(resolve(appFile));
  let raw: string;
  try {
    raw = await readFile(appFile, 'utf8');
  } catch {
    throw new BusAgentError('CONFIG_INVALID', `App file not readable: ${appFile}`);
  }
  const parsed = parseJson(raw, appFile);
  const result = AppFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new BusAgentError('CONFIG_INVALID', `Invalid app file: ${appFile}`, {
      issues: result.error.issues,
    });
  }
  const config = result.data;
  const resolvedFiles = new Map<string, ResolvedAgentFiles>();
  for (const entry of config.agents) {
    const promptFile =
      typeof entry.config['prompt_file'] === 'string'
        ? entry.config['prompt_file']
        : undefined;
    if (promptFile === undefined) {
      continue;
    }
    const absolutePath = resolve(appDir, promptFile);
    if (!isPathInside(appDir, absolutePath)) {
      throw new BusAgentError(
        'PATH_ESCAPE',
        `prompt_file escapes the app directory: ${promptFile}`,
        { appFile, agentId: entry.agent_id },
      );
    }
    let content: string;
    try {
      content = await readFile(absolutePath, 'utf8');
    } catch {
      throw new BusAgentError(
        'CONFIG_INVALID',
        `prompt_file not found: ${promptFile}`,
        {
          appFile,
          agentId: entry.agent_id,
        },
      );
    }
    resolvedFiles.set(entry.agent_id, {
      relativePath: promptFile,
      absolutePath,
      promptSha256: sha256Hex(content),
      contentLength: content.length,
    });
  }
  return {
    filePath: appFile,
    appDir,
    config,
    appId: config.app.id,
    appVersion: config.app.version,
    resolvedFiles,
    sha256: sha256Hex(raw),
  };
}
