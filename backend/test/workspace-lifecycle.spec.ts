import { describe, expect, it, vi } from 'vitest';
import { submitWorkspaceTransition } from '../src/apps/desktop-robot/intelligence/workspace-lifecycle.js';
import type { ModelConfig } from '../src/apps/desktop-robot/intelligence/model-config.js';

describe('workspace lifecycle authorization', () => {
  it('rejects before reading or launching a transition when the token is wrong', async () => {
    const authorize = vi.fn().mockRejectedValue(new Error('unauthorized'));
    await expect(
      submitWorkspaceTransition(
        {
          token: 'wrong',
          scene_id: 'sorting',
          request_id: 'a'.repeat(32),
        },
        { authorize } as unknown as ModelConfig,
      ),
    ).rejects.toThrow('unauthorized');
    expect(authorize).toHaveBeenCalledOnce();
  });

  it('validates the request id after authorization', async () => {
    const authorize = vi.fn().mockResolvedValue(undefined);
    await expect(
      submitWorkspaceTransition(
        { token: 'ok', scene_id: 'sorting', request_id: '../bad' },
        { authorize } as unknown as ModelConfig,
      ),
    ).rejects.toThrow('请求编号无效');
    expect(authorize).toHaveBeenCalledOnce();
  });
});
