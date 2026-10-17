# MCP 与 A2A 接入指南

生活服务发现与原始需求转交使用可选 `life.request`：返回 submitted 任务和明确未执行的登记回执，可查询、补充或取消。Grok 按意图触发、本机常驻连接与验收边界见 [生活需求转交](life-request-intake.md)。

实现版本：0.1.0。运行架构已拆为 Gateway／Worker，启动、队列和迁移说明见 [架构说明](gateway-worker.md)。两个入口共用任务与权限，没有“先 MCP 登录，再转 A2A”的必要步骤。客户端必须具备实际协议和认证支持；提示词不能自动增加网络连接能力。

启用 `EIGOS_COORDINATOR=codex` 后使用新 Ontology + LLM 后端：MCP/A2A 默认提交到 eigos.delegate，只发现该服务及可选的需求登记；不接受旧专用服务直调。下文 brief.prepare / agent.execute / 跑腿的直调示例属于独立原型模式。新后端字段及报价读回见本文末尾和 [后端说明](registered-capabilities.md)。

## 1. 身份与连接

### 本地开发

运行 `npm run setup:dev` 和 `npm run dev`。客户端在请求头添加 `Authorization: Bearer <.env 中的 EIGOS_DEV_TOKEN>`。不要把令牌放进提示词、URL、Agent Card 或 Git。

本地开发只代表同一开发用户。测试套件另外验证了多个 JWT 用户／组织的权限隔离。禁止通过隧道公开开发令牌端点；公开服务必须使用下面的 JWT 配置。

### 真实 OAuth 接入

当前网关是 OAuth 资源服务器，不是授权服务器。绑定自己的 OIDC 身份提供方时：

1. 注册 EIGOS API 资源，资源标识配置为 `OAUTH_AUDIENCE`（例如 `https://api.example.com`）。它覆盖 `/mcp` 与 `/a2a`。
2. 定义 `services:read`、`tasks:read`、`tasks:write`；按用户和客户端授权这些 scope。
3. 使用授权码＋PKCE，并按目标客户端实际支持的方式配置回调 URI 和客户端注册。CIMD／预注册／旧客户端注册方式取决于身份提供方与客户端，不由这个网关自动提供。
4. 配置令牌映射：`sub` 是用户／服务身份，租户字段默认 `tenant_id`（Auth0 使用由 `OAUTH_TENANT_CLAIM` 配置的完整 namespaced claim 键），`client_id` 是客户端 ID，`scope` 是空格分隔字符串。租户字段来自经验证的令牌；客户端提交的任务字段不能覆盖这些身份。
5. 令牌使用 `typ: at+jwt`，具有正确的 `iss`／`aud`、`iat`／`exp`，最长 900 秒；支持 RS256、ES256、EdDSA。只提供普通 `JWT` 或 opaque access token 的提供方，需要先适配 verifier，不能直接降低检查或把 ID token 当 access token。
6. 配置 HTTPS 的 `PUBLIC_URL`、`OAUTH_ISSUER`、`OAUTH_JWKS_URL`、`OAUTH_AUDIENCE`，运行已构建服务。签名公钥只从管理员配置的 JWKS 地址加载，不使用请求中声明的密钥地址。
7. 在同一提供方注册会员网页登录客户端，配置 `OIDC_CLIENT_ID` 及相应的私有 `OIDC_CLIENT_SECRET`；精确回调地址为 `${PUBLIC_URL}/members/callback`。会员先在 `/members` 登录并开通，再由 Personal Agent 走自己的 OAuth 客户端授权。详见 [会员接入](membership.md)。
8. 在实际提供方和客户端验证登录、同意、刷新、过期和撤销；本仓库使用签名令牌的本地身份提供方测试不代替这一步。

提供方应在 `${OAUTH_ISSUER}/.well-known/openid-configuration` 暴露其真实 OIDC 元数据，A2A Agent Card 引用此地址。MCP 授权服务器发现还需要符合 MCP 授权规范；不满足时应配置适配或选用兼容提供方。

发现端点：

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource/a2a`

三者描述同一资源服务器；未认证的受保护请求返回 401 和包含资源元数据位置的 `WWW-Authenticate`。有效 JWT 仍需关联已开通会员；会员未开通、已停用或助手连接已撤销时返回 403，并提供 `membership_url`。会员中心已实现本人资料、连接停用／恢复和退出登录；本地停用即时生效。上游 JWT 撤销仍存在最长 15 分钟窗口，密钥轮换走 JWKS；组织成员管理、套餐和计费尚未实现。

## 2. MCP

接入地址：`https://你的域名/mcp`。传输：Streamable HTTP。SDK 优先支持 `2026-07-28`，同时启用官方无状态旧版 fallback；不启用 HTTP 会话 ID。

工具参数示例：

```json
{
  "name": "submit_task",
  "arguments": {
    "service": "brief.prepare",
    "goal": "整理供应商比较任务的说明",
    "requestId": "client-generated-unique-id"
  }
}
```

缺少 `deliverable` 时，返回 `state: input-required`、`question` 和 `id`。客户端自行回答已有且可分享的信息，或询问用户，然后调用：

```json
{
  "name": "reply_to_task",
  "arguments": {
    "taskId": "上一步返回的 UUID",
    "answer": "记录交付要求：三家供应商、价格、容量和资料来源的比较表",
    "requestId": "another-client-generated-unique-id"
  }
}
```

完成结果中的 artifact 是任务说明：`goal`、`deliverable`、`execution: not_started`。`completed` 只表示整理说明完成，底层采购等目标尚未执行。

`get_task` 和 `cancel_task` 接收 `{ "taskId": "UUID" }`。`list_tasks` 接收 `{ "limit": 50, "offset": 0 }`，limit 上限 100。

MCP 工具返回可读文本与 `structuredContent.result`；业务错误标记 `isError: true`。本实现不要求 MRTR、elicitation 或 Tasks 扩展，任务编号通过显式参数传递。

旧版调用先执行客户端正常的 `initialize` 流程；服务端仍不创建连接会话。不同厂商支持的 MCP 版本和 OAuth 能力需要实际验证。

## 3. A2A

发现地址：`https://你的域名/.well-known/agent-card.json`。卡片可公开读取，不含会员数据或密钥。

调用地址：`https://你的域名/a2a`。设置 `A2A-Version: 1.0`、`Content-Type: application/json` 和 Bearer 授权头。本实现不启用 A2A 0.3 兼容；方法名与消息格式按 1.0。

提交任务：

```json
{
  "jsonrpc": "2.0",
  "id": "rpc-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "message-1",
      "role": "ROLE_USER",
      "parts": [{ "text": "整理供应商比较任务的说明" }]
    }
  }
}
```

任务在 `result.task` 中。缺少交付要求时状态为 `TASK_STATE_INPUT_REQUIRED`。继续同一任务：

```json
{
  "jsonrpc": "2.0",
  "id": "rpc-2",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "message-2",
      "taskId": "上一步返回的 UUID",
      "role": "ROLE_USER",
      "parts": [{ "text": "记录交付要求：三家供应商比较表" }]
    }
  }
}
```

也支持单个结构化 data part：新任务用 `{ "data": { "goal": "...", "deliverable": "...", "service": "brief.prepare" } }`，回复用 `{ "data": { "answer": "..." } }`。不接受文件 URL、任意下游操作、隐式购买或伪装成 Agent 的入站消息。

其他操作：

| 方法 | params |
| --- | --- |
| `GetTask` | `{ "id": "UUID", "historyLength": 0 }` |
| `ListTasks` | `{ "pageSize": 20, "includeArtifacts": true }` |
| `CancelTask` | `{ "id": "UUID" }` |

`ListTasks` 支持 contextId、status、statusTimestampAfter、historyLength 和 pageToken。下一页使用返回的 nextPageToken，保持原筛选条件；当前偏移分页不保证并发插入时的快照一致性。

contextId 由服务器生成；新任务可以复用当前用户拥有的已有 context。继续任务时若同时传 taskId 和 contextId，两者必须匹配。未知与其他用户的任务统一按不存在处理。

暂不支持 Streaming、Push Notifications、Extended Agent Card。卡片不会宣称支持；推送配置会在创建任务前拒绝，服务端不会访问用户提供的回调 URL。

## 4. 重试、隔离与存储

- MCP `requestId`、A2A `messageId` 用作同一个动作的幂等键。重试必须保留相同键和相同内容；改变内容请使用新键。
- 幂等重试返回原动作的响应快照；要看最新状态，用 `get_task`／`GetTask`。
- 任务与幂等收据在同一个 SQLite 事务中保存，不依赖某台 HTTP 进程的会话。
- 同一 issuer、组织、用户可以从另一个获授权客户端继续任务。不同用户即使在同一组织，也不能默认读取彼此任务。
- `tasks:write` 可以返回自己提交／修改任务的结果；独立查询需要 `tasks:read`。生产系统若需管理员共享、团队 ACL 或客户端级隔离，应明确增加授权模型。
- `brief.prepare` 是同步、无外部副作用的说明生成。模型与跑腿操作由 Worker 通过 SQLite 持久任务、原子领取与租约执行；过期的已开始调用标记失败，不自动重放。业务连接器仍需自身防重与结果查证，SQLite 收据不构成外部支付的 exactly-once 保证。

## 5. 部署准备与未完成条件

仓库提供 Dockerfile，但未自动部署。可使用 `docker build -t eigos .` 构建；运行时注入真实 OAuth 配置，并将 `/app/data` 绑定持久卷。镜像使用非 root 用户和 JWT 模式，默认启动 Gateway 并拒绝开发令牌模式；Worker 使用 `node dist/apps/worker/main.js` 独立启动并挂载同一个本地持久卷。

当前部署模型是同机 Gateway／Worker 分进程＋共享本地持久磁盘＋前置 HTTPS。公网入口还需按实际平台配置请求限流、日志／告警、备份和密钥管理。`PUBLIC_URL` 决定 Agent Card 与发现信息，Host 校验只允许其主机名；反向代理需保留正确 Host。

浏览器跨域调用仅允许 `PUBLIC_URL` 及 `ALLOWED_ORIGINS` 中的精确 origin。命令行／服务端 Agent 可以不发送 Origin，但仍必须有访问令牌。

尚未完成：实际身份提供方的浏览器登录联调、MUSE 实测、云端部署、通用业务连接器、本体驱动验收与支付。Grok Bot 的单次验证证据另行记录，不据此宣称所有客户端或全部功能都已兼容。

## 6. 真实执行 Agent

`EIGOS_EXECUTOR=codex` 启用本地已登录的 Codex CLI。其他设置：`EIGOS_CODEX_BIN`（默认 codex）、`EIGOS_EXECUTOR_TIMEOUT_MS`（默认 120000，最多 300000）。默认 disabled，未启用时提交 agent.execute 会报错，绝不回退到 brief.prepare 或固定回复。

执行器通过 stdin 接收本任务内容，使用结构化输出模式，工具、插件、MCP 连接、浏览器与多 Agent 功能关闭，工作目录是临时目录，结束后清除。模型账户登录由 Worker 主机的 Codex 管理；网关 Bearer 凭据不传进子进程。当前运行时专用于基于输入资料的文档与计划生成，不是为任意访客开放个人 Codex 的文件和工具访问。

提交示例：

```json
{
  "jsonrpc": "2.0", "id": "request-1", "method": "SendMessage",
  "params": {
    "configuration": { "returnImmediately": true },
    "message": {
      "messageId": "unique-message-1", "role": "ROLE_USER",
      "parts": [{ "data": { "service": "agent.execute", "goal": "请帮我设计工作坊，先确认必要条件。" } }]
    }
  }
}
```

返回 TASK_STATE_WORKING 后查询 GetTask。模型返回 TASK_STATE_INPUT_REQUIRED 时，将问题交给实际请求方，用同一 taskId 和新的 messageId 回复。没有 returnImmediately 时，SendMessage 等待模型达到暂停／终态，仍受执行超时约束；长任务建议查询模式。

每次模型执行将有限的证据写入任务 metadata.runs：调用 ID、运行时、开始／结束时间、模型响应摘要哈希，以及 CLI 返回的 threadId 和 token usage（如果提供）。不保存隐式推理。最终 Artifact 的 text/markdown 部分包含完整交付物。

旧文档服务有两类完成必须区分：brief.prepare 的任务说明完成，与 agent.execute 的文档生成完成。二者都不代表外部购买、发布或研究已发生。后续本体动作和确定性验收器应建立自己的完成证据。

运行限制：同一数据库最多同时领取两个执行任务；文档任务最多六次模型往返。Gateway 不执行模型，重启不影响任务。Worker 领取租约默认 15 秒，取消由 Worker 检测并终止调用；结果写回校验令牌、revision、状态和有效期。未领取任务可在重启后继续执行；已开始的调用中断后标记失败并要求查证，不自动重放。当前仅支持同机共享本地 SQLite，详见 [故障与迁移说明](gateway-worker.md)。

可设置 `EIGOS_AUDIT_PATH=./data/http-audit.jsonl` 记录协议路径、方法、任务／消息编号、时间与 HTTP 状态。不记录 Authorization、用户消息正文或任意模型推理。

## Agent 自助登记与续期

客户 Agent 可通过公开的 `/.well-known/eigos-agent-registration` 自助登记，并用 Auth0 Device Flow 获得用户授权。非会员申请、邀请等待、Token 轮换及按安装实例停用见 [Agent 自助接入](agent-onboarding.md)。MCP 资源元数据与 A2A Card 会指向该发现入口，两种协议继续共用会员和任务权限。

## 官方依据

- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP 授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)
- [A2A 1.0 规范](https://a2a-protocol.org/v1.0.0/specification/)

## 7. 美团跑腿只读接入

`meituan.paotui.read` 可通过 MCP submit_task 或 A2A SendMessage 的 data part 调用。仅本地开发模式可启用，goal 为严格的 JSON 查询（含仅报价的 preview），复用任务所有权、幂等和取消逻辑。完整配置、请求与验证见 [跑腿接入说明](meituan-paotui-integration.md)。没有真实下单或支付能力。

订单准备服务 `meituan.paotui.order` 与两条协议共用任务入口和所有权，动作包括 prepare_order、confirm_order、payment_links、order_state。当前真实下单开关关闭，见 [确认、防重和支付链接流程](meituan-paotui-orders.md)。

## CSV 审计模拟服务

非生产 loopback 环境显式启用 `EIGOS_CSV_PILOT=true` 后，两种入口会注册 `data.quality.audit.simulated`。它只使用合成数据和本地模拟付款，不代表支付宝接入。输入、结构化确认、查询及验证边界见 [CSV 试点说明](csv-audit-pilot.md)。现有 `brief.prepare` 和其他服务保持各自行为。

CSV 试点也支持 `fileName` 替代 `datasetId`，仅从显式配置的 `EIGOS_CSV_INPUT_DIR` 读取指定文件；限本地开发身份。文件快照与报价/报告摘要绑定，原始内容不发给模型。格式、边界和真实 Agent 文件演示见 [CSV 文件输入](csv-audit-pilot.md#真实-csv-文件输入付款仍为模拟)。

## Ontology/OAG 委托入口

开启本地 `EIGOS_COORDINATOR=codex` 后，MCP/A2A 默认进入 `ontology-execution-v3`：LLM 解释需求 → Resolver 取得事实 → LLM 短计划 → 程序许可/约束检查 → Worker 动作/原键对账 → 独立验收。配置可启用文档、全量 CSV、美团只读和麦当劳报价比较；SUBMITTED、INPUT_REQUIRED、AUTH_REQUIRED、REJECTED 等协议状态保留。`service`、可选 requirements/executionEnvironment 是 EIGOS 业务字段，非 A2A 标准必填字段。

新增能力分别登记 ServiceCapability、ProviderBinding、适配器与可选 DiscoverySource。metadata.delegation 包含 request/successCriteria/resolution/plan/actions/businessFacts/authorizationBudget/outcome，报价在 plan.quote。现有 Agent Python 客户端的原委托/模拟确认参数保留；旧执行计划不兼容或迁移。

新增 MCP 工具：reconcile_task 查询原操作，revoke_task_authorization 撤销未来派发许可，request_remediation（有对应适配器时公布）建立关联售后 Task。HTTP 同源入口为 `/tasks/{id}/reconcile`、`/revoke-authorization`、`/aftersales`，均要求任务身份和 tasks:write。售后也可用 A2A data `{service:"eigos.aftersales",originalTaskId,action:"refund"或"cancel",reason}`，messageId 仍为幂等键。

真实/default-environment 请求不会检索沙箱履约。工程沙箱必须显式 executionEnvironment=sandbox、loopback 配置和准确许可。批准格式为 action=approve_plan、requestId、planDigest、allowedEffects、maxAmount（minor/currency）、payeeIds、expiresAt、environment=sandbox；`confirm_simulated_payment` 仍仅用于本地 CSV。没有任何许可可开启现实付款；聊天“yes”不是授权。更多约束见 [后端说明](registered-capabilities.md)。
