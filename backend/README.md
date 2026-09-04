# BusAgent Backend Architecture

本文定义后端运行时的扩展边界。BusAgent 是基于事件的 Agent 宿主，不规定 Agent 使用的模型、提示词框架、编排框架或部署方式。Agent 可以是当前 TypeScript 进程中的类，也可以是通过 HTTP 接入的外部服务。

可直接执行的首版实现规格见 [IMPLEMENTATION_SPEC.md](IMPLEMENTATION_SPEC.md)。

## 本地体验

仓库根目录拉起 MySQL：

```bash
docker compose up -d mysql
```

默认账号与 Host 配置一致：`root` / `root`，库名 `busagent`，宿主机端口 `3307`（避免和本机 MySQL 抢 3306）。

然后启动 Host，并打开语音助手：

```bash
cd backend
export DASHSCOPE_API_KEY=sk-你的key
export BUSAGENT_MYSQL_URL=mysql://root:root@127.0.0.1:3307/busagent
pnpm install
pnpm dev
```

浏览器打开 [http://localhost:3000/](http://localhost:3000/)。前端文件在仓库 `frontend/`，由 Host 同源托管。

### 机器人指令链路

`desktop-robot-assistant` 当前使用以下真实事件链路：

```text
transcript.final
  -> InstructionUnderstandingNode
  -> GroundingClarificationNode
  -> TaskPlannerNode
  -> PlanValidatorNode
  -> LoopRouterNode
  -> ExecutionCoordinatorNode
  -> RobotAdapterNode
  -> execution.completed / failed / unknown
  -> DialogueAgent -> TTS
```

`InterruptMonitorNode` 同时监听增量和最终转写；“停一下”“别动”等短语会绕过普通语义规划，直接生成 `hold`。执行适配器默认调用 `http://127.0.0.1:7861/api/command`，可通过 App 配置中的 `controller_url` 替换为其他 HTTP Provider；以后也可实现同一 `RobotAdapter` 接口的 MCP 或 ROS Provider。

当前控制器支持 `select_target`、`perceive`、`follow`、`hold`、`stop`、`status`。抓取/放置计划使用 `plan_grasp`、`move_to`、`grasp`、`transport`、`place` 和 `verify_placement`，这些尚无控制器实现，调用时返回 `execution.failed`。系统不会将规划成功当作物理执行成功。

计划校验和执行门是确定性代码，不调用模型。当前只校验技能名称、必需参数、前后置条件、任务版本和执行车道；没有额外引入复杂的身份认证或审批流程。


## 1. 已确定的架构选择

- 使用两类配置文件：Agent Package 和 App；
- Package 提供一组可复用的通用 Agent 能力；
- App 选择 Agent，并定义提示词、配置和 Agent 之间的事件交互；
- `agent_id` 在整个 BusAgent 实例中全局唯一；
- HTTP Agent 不进行应用层身份认证；
- HTTP Endpoint 直接在 Package 中写 URL；
- Agent 通信统一采用异步事件模式；
- 不通过 HTTP 请求同步返回业务结果。语音转文字以短文本事件流式发给下游；原始音频走 `/v1/stt` WebSocket，不进入事件总线。助手语音由 Qwen-TTS 合成，PCM 同样走该 WebSocket，不进入事件总线。
- Package 接线是本地 JSON；App 是同一进程中的模块，JSON 描述路由，TypeScript 实现 Agent；配置在 Host 启动时一次性加载，运行期间不热更新；
- 外部服务主动注册并定期续租；一个 `agent_id` 只允许一个活动实例；
- Event Bus 使用进程内队列负责投递，MySQL 负责配置快照、事件状态和审计；
- Agent 可以在 App 声明的允许范围内建议下一跳；
- 普通事件、任务事件和物理副作用事件使用不同的失败与重试策略；
- 配置安装发现全局 `agent_id` 冲突时直接拒绝。
- 所有 Agent 都通过 Host 统一的 `/v1/events` 回传事件；
- 队列粒度为每个 `app_id + agent_id` 一个进程内队列；不使用 Redis；
- 完整 JSON 事件正文持久化到 MySQL；
- 注册租约固定为 30 秒，每 10 秒续租；
- 重试策略由 Agent Package 声明，App 只能缩小重试范围；
- 执行器必须发布 `accepted`、`started`、`completed`、`failed`、`unknown` 五类状态事件；
- MySQL 数据访问层采用 Drizzle ORM。

不进行 HTTP 身份认证意味着当前版本假定 Host、Agent 和 MySQL 均处于完全可信的部署边界内。

## 2. 核心模型

```mermaid
flowchart LR
    PKG[Package Config\n提供通用 Agent] --> REG[Global Agent Registry]
    APP[App Config\n选择 Agent / 提示词 / 事件关系] --> AR[App Runtime]
    REG --> AR
    AR --> BUS[Event Bus]
    BUS --> TS[In-process TS Agent]
    BUS --> HTTP[HTTP Agent Service]
    TS --> BUS
    HTTP --> BUS
```

- **Agent**：拥有全局唯一 `agent_id`、事件契约和 Endpoint 的处理单元。
- **Package**：一组 Agent 的能力声明和 Endpoint 配置，可被多个 App 复用。
- **App**：具体应用定义，描述使用哪些 Agent、向每个 Agent 注入什么配置，以及事件如何连接。
- **Endpoint**：Agent 接收事件的位置，可以是已注册的进程内类或固定 HTTP URL。
- **App Runtime**：由 App 配置实例化的运行上下文，持有提示词版本、配置版本和事件路由快照。
- **Event Bus**：接收、持久化、路由和投递事件，维护因果关系、去重、重试和取消。

Package 不包含具体任务编排；App 不重新定义 Agent 的真实能力和权限。App 只能在 Package 声明允许的范围内配置和连接 Agent。

## 3. 后端模块边界

```text
src/
  app/             # App 配置、校验、启动快照
  package/         # Package 配置、安装和启动加载
  registry/        # 全局 agent_id、endpoint、实例和健康状态
  protocol/        # event envelope、identity、schema、ack、error
  bus/              # event ingress、routing、in-process delivery、retry、cancel
  adapters/         # in-process class、HTTP event delivery
  modules/          # 可复用能力模块（stt、dialogue）
  apps/             # App 组合模块（只接线，不实现通用能力）
  context/          # context refs、version、assembly
  supervision/      # policy、permission、approval
  execution/        # resource lease、idempotency、execution credential
  observability/    # trace、audit、metrics、replay
  common/           # ids、errors、clock、configuration
```

MySQL 访问层使用 Drizzle ORM。选择它是因为事件和审计数据需要显式 SQL、JSON 字段与索引控制，同时保留 TypeScript 类型推导；代价是比 TypeORM 少一些 Nest 风格的实体抽象，需要团队自行约束 Repository、事务和迁移目录。

## 4. Package 配置

Package 描述“系统中有哪些通用 Agent，以及如何把事件交给它们”。建议文件名为 `busagent.package.json`：

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
      "permissions": {
        "context": ["conversation.*"],
        "side_effects": []
      }
    }
  ]
}
```

安装 Package 时必须拒绝与现有注册表冲突的 `agent_id`。Package 和 App 只在 Host 启动时加载；修改本地 JSON 或 App 目录文件不会影响当前运行实例，必须重启后才生效。

## 5. App 配置

App 描述“使用哪些 Agent，以及它们在这个应用中如何协作”。建议文件名为 `busagent.app.json`：

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
      }
    },
    {
      "agent_id": "robot.dialogue",
      "required": true,
      "config": {
        "prompt_file": "prompts/dialogue.md",
        "language": "zh-CN"
      }
    },
    {
      "agent_id": "robot.executor",
      "required": true,
      "config": {}
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

App 启动加载时执行以下检查：

- 引用的 `agent_id` 是否已由某个 Package 安装；
- Agent 是否声明消费和产生这些事件；
- `config` 是否符合 Agent 的 `configuration_schema`，以及 `prompt_file` 是否位于 App 目录内；
- 路由是否越过 Agent 权限或形成禁止的循环；
- 所有 `required` Agent 是否健康可用。

提示词属于 App 目录和 App 配置，而不是 Package 的 Agent 定义。Host 启动时读取并校验这些文件，生成不可变运行快照；事件记录具体使用的 App、Package、Agent 和提示词内容校验值，保证回放时能够还原。

## 6. Agent 适配器

Core 使用统一抽象处理进程内类和 HTTP 服务：

```ts
interface AgentAdapter {
  deliver(event: BusEvent, config: AgentRuntimeConfig): Promise<DeliveryAck>;
  cancel(eventId: string): Promise<DeliveryAck>;
  health(): Promise<HealthStatus>;
  close(): Promise<void>;
}
```

`deliver()` 返回的只是投递确认，不是业务结果。业务结果必须作为一个新的事件重新发布到 Event Bus。

进程内 Agent 通过静态注册表挂载：

```ts
agentClasses.register("DialogueAgent", dialogueAgentInstance);
```

Package 只能引用已注册的 `registration_key`，不能根据字符串动态加载任意代码。

## 7. HTTP 异步事件协议

Host 将事件投递给 Package 中配置的固定 URL：

```http
POST /v1/events
Content-Type: application/json
Idempotency-Key: <event-id>

{
  "event": {
    "event_id": "evt_123",
    "event_type": "intent.created",
    "app_id": "desktop-robot-assistant",
    "source_agent_id": "system.input",
    "correlation_id": "corr_123",
    "causation_id": "evt_122",
    "task_id": "task_123",
    "task_version": 1,
    "created_at": "2026-08-08T12:00:00Z",
    "payload": {}
  },
  "agent_config": {}
}
```

Agent 接受事件后返回 `202 Accepted`。处理成功、失败或取消都通过新的事件报告，不在当前 HTTP 响应中返回业务结果。

Agent 向 Host 发布事件：

```http
POST /v1/events
Content-Type: application/json

{
  "event_type": "plan.created",
  "source_agent_id": "robot.planner",
  "correlation_id": "corr_123",
  "causation_id": "evt_123",
  "payload": {}
}
```

所有 Agent 统一向 Host 的 `/v1/events` 发布事件。Host 验证事件结构和来源 `agent_id` 是否与 Package 契约一致，然后补充系统生成的 `event_id`、接收时间和 trace。由于没有 HTTP 身份认证，来源校验只能约束协议，不能证明请求者身份。

## 8. 服务注册与健康状态

外部服务通过 `POST /internal/registrations` 告知 Host 自己已经上线，并按租约周期调用续租接口。注册内容必须匹配 Package 中已存在的全局 `agent_id` 和固定 URL。注册不创建 Agent，也不能修改能力或 Endpoint。

注册的作用仅限于：

- 上报服务实例和版本；
- 建立并续租健康租约（固定 TTL 30 秒，每 10 秒续租）；
- 暂停或恢复路由；
- 提供负载信息；
- 同一 `agent_id` 只保留一个活动实例。

服务必须主动注册并定期续租；Host 可以额外调用 `health_url` 做诊断，但健康租约才是实例是否可路由的主要依据。

## 9. Event Bus 语义

- 每个业务输出都是不可变事件，不存在流式分片；
- 事件采用至少一次投递，Agent 必须按 `event_id` 幂等处理；
- HTTP `202` 只表示接收，不表示业务完成；
- 使用 `correlation_id` 关联一次交互，使用 `causation_id` 建立事件因果链；
- 使用 `task_id + task_version` 拒绝过期任务结果；
- 取消也是事件，不能假设 HTTP 请求终止等同于任务取消；
- 对副作用操作使用额外的幂等键和执行凭证；
- 路由依据启动时加载的 App 快照，运行中的任务不会发生配置切换。Agent 的下一跳建议必须匹配 App 的允许目标集合，并经过 Host 的结构和策略检查。

### 9.1 进程内队列与 MySQL 的职责

- 进程内队列：待投递作业、延迟重试、并发限制和优先级；
- 队列命名固定为 `busagent:{app_id}:{agent_id}`，每个 App 使用的 Agent 都有独立队列；
- MySQL：Package/App 启动快照、全局 Agent 注册表、完整 JSON 事件、任务状态、幂等记录、死信元数据和审计记录；
- 进程内队列不是事实来源，重启恢复依赖 MySQL 中的事件和投递状态；
- 完整事件正文写入 MySQL JSON 字段；音频、图像等大对象仍只保存外部引用，不直接塞入事件正文。

### 9.2 事件分类

| 类型 | 示例 | 默认语义 |
| --- | --- | --- |
| 普通事件 | `reply.created`、`perception.completed` | 至少一次投递；有限次重试后进入死信，可人工重投。 |
| 任务事件 | `plan.created`、`task.cancelled` | 必须携带 `task_id` 和 `task_version`；过期结果不得推进当前任务；重试前检查任务状态。重试上限由 Package 声明，App 只能缩小范围。 |
| 物理副作用事件 | `robot.execute.requested` | 必须携带执行凭证和幂等键；执行器必须发布 `accepted`、`started`、`completed`、`failed` 或 `unknown`；`unknown` 状态禁止自动重放动作。 |

Package 可以为 Agent 或事件类型声明最大尝试次数、退避策略、死信策略和是否允许人工重投。App 配置只能使用更严格的值，不能放宽 Package 的上限。

## 10. 生命周期

```text
read local Package JSON -> validate global agent ids -> register expected agents
read local App JSON -> resolve relative files -> validate routes/config -> create startup snapshot
await service registrations -> health-check agents -> ready -> receive and route events
shutdown -> drain queues -> persist state -> stop
```

配置更新不属于运行时操作。Package 或 App 变化必须修改本地文件并重启 Host；启动失败时保留上一轮持久化快照和诊断信息，但不自动混合新旧配置。

## 11. 首期实现顺序

1. 定义 Package、App 和 Event Envelope 的 Zod Schema；
2. 实现全局 Agent Registry 和配置冲突检测；
3. 实现 `InProcessAgentAdapter` 与 `HttpAgentAdapter`；
4. 实现基于进程内队列的纯异步 Event Bus、`202` 投递确认和事件回传入口；
5. 实现 App 配置校验、App 目录文件解析、运行快照和事件路由；
6. 实现幂等、重试、取消、健康检查和 trace；
7. 再加入资源租约和监督策略；配置版本切换不在运行时实现。

首个验证场景应使用一个进程内 TS Agent 和一个 HTTP Agent，让二者通过事件完成同一条任务链，证明实现方式对 App 配置透明。
