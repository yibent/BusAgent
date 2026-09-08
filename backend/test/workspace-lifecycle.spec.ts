import { describe, expect, it } from 'vitest';
import { submitWorkspaceTransition } from '../src/apps/desktop-robot/intelligence/workspace-lifecycle.js';

describe('workspace lifecycle validation', () => {
  it('validates the request id before launching a transition', async () => {
    await expect(
      submitWorkspaceTransition(
        { scene_id: 'sorting', request_id: '../bad' },
      ),
    ).rejects.toThrow('请求编号无效');
  });
});
