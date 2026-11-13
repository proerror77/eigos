# EIGOS

EIGOS 通过共享 PostgreSQL 本体提供对象集查询、Function 和 Action。Gateway 接收 MCP、A2A 与 HTTP 请求，Worker 执行来源读取。第一条业务链查询滴滴路线估价。

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

`route` 可由 PA 提供。明确包含城市、起点和终点的中文消息也可解析。地点有歧义时，原任务返回 `input-required` 和候选对象。向 `/tasks/:id/places` 提交候选的 origin、destination ObjectRef 后继续原任务。执行完成后从 `/tasks/:id` 读取价格及来源。

`POST /ontology/query` 按 Object Type 或 Interface 查询。`POST /ontology/functions` 调用发布的 Function，`POST /ontology/actions` 应用发布的 Action。接口细节和示例见 [架构说明](docs/architecture/ontology.md)。

## 验证

```sh
npm run check
npm run build
npm run ontology:check
npm test
npm run test:e2e:run
```

测试自动创建临时 PostgreSQL 容器，结束后移除。CI 使用独立 PostgreSQL 服务。工程回归通过官方 MCP SDK 处理合成响应，真实供应商验收使用私有账号单独执行。`accepted=true` 要求链路来源为 `live_readonly`。

这一版替换了测试期 SQLite 运行链、历史内核构造链和重复授权投影。旧源码可从 Git 提交 `6eeaf93` 恢复。当前交付的业务领域为滴滴询价，旧的支付、预订、跨 Agent 通信与其他供应商执行流程退出本版运行入口。
