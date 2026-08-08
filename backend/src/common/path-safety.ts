import { resolve, sep } from 'node:path';

/**
 * Returns true when `candidate` resolves to a path that is either the root
 * directory itself or strictly inside it. Used to forbid `..` escapes from
 * App/Package directories (spec §6).
 */
export function isPathInside(rootDir: string, candidate: string): boolean {
  const root = resolve(rootDir);
  const cand = resolve(candidate);
  if (cand === root) {
    return true;
  }
  return cand.startsWith(`${root}${sep}`);
}
