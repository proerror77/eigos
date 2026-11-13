# EIGOS

EIGOS 通过共享 PostgreSQL 本体提供对象集查询、Function 和 Action。Gateway 接收 MCP、A2A 与 HTTP 请求，Worker 中的模型 Agent 根据任务锁定的 Ontology 自行选择查询、来源读取、Function 与 Action。当前代码覆盖服务查询、PA 日历排程，以及经明确授权的活动报名和定时出行执行链。

架构、Schema 和实际支持范围见 [Ontology 架构](docs/architecture/ontology.md)。

本体模型的定义、查询、Action、Scenario 和持久化验收见 [Ontology 模型验证](docs/guides/ontology-model-validation.md)。这些能力可直接通过 MCP、HTTP 和 TypeScript 客户端使用。

## 启动

使用 Node.js 22.22.3、PostgreSQL 17 和 npm。

```sh
npm ci
cp .env.example .env
```

在 `.env` 中配置 PostgreSQL 连接与认证。初始化表和发布定义后启动两个进程。

```sh
npm run db:init
npm run access:grant-member -- local-developer
npm run ontology:publish
npm run dev:gateway
npm run dev:worker
```

初始化、升级、授权配置及发布使用现有数据库的管理凭据；常驻 Gateway/Worker 账号只读取授权记录，不能自行授权或发布。生产账号用其已验证的 owner 标识代替 `local-developer`。

Gateway 和 Worker 使用相同的 `DATABASE_URL`、`EIGOS_PG_SCHEMA`。构建后的入口为 `npm run start:gateway` 和 `npm run start:worker`。Docker 的 `runtime` 与 `worker` target 使用相同代码。

JWT 身份由现有身份提供方验证，owner 由 issuer、tenant 和 subject 计算。`GET /identity` 返回当前 owner 与 scopes。本地开发使用 `.env` 中的随机令牌，owner 为 `local-developer`。

`OAUTH_TENANT_CLAIM` 可配置身份提供方的租户字段。PA 使用任务权限提交询价，Worker 在该任务 owner 的有效来源绑定内执行本体操作。直接调用本体 API 仍使用令牌中的对应权限。来源连接可带 `expiresAt`，运行时按其截止时间检查。

## Worker 模型

Worker 使用已安装的 `@deepseek-ai/dsh` 0.2.1-rc.5（含 `dsh-llm-pi-ai`、`dsh-mcp-client`），通过其 SDK 协议运行一个任务会话。配置 `EIGOS_HARNESS_BIN`、`EIGOS_HARNESS_CREDENTIAL_FILE`、`EIGOS_HARNESS_MODEL` 和 `EIGOS_HARNESS_REASONING_EFFORT`。凭据文件由原云端登录流程续期，格式为 `{ "auth_mode": "chatgpt", "tokens": { "access_token": "..." } }`，须由运行用户拥有且权限为 `0600`。刷新令牌不进入模型会话。

模型只获得当前任务的 Ontology 工具，文件、Shell 等执行工具关闭。运行时从任务锁定的发布版本生成目录，模型选择发布的 Interface 业务能力与结果 Function。当前 `RideInquiry.estimate` 由 Function-backed Action 完成地点解析、来源读取和原子编辑，再由结果 Function 返回验收报价。模型无需参与每个确定性步骤。结果中的 `execution` 记录模型、发布引用、工具参数和每次调用耗时。

## 滴滴来源

`EIGOS_DIDI_CONNECTION_FILE` 指向私有 JSON 文件。

```json
{
  "owner": "local-developer",
  "active": true,
  "binding": {
    "bindingId": "my-didi-account",
    "keyFile": "/absolute/private/didi.key",
    "keySha256": "SHA256_OF_TRIMMED_KEY",
    "environment": "production"
  }
}
```

Key 文件由运行用户拥有，权限为 `0600`。查询连接器调用滴滴官方 MCP 的 `maps_textsearch`、`taxi_estimate` 与 `maps_direction_driving`，价格和时长标记为估计，坐标保留供应商声明。读取要求 `Eigos/source/Didi` 的 `read_source` 资源授权。订单连接器独立，默认禁用，具体行程还需 PA 的限时授权。

## Agent 入口

MCP 位于 `/mcp`，提供 `describe_ontology`、`query_ontology`、`evaluate_ontology`、`apply_ontology_action`、`submit_task`、`get_task`、`select_task_places`，以及 PA 的 `list_pa_requests`、`respond_to_task` 和 Scenario 生命周期工具。

A2A Agent Card 位于 `/.well-known/agent-card.json`，JSON-RPC 位于 `/a2a`，使用 A2A 1.0 的 `SendMessage`、`GetTask`、`CancelTask`。两个协议共用任务与本体服务。

HTTP 示例请求体如下，通过 `POST /tasks` 提交，使用 Bearer 身份。

```json
{
  "requestId": "my-inquiry-1",
  "message": "上海从中企·云萃森林到前滩太古里，只询价",
  "route": {
    "city": "上海市",
    "origin": "中企·云萃森林",
    "destination": "前滩太古里"
  }
}
```

`route` 可由 PA 提供，也可只发送自然语言消息，由模型理解需求并选择本体能力。完整场所名称在来源中唯一匹配时直接询价，不要求选择入口。同名或没有完整匹配时，原任务返回 `input-required` 和真实候选对象。向 `/tasks/:id/places` 提交候选的 origin、destination ObjectRef 后继续原任务。执行完成后从 `/tasks/:id` 读取价格及来源。

`POST /ontology/query` 按 Object Type 或 Interface 查询。`POST /ontology/functions` 调用发布的 Function，`POST /ontology/actions` 应用发布的 Action。创建类 Interface Action 使用 `interface: { type: "RideInquiry", implementation: "RideRequest", action: "estimate" }`；实例操作仍可使用 `object` 引用。接口细节和示例见 [架构说明](docs/architecture/ontology.md)。

## 验证

```sh
npm run check
npm run build
npm run ontology:check
npm test
npm run test:e2e:run
```

测试自动创建临时 PostgreSQL 容器，结束后移除。CI 使用独立 PostgreSQL 服务。工程回归使用明确标注的录制 Agent 决策与合成供应商响应，真实模型和真实供应商的端到端计时通过生产入口另行执行。滴滴估价结果的 `accepted=true` 要求链路来源为 `live_readonly`；PA 报告、测试订单和已创建订单分别保留自己的证据与状态。

这一版替换了测试期 SQLite 运行链、历史内核构造链和重复授权投影。旧源码可从 Git 提交 `6eeaf93` 恢复。服务能力通过当前 Ontology 发布定义重新接入，不恢复旧任务库或另一套执行权威。PA 的账号和日历通过结构化请求／回传接入。


## 发布和权限

定义摘要与发布引用分开。发布引用同时绑定定义、实现摘要和对象/关系投影，任务保存该引用。`ontology:prepare` 在同一 PostgreSQL 库内准备候选投影，校验数据和已注册 Function/来源绑定；`ontology:activate -- <release>` 在原子事务中切换。`ontology:publish` 连续完成两步。候选失败或准备后源数据发生变化时，当前版本继续服务。切换前需完成或取消尚未结束的旧任务，避免同一任务混用实现与数据。历史任务和旧投影保留只读。

已有安装先停止写入、备份原 schema，再用 `npm run db:upgrade` 在原库升级。没有新增数据库。生产实现摘要由构建输入生成，Gateway/Worker 在启动与调用时检查绑定。更改属性类型需先修正来源数据；可向 prepare/publish 传入一个绝对路径的普通模块，导出 `project(ref, properties)` 做明确的数据转换，不能隐式强制转换。

权限记录分为定义的 view/edit/manage、对象数据读取、受限属性读取、Action 应用、Function 执行和来源读取。owner 行隔离继续生效。定义管理不授予数据或 Action 权限。额外受限属性没有授权时返回 null，筛选条件也只能看到遮罩后的值。任务输出保留其读取权限依赖，撤权后不会从缓存继续返回受限结果。

`npm run access:configure -- /absolute/private/access.json` 使用数据库管理角色原子配置授权。例如：

```json
{
  "subjects": [{"owner": "VERIFIED_OWNER", "grants": [
    {"resource": "Eigos", "permission": "view_definition"},
    {"resource": "Eigos/object/Place", "permission": "view_objects"},
    {"resource": "Eigos/property/Place/coordinates", "permission": "view_property"}
  ]}],
  "properties": [{"ontology": "Eigos", "type": "Place", "property": "coordinates"}]
}
```

省略 properties 保持当前属性限制；提供该数组则完整替换限制。`access:grant-member` 只授予指定账号当前定义中的业务能力，未来新能力不会自动获得执行授权。受限属性权限需明确配置。对象内容策略、属性策略、组织组和标记规则的配置见 [Ontology 运行服务](docs/guides/ontology-services.md)，实例仍按 owner 隔离。

## Scenario 与日历排程

Agent 可通过 `SchedulablePlan.prepare` 向用户 PA 请求指定范围的完整忙闲信息。缺少日历时原任务返回 `input-required`；PA 用 `respond_to_task`（或 A2A 原任务续接）回传后，Worker 继续相同任务。日历凭据留在 PA。

`create_scenario`、`list_scenarios`、`inspect_scenario`、`discard_scenario` 管理隔离方案；现有查询、Function 与 Action 接受 `scenarioId`。排程 Functions 搜索可行时段、检查资源冲突及活动依赖。Agent 保存候选方案，PA 明确选择后用 `CommitSchedulePlan` 合并；外部日历不会被写入。

这些 MCP 入口及对应 HTTP API 可以用 `ontology` 选择本体，默认 `Eigos`。任务保持其原始发布版本。临时会话、可关联的 Scenario 元数据、通用合并、声明式删除和 Action 补偿见 [Scenario 生命周期](docs/guides/scenario-lifecycle.md)。

完整协议、数据格式、权限升级和当前支持范围见 [Scenario 与 PA 日历排程](docs/guides/scenarios-scheduling.md)。

## 服务与定时出行

Luma 活动、RollingGo 酒店和 Shopify 商品实现各自的 Interface，并通过 `ServiceOffering` 与 `SchedulePlan` 关联。活动出行先比较并合并 Scenario，再由 PA 批准确切的报名或叫车权限。定时检查和外部操作记录保存在同一个 PostgreSQL schema；重启、超时或未知订单结果不会触发重复发单。

Luma 默认沿用原 PA 已连接的 MCP。未来执行需要 PA 持续处理 `list_pa_requests`；只有一个已登录但离线的聊天会话不足以保证无人值守。连接配置、调用契约、价格边界和当前验收范围见 [服务接口与定时出行](docs/guides/service-planning.md)。

## Ontology 运行服务

对象集、发布提案、来源索引、编辑历史、物化、策略和独立进程的入口见 [Ontology 运行服务](docs/guides/ontology-services.md)。构建后用 `npm run start:indexer` 运行来源消费与已配置的 Action 副作用。可用 `QUERY_DATABASE_URL` 配置只读查询节点，`EIGOS_EXTENSION_MODULE` 注册受信任的 Function 版本与副作用处理函数。

[类型系统与资源包](docs/guides/type-system.md) 支持共享属性、版本化值类型、Struct、Interface 继承及可审阅的共享定义导入。[查询与语义检索](docs/guides/search.md) 支持嵌套字段、组合筛选、派生属性和本地多语言向量；`npm run embeddings:warm` 可提前下载固定版本模型。[实体归一](docs/guides/entity-resolution.md)、[跨本体对象复制](docs/guides/ontology-data-migration.md) 和 [Workflow 与规则](docs/guides/automation.md) 保留独立授权与审计。

`/workbench/` 提供同一套服务的浏览器入口，包括建模提案、对象及关系探索、查询、Scenario、排程和规则。宿主提供当前身份的 Bearer token；界面不授予额外业务权限。三维文件与标注是独立的可选应用领域，Ontology 核心运行不依赖它。
