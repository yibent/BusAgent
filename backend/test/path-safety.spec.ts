import { describe, expect, it } from 'vitest';
import { isPathInside } from '../src/common/path-safety.js';

describe('isPathInside', () => {
  it('accepts nested relative paths inside the app directory', () => {
    expect(isPathInside('/app', '/app/prompts/planner.md')).toBe(true);
  });

  it('accepts the directory root itself', () => {
    expect(isPathInside('/app', '/app')).toBe(true);
  });

  it('rejects escapes via ..', () => {
    expect(isPathInside('/app', '/app/../secret.txt')).toBe(false);
    expect(isPathInside('/app', '/etc/passwd')).toBe(false);
  });

  it('rejects a sibling path that merely shares a prefix', () => {
    expect(isPathInside('/app', '/app-other/file.txt')).toBe(false);
  });
});
