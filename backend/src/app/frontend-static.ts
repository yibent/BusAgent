import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { isPathInside } from '../common/path-safety.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const ALLOWED = new Set(['index.html', 'styles.css', 'app.js']);

export interface FrontendFile {
  type: string;
  body: Buffer;
}

/** Maps a request path to a file inside the frontend directory. */
export function frontendFileName(urlPath: string): string | null {
  const trimmed = urlPath.split('?')[0] ?? '';
  if (trimmed === '/' || trimmed === '' || trimmed === '/index.html' || trimmed === '/stt') {
    return 'index.html';
  }
  const name = trimmed.replace(/^\//, '');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  return ALLOWED.has(name) ? name : null;
}

export async function readFrontendFile(
  rootDir: string,
  urlPath: string,
): Promise<FrontendFile | null> {
  const name = frontendFileName(urlPath);
  if (name === null) {
    return null;
  }
  const fullPath = join(rootDir, name);
  if (!isPathInside(rootDir, fullPath)) {
    return null;
  }
  try {
    const body = await readFile(fullPath);
    return { type: MIME[extname(name)] ?? 'application/octet-stream', body };
  } catch {
    return null;
  }
}
