import { ModelConfig } from './model-config.js';
import { complete, type Message } from './model-client.js';
import { TaskEngine } from './task-engine.js';
import { submitWorkspaceTransition, workspaceStatus } from './workspace-lifecycle.js';

interface Reply {
  code(status: number): Reply;
  send(value: unknown): unknown;
}
interface Request {
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}
interface Routes {
  get(
    path: string,
    handler: (request: unknown, reply: Reply) => Promise<void>,
  ): unknown;
  post(
    path: string,
    handler: (request: unknown, reply: Reply) => Promise<void>,
  ): unknown;
}
export function intelligenceRoutes(
  app: Routes,
  engine: TaskEngine,
  models: ModelConfig,
) {
  const route =
    (run: (request: Request) => Promise<unknown>) =>
    async (request: unknown, reply: Reply) => {
      try {
        reply.send(await run(request as Request));
      } catch (error) {
        reply.code(400).send({ error: (error as Error).message });
      }
    };
  app.get(
    '/v1/tasks/status',
    route(async () => {
      const { enabled, paused, goals } = await engine.snapshot();
      return {
        enabled,
        paused,
        active: goals.filter(
          (g) => !['completed', 'cancelled', 'blocked', 'paused'].includes(g.state),
        ).length,
      };
    }),
  );
  app.get(
    '/v1/tasks',
    route(() => engine.snapshot()),
  );
  app.get(
    '/v1/workspace/status',
    route(() => workspaceStatus()),
  );
  app.post(
    '/v1/workspace/transition',
    route((request) =>
      submitWorkspaceTransition(
        request.body as {
          token?: unknown;
          scene_id?: unknown;
          request_id?: unknown;
        },
        models,
      ),
    ),
  );
  app.post(
    '/v1/tasks/control',
    route(async (request) => {
      const body = request.body as {
        action: string;
        id?: string;
        instruction?: string;
      };
      await engine.control(body.action, body.id, true, body.instruction ?? '');
      return engine.snapshot();
    }),
  );
  app.get(
    '/v1/model-config',
    route(() => models.publicSettings()),
  );
  app.post(
    '/v1/model-config',
    route((request) => {
      const body = request.body as {
        settings: unknown;
        token: unknown;
        resetDialogue?: boolean;
      };
      return models.save(body.settings, body.token, body.resetDialogue === true);
    }),
  );
  app.post(
    '/v1/model-config/test',
    route(async (request) => {
      const body = request.body as {
        token: unknown;
        profile: string;
        vision?: boolean;
      };
      await models.authorize(body.token);
      const settings = await models.settings();
      const profile = settings.profiles.find((p) => p.id === body.profile);
      if (!profile?.apiKey) throw new Error('模型缺少 API Key。');
      const messages: Message[] = [{ role: 'user', content: 'Reply with exactly OK.' }];
      if (body.vision) {
        if (!settings.images || !profile.vision)
          throw new Error('请先启用按需图片读取和此模型的图像支持。');
        const frame = await engine.image('scene');
        messages[0] = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '用一句中文描述图片中实际可见的物品。本请求只测试读图，不执行任务。',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${frame.bytes.toString('base64')}`,
              },
            },
          ],
        };
      }
      const answer = await complete(profile, messages, []);
      return {
        ok: true,
        vision_tested: body.vision === true,
        model: profile.model,
        elapsed_ms: answer.elapsed_ms,
        usage: answer.usage,
        message: answer.message.content,
      };
    }),
  );
}
