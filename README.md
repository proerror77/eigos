# EIGOS

EIGOS 通过共享 PostgreSQL 本体提供对象集查询、Function 和 Action。Gateway 接收 MCP、A2A 与 HTTP 请求，Worker 中的模型 Agent 根据任务锁定的 Ontology 自行选择查询、来源读取、Function 与 Action。第一条业务链查询滴滴路线估价。

架构、Schema 和实际支持范围见 [Ontology 架构](docs/architecture/ontology.md)。

## 启动

使用 Node.js 22.22.3、PostgreSQL 17 和 npm。

```sh
npm ci
cp .env.example .env
```

在 `.env` 中配置 PostgreSQL 连接与认证。初始化表和发布定义后启动两个进程。

```sh
npm run db:init
npm run ontology:publish
npm run dev:gateway
npm run dev:worker
```

Gateway 和 Worker 使用相同的 `DATABASE_URL`、`EIGOS_PG_SCHEMA`。构建后的入口为 `npm run start:gateway` 和 `npm run start:worker`。Docker 的 `runtime` 与 `worker` target 使用相同代码。

JWT 身份由现有身份提供方验证，owner 由 issuer、tenant 和 subject 计算。`GET /identity` 返回当前 owner 与 scopes。本地开发使用 `.env` 中的随机令牌，owner 为 `local-developer`。

`OAUTH_TENANT_CLAIM` 可配置身份提供方的租户字段。PA 使用任务权限提交询价，Worker 在该任务 owner 的有效来源绑定内执行本体操作。直接调用本体 API 仍使用令牌中的对应权限。来源连接可带 `expiresAt`，运行时按其截止时间检查。

## Worker 模型

Worker 使用已安装的 `@deepseek-ai/dsh` 0.2.1-rc.5（含 `dsh-llm-pi-ai`、`dsh-mcp-client`），通过其 SDK 协议运行一个任务会话。配置 `EIGOS_HARNESS_BIN`、`EIGOS_HARNESS_CREDENTIAL_FILE`、`EIGOS_HARNESS_MODEL` 和 `EIGOS_HARNESS_REASONING_EFFORT`。凭据文件由原云端登录流程续期，格式为 `{ "auth_mode": "chatgpt", "tokens": { "access_token": "..." } }`，须由运行用户拥有且权限为 `0600`。刷新令牌不进入模型会话。

模型只获得当前任务的 Ontology 工具，文件、Shell 等执行工具关闭。运行时从任务锁定的发布版本生成目录，模型自行选择 Interface 查询、Link 导航、来源接入、Function 和 Action；完成时直接返回其所选 Function 的实际结果。结果中的 `execution` 记录模型、发布引用、工具参数和每次调用耗时。

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

Key 文件由运行用户拥有，权限为 `0600`。连接器调用滴滴官方 MCP 的 `maps_textsearch` 与 `taxi_estimate`，价格标记为估计，坐标保留供应商声明。真实读取要求 `sources:Didi:read`。

## Agent 入口

MCP 位于 `/mcp`，提供 `describe_ontology`、`query_ontology`、`evaluate_ontology`、`apply_ontology_action`、`submit_task`、`get_task`、`select_task_places`。

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

`route` 可由 PA 提供，也可只发送自然语言消息，由模型理解需求并选择本体能力。地点有歧义时，原任务返回 `input-required` 和候选对象。向 `/tasks/:id/places` 提交候选的 origin、destination ObjectRef 后继续原任务。执行完成后从 `/tasks/:id` 读取价格及来源。

`POST /ontology/query` 按 Object Type 或 Interface 查询。`POST /ontology/functions` 调用发布的 Function，`POST /ontology/actions` 应用发布的 Action。接口细节和示例见 [架构说明](docs/architecture/ontology.md)。

## 验证

```sh
npm run check
npm run build
npm run ontology:check
npm test
npm run test:e2e:run
```

测试自动创建临时 PostgreSQL 容器，结束后移除。CI 使用独立 PostgreSQL 服务。工程回归使用明确标注的录制 Agent 决策与合成供应商响应，真实模型和真实供应商的端到端计时通过生产入口另行执行。`accepted=true` 要求链路来源为 `live_readonly`。

这一版替换了测试期 SQLite 运行链、历史内核构造链和重复授权投影。旧源码可从 Git 提交 `6eeaf93` 恢复。当前交付的业务领域为滴滴询价，旧的支付、预订、跨 Agent 通信与其他供应商执行流程退出本版运行入口。
