import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';

/**
 * Verifies the whole Nest DI graph can be instantiated without booting the
 * host lifecycle (no MySQL connections are made): every provider is
 * resolvable by type and the forwardRef module cycle between Bus/Adapters
 * composes correctly.
 */
describe('DI graph', () => {
  it('resolves every provider in AppModule', async () => {
    const app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(app).toBeDefined();
    await app.close().catch(() => undefined);
  }, 15_000);
});
