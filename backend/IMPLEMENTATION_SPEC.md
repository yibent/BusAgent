# BusAgent Backend Implementation Specification

## 0. 文档目的

本文是后端首版实现规范，目标是让 Claude Code 或其他开发者可以直接据此实现一个可运行的最小版本。实现范围只包括 `backend/`，不实现具体 Agent 的业务逻辑、模型调用或机器人驱动。

所有未在本文明确要求的行为，不应自行扩展为新的框架能力。

## 1. 已冻结的决策

- 后端使用 NestJS + Fastify + TypeScript，运行时 Node.js 22；
- Package 和 App 都是本地 JSON 配置文件；
- Package 描述通用 Agent 能力、Endpoint、事件契约、并发和重试策略；
- App 描述使用哪些 Agent、提示词文件、Agent 配置和允许的事件路由；
- 配置只在 Host 启动时读取并生成不可变快照，运行期间不热更新；
- `agent_id` 在整个 BusAgent 实例内全局唯一，安装冲突直接失败；
- 每个 `agent_id` 只允许一个活动实例；
- Agent 可以是进程内 TypeScript 类，也可以是外部 HTTP 服务；
- HTTP Endpoint URL 直接写入 Package；
- 不使用 HTTP 身份认证，部署边界内的 Host、Agent、Redis 和 MySQL 均视为可信；
- 所有业务通信都是异步事件，不使用同步业务响应和流式传输；
- 所有 Agent 都向 Host 的统一 `POST /v1/events` 发布事件；
- BullMQ/Redis 负责队列和投递，MySQL 负责持久化事实；
- 队列粒度为每个 `app_id + agent_id` 一个 BullMQ 队列；
- 完整 JSON 事件正文存入 MySQL；大型媒体只存外部引用；
- Agent 注册租约 TTL 固定 30 秒，每 10 秒续租；
- 重试上限和默认策略由 Package 声明，App 只能进一步收紧；
- Agent 可在 App 允许目标集合内建议下一跳；Host 负责最终检查和投递；
- 物理执行器必须发布 `accepted`、`started`、`completed`、`failed`、`unknown` 事件；
- MySQL 数据访问层使用 Drizzle ORM。

## 2. 非目标

首版不实现：

- LangChain、LangGraph、CrewAI 或其他 Agent 编排框架；
- 模型供应商抽象和模型调用客户端；
- HTTP 身份认证、mTLS、多租户隔离和不可信插件沙箱；
- WebSocket、SSE、Chunked Response 或任何流式协议；
- 外部消息中间件适配器；
- ROS 2、DDS、机械臂驱动或真实硬件控制；
- 运行时配置热加载、灰度切换和在线升级；
- 自动发现服务 URL。URL 必须来自 Package。

## 3. 运行时分层

```text
HTTP API / CLI
      |
Runtime Host
  - startup config loader
  - package/app validator
  - global agent registry
  - event ingress and router
  - lease manager
      |
Adapters
  - InProcessAgentAdapter
  - HttpAgentAdapter
      |
BullMQ + Redis -------------- MySQL + Drizzle
queues / retries / jobs        events / snapshots / audit
```

建议目录：

```text
src/
  main.ts
  app/
  config/
  package/
  registry/
  protocol/
  bus/
    queue/
    routing/
    delivery/
  adapters/
    in-process/
    http/
  persistence/
    db/
    repositories/
  leases/
  supervision/
  observability/
  common/
```

## 4. 配置目录和启动参数

推荐目录：

```text
backend-config/
  packages/
    robot-core.package.json
  apps/
    desktop-robot.app.json
    prompts/
      planner.md
      dialogue.md
```

环境变量：

```text
BUSAGENT_CONFIG_DIR=./backend-config
BUSAGENT_PACKAGE_DIR=./backend-config/packages
BUSAGENT_APP_FILE=./backend-config/apps/desktop-robot.app.json
BUSAGENT_REDIS_URL=redis://127.0.0.1:6379
BUSAGENT_MYSQL_URL=mysql://user:password@127.0.0.1:3306/busagent
BUSAGENT_EVENT_INGRESS_PATH=/v1/events
BUSAGENT_REGISTRATION_PATH=/internal/registrations
```

Host 启动流程：

1. 读取所有 Package JSON；
2. 校验 JSON Schema、版本、路径和全局 `agent_id` 唯一性；
3. 读取 App JSON 及其目录内的 prompt/config 文件；
4. 校验 App 引用的 Agent、事件类型、路由目标和配置 Schema；
5. 将 Package/App 快照写入 MySQL；
6. 注册进程内 Agent 类，等待外部 Agent 注册；
7. 为当前 App 的每个 Agent 初始化 BullMQ 队列；
8. 只有所需 Agent 均健康时才将 App 标记为 `ready`；
9. 开始接收和路由事件。

启动校验失败时进程必须退出，并打印结构化诊断。禁止带着部分配置继续启动。

## 5. Package 配置规范

文件名：`*.package.json`。

```json
{
  "schema_version": "1",
  "package": {
    "id": "robot-core-agents",
    "version": "1.0.0"
  },
  "agents": [
    {
      "agent_id": "robot.planner",
      "endpoint": {
        "adapter": "http",
        "event_url": "http://planner:8080/v1/events",
        "health_url": "http://planner:8080/health"
      },
      "consumes": ["intent.created", "perception.completed"],
      "produces": ["plan.created", "plan.failed"],
      "configuration_schema": "schemas/planner-config.json",
      "concurrency": {
        "mode": "partitioned",
        "partition_key": "task_id",
        "limit": 8
      },
      "retry": {
        "max_attempts": 3,
        "backoff_ms": 1000,
        "dead_letter": true
      },
      "permissions": {
        "context": ["task.*", "perception.*"],
        "side_effects": []
      }
    },
    {
      "agent_id": "robot.dialogue",
      "endpoint": {
        "adapter": "in-process",
        "registration_key": "DialogueAgent"
      },
      "consumes": ["intent.created", "execution.completed"],
      "produces": ["reply.created"],
      "configuration_schema": "schemas/dialogue-config.json",
      "concurrency": {
        "mode": "partitioned",
        "partition_key": "conversation_id",
        "limit": 16
      },
      "retry": {
        "max_attempts": 2,
        "backoff_ms": 500,
        "dead_letter": true
      },
      "permissions": {
        "context": ["conversation.*"],
        "side_effects": []
      }
    }
  ]
}
```

Package 必须声明全局唯一 `agent_id`、固定 Endpoint、消费/生产事件类型、配置 Schema、并发限制、权限和最大重试策略。安装时发现冲突必须拒绝整个 Package。

## 6. App 配置规范

文件名：`*.app.json`。prompt/config 路径必须是 App 文件所在目录的相对路径，禁止通过 `..` 跳出 App 目录。

```json
{
  "schema_version": "1",
  "app": {
    "id": "desktop-robot-assistant",
    "version": "2026.08"
  },
  "agents": [
    {
      "agent_id": "robot.planner",
      "required": true,
      "config": {
        "prompt_file": "prompts/planner.md",
        "model": "configured-by-agent",
        "max_plan_depth": 8
      },
      "retry_override": { "max_attempts": 2 }
    },
    {
      "agent_id": "robot.dialogue",
      "required": true,
      "config": {
        "prompt_file": "prompts/dialogue.md",
        "language": "zh-CN"
      }
    }
  ],
  "routes": [
    {
      "event": "intent.created",
      "to": ["robot.planner", "robot.dialogue"]
    },
    {
      "event": "plan.created",
      "from": ["robot.planner"],
      "to": ["robot.executor"]
    }
  ]
}
```

App 校验必须确认：引用 Agent 已安装、事件契约匹配、prompt/config 文件存在且在 App 目录内、重试覆盖值不超过 Package 上限、路由目标属于允许集合。Agent 的下一跳建议只能使用该集合中的目标。

## 7. 事件信封

```ts
type BusEvent = {
  eventId: string;
  eventType: string;
  appId: string;
  sourceAgentId: string;
  correlationId: string;
  causationId?: string;
  taskId?: string;
  taskVersion?: number;
  priority: number;
  createdAt: string;
  deadline?: string;
  idempotencyKey?: string;
  payload: unknown;
};
```

事件不可变。Host 生成 `eventId`、接收时间和 trace 信息。Agent 发布事件时必须填写来源、事件类型、因果关系和业务 payload；Host 不允许 Agent 伪造其他 `sourceAgentId`。

## 8. HTTP 事件和注册协议

Host 投递 Agent：

```http
POST <package.endpoint.event_url>
Content-Type: application/json
Idempotency-Key: <event-id>

{ "event": { "...": "BusEvent" }, "agent_config": {} }
```

Agent 接收后返回 `202 Accepted`。业务完成、失败、取消和物理状态都通过 Host 的统一入口发布：

```http
POST /v1/events
Content-Type: application/json

{ "event_type": "plan.created", "source_agent_id": "robot.planner", "causation_id": "evt_123", "payload": {} }
```

外部服务注册：

```http
POST /internal/registrations
Content-Type: application/json

{
  "agent_id": "robot.planner",
  "endpoint_url": "http://planner:8080/v1/events",
  "instance_version": "1.0.0",
  "lease_ttl_seconds": 30
}
```

续租固定每 10 秒发送一次。已注册的同一 `agent_id` 在租约未过期前再次注册必须返回冲突；租约过期后才允许重新注册。注册内容必须与 Package 的固定 URL 和契约完全一致。

## 9. 适配器接口

```ts
interface AgentAdapter {
  deliver(event: BusEvent, config: AgentRuntimeConfig): Promise<DeliveryAck>;
  cancel(eventId: string): Promise<DeliveryAck>;
  health(): Promise<HealthStatus>;
  close(): Promise<void>;
}
```

`deliver()` 只返回投递确认，不返回业务结果。进程内 Agent 通过静态注册表挂载：

```ts
agentClasses.register("DialogueAgent", dialogueAgentInstance);
```

Package 只能引用已注册的 `registration_key`，不能根据配置字符串动态加载任意代码。

## 10. 队列、持久化和重试

队列名固定为：

```text
busagent:{app_id}:{agent_id}
```

BullMQ/Redis 负责待投递队列、延迟重试、并发限制、优先级、取消标记和短期 Job 状态。MySQL + Drizzle 负责：

- Package/App 启动快照；
- 全局 Agent 注册表和租约记录；
- 完整 JSON 事件正文；
- 事件投递记录、任务状态和幂等记录；
- 死信元数据、审计和 trace 索引。

Redis 不是唯一事实来源；恢复依赖 MySQL。事件正文使用 MySQL JSON 字段，大型音频、图像和文件只保留外部引用。

| 事件类型 | 默认处理 |
| --- | --- |
| 普通事件 | 至少一次投递；按 Package 上限重试，失败后进入死信，可人工重投。 |
| 任务事件 | 必须携带 `task_id` 和 `task_version`；过期结果不得推进当前任务；重试前检查任务状态。App 只能降低 Package 的最大尝试次数。 |
| 物理副作用事件 | 必须携带执行凭证和幂等键；禁止普通自动重试；执行器必须发布状态事件。 |

## 11. 物理执行状态

执行器对每个物理动作必须发布以下事件之一或按顺序发布：

```text
accepted  -> started -> completed
                    -> failed
                    -> unknown
```

`unknown` 表示无法确定硬件是否执行成功。进入 `unknown` 后，Host 必须暂停该动作的自动重试，转入硬件状态查询或人工恢复流程。

## 12. 注册、路由和生命周期

服务注册是上线声明，不创建 Agent，也不能扩大 Package 权限。健康租约是 Agent 是否可路由的主要依据；Host 可调用 health URL 进行诊断，但不能以诊断结果代替租约。

Agent 的下一跳建议必须经过以下检查：

1. 目标 Agent 是否在当前 App 的允许集合；
2. 事件类型是否在目标 Agent 的 `consumes` 中；
3. 当前任务版本、权限、资源和监督策略是否允许；
4. 是否超过单任务派生深度或事件预算。

```text
read local Package JSON -> validate global agent ids -> register expected agents
read local App JSON -> resolve relative files -> validate routes/config -> create startup snapshot
await service registrations -> health-check agents -> ready -> receive and route events
shutdown -> drain queues -> persist state -> stop
```

配置变化必须修改本地文件并重启 Host。启动失败时保留上一轮 MySQL 快照和诊断信息，但不混合新旧配置。

## 13. 实现顺序

1. 添加 Drizzle、MySQL 驱动、BullMQ 和 Redis 配置；
2. 定义 Package、App、Event Envelope 的 Zod Schema；
3. 实现启动加载、路径安全检查和全局 Agent 冲突检测；
4. 实现 MySQL migration、Repository 和启动快照；
5. 实现全局 Agent Registry、注册租约和单实例约束；
6. 实现 `InProcessAgentAdapter` 与 `HttpAgentAdapter`；
7. 实现 BullMQ 队列、统一 `/v1/events`、`202` 投递确认和幂等；
8. 实现 App 路由、下一跳建议校验、重试和死信；
9. 实现任务版本、取消、物理执行状态和 trace；
10. 编写集成测试和故障注入测试。

## 14. 验收标准

- 启动时能加载多个 Package 和一个 App，并拒绝重复 `agent_id`；
- App 能引用相对 prompt 文件，禁止路径逃逸；
- 一个进程内 Agent 和一个 HTTP Agent 能通过事件完成一条链路；
- 每个 `app_id + agent_id` 使用独立 BullMQ 队列；
- HTTP 投递只依赖 `202`，业务结果通过 `/v1/events` 回传；
- 重复事件不会产生重复业务副作用；
- 租约 30 秒、10 秒续租，过期 Agent 不再接收事件；
- App 重试覆盖不能超过 Package 上限；
- 旧任务版本结果不会推进当前任务；
- 物理动作出现 `unknown` 后不会自动重放；
- MySQL 可恢复事件状态、配置快照、死信和审计记录；
- 关闭和重启后，Redis 队列可根据 MySQL 状态恢复。
