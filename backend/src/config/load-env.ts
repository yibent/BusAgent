import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { configureLogging } from '../common/logger.js';

let loaded = false;

function candidatePaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), 'backend/.env'),
    resolve(here, '../../.env'),
    resolve(here, '../../../.env'),
  ];
}

/** Loads the first existing `.env` into process.env. Does not override real env vars. */
export function loadEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  for (const file of candidatePaths()) {
    if (existsSync(file)) {
      loadDotenv({ path: file, quiet: true });
      configureLogging();
      return;
    }
  }
  loadDotenv({ quiet: true });
  configureLogging();
}
