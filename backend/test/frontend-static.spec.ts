import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frontendFileName, readFrontendFile } from '../src/app/frontend-static.js';

describe('frontendFileName', () => {
  it('maps the app shell paths to index.html', () => {
    expect(frontendFileName('/')).toBe('index.html');
    expect(frontendFileName('/stt')).toBe('index.html');
    expect(frontendFileName('/index.html')).toBe('index.html');
  });

  it('allows the known static assets', () => {
    expect(frontendFileName('/styles.css')).toBe('styles.css');
    expect(frontendFileName('/app.js')).toBe('app.js');
  });

  it('rejects path escape and unknown files', () => {
    expect(frontendFileName('/../secret.txt')).toBeNull();
    expect(frontendFileName('/nested/app.js')).toBeNull();
    expect(frontendFileName('/package.json')).toBeNull();
  });
});

describe('readFrontendFile', () => {
  it('reads an allowed file from the frontend directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'busagent-ui-'));
    writeFileSync(join(dir, 'index.html'), '<html>ok</html>');
    const file = await readFrontendFile(dir, '/');
    expect(file?.type).toContain('text/html');
    expect(file?.body.toString('utf8')).toContain('ok');
  });
});
