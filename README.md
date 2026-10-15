# EIGOS · 艾戈斯

Consider It Done. — The Execution Network for AI Agents.

EIGOS 的协议接入原型：**远程 MCP 与 A2A 共用认证、任务库和业务逻辑**。两个入口不需要依次经过，客户根据自身能力选一个即可。

## 已实现

- MCP `2026-07-28` 无状态 HTTP 入口；官方 SDK 同时提供 `2025-11-25` 等旧版的无状态兼容路径。
- A2A `1.0` JSON-RPC：公开 Agent Card、提交消息、查询／列举任务、补问后续接、取消。
- 共用 SQLite 持久任务、消息和交付物；任务在服务重启后保留。
- 以受信任的 `issuer + tenant_id + sub` 隔离任务；权限来自验证后的令牌。
- OAuth 资源服务器接入：保护资源发现、401 challenge、JWKS 签名校验、issuer／audience／有效期／scope 检查。
- 本地开发使用自动生成的随机 Bearer 令牌，仅允许绑定 loopback。
- 提交／回复的幂等记录，避免重试产生重复任务；相同 request ID 配不同输入会被拒绝。
- 官方 MCP 和 A2A 客户端的跨协议集成测试、GitHub Actions CI。

当前有两项明确分开的能力：

- **`brief.prepare`**：固定流程整理任务说明，`execution: not_started`，不执行说明中的业务。
- **`agent.execute`（需显式启用）**：通过本地已登录的 Codex 运行真实模型。模型读取目标和完整任务历史，自主提出必要问题，收到答复后生成完整 Markdown 文档／计划。它不具备外部研究、预订、发送或付款工具；生成文档是本阶段实际交付的服务。

本体驱动的业务动作与验收器仍待实现，不能把模型返回 completed 当成任意业务已经可靠履约。方向见 [本体与执行边界](docs/ontology-execution-direction.md)。

2026-10-15 已完成一次 **Grok Bot → A2A → EIGOS 真实执行 Agent** 的提问、回复和交付，未使用 MCP 桥接。见 [真实联调证据](docs/evidence/grok-a2a-2026-10-15/README.md)及[最终交付物](docs/evidence/grok-a2a-2026-10-15/deliverable.md)。这是通过 Grok Bot 已有的电脑执行能力发出 A2A 请求，不是对其原生 A2A 连接器的声明。

## 本地运行

要求 Node.js **22.13+**，建议 Node 22 LTS；该版本的内置 SQLite 可能显示实验性提示。

```sh
npm ci
npm run setup:dev
npm run dev
```

`setup:dev` 创建权限为 `0600` 的 `.env`，不覆盖已有文件，也不会打印密钥。`.env` 和 `data/` 不进入 Git。

| 入口 | 地址 |
| --- | --- |
| 健康检查 | `http://127.0.0.1:3000/health` |
| MCP | `http://127.0.0.1:3000/mcp` |
| A2A Agent Card | `http://127.0.0.1:3000/.well-known/agent-card.json` |
| A2A JSON-RPC | `http://127.0.0.1:3000/a2a` |

在另一个终端运行：

```sh
npm run example
```

示例用 MCP 创建任务，用 A2A 回答问题，再用 MCP 读回同一份交付物。它从 `.env` 读取令牌，不输出令牌。

远程云端 Bot 无法访问你电脑的 `127.0.0.1`。连接此类客户端需要另行部署 HTTPS 服务，配置真实身份提供方，并验证该客户端的协议版本和认证方式。

### 启用真实执行 Agent

本机安装 Codex CLI 并完成 `codex login` 后，在私有 `.env` 中加入 `EIGOS_EXECUTOR=codex`。可以用 `EIGOS_CODEX_BIN` 指定可执行文件。服务重启后，能力目录和 Agent Card 才会公布 `agent.execute`。

通过 A2A 发纯文本新任务时，启用了模型便默认交给执行 Agent；结构化请求显式填写 `service: agent.execute`。MCP 的 `submit_task` 同样需要显式填写这个 service。执行中返回 working，补问返回 input-required，交付物是 Markdown。完整接法见 [接入指南](docs/integration.md#6-真实执行-agent)。

## 两种入口

```mermaid
flowchart TD
    C[客户 Agent] --> M[MCP /mcp]
    C --> A[A2A /a2a]
    M --> P[同一身份与权限检查]
    A --> P
    P --> T[共用 TaskService]
    T --> D[(SQLite 任务与幂等记录)]
    T --> B[brief.prepare：整理说明]
    T --> A2[agent.execute：模型判断与文档交付]
```

MCP 提供六个工具：`list_services`、`submit_task`、`get_task`、`list_tasks`、`reply_to_task`、`cancel_task`。补问采用普通工具结果与后续回复，因此不要求客户端支持 MRTR 或 Tasks 扩展。本版本不宣称实现这些扩展。

A2A 使用官方 SDK 实现 `SendMessage`、`GetTask`、`ListTasks`、`CancelTask`。Agent Card 如实声明不支持流式响应、推送通知及扩展卡；相应方法返回协议错误。

## OAuth 与会员登录

此仓库实现 **OAuth 资源服务器**，可以验证身份提供方签发的访问令牌。它不签发登录令牌，也尚未提供会员注册页面、套餐管理、订阅计费或支付授权。

生产接入时，将 `.env.example` 复制为 `.env`，配置自己的 OIDC/OAuth 身份提供方。账号注册、登录、同意授权、客户端注册、刷新令牌由该提供方负责；EIGOS 只接受符合约定的访问令牌。

令牌必须满足：

- `typ: at+jwt`；签名算法为 RS256、ES256 或 EdDSA。
- `iss`、`aud` 与配置精确匹配；`aud` 是整个 EIGOS 网关的资源标识，两种入口共用。
- 包含 `sub`、`tenant_id`、`client_id`、`scope`、`iat`、`exp`，有效期不超过 15 分钟。
- `services:read` 查看能力；`tasks:read` 读取与列举任务；`tasks:write` 提交、回复和取消自己的任务。

没有身份提供方配置时，默认 JWT 模式会拒绝启动。本地开发模式不会发布虚构的 OAuth 登录端点。

完整的请求格式、身份提供方配置和部署说明见 [接入指南](docs/integration.md)。

## 验证

```sh
npm run check
npm test
npm run build
```

测试覆盖真实 loopback HTTP 请求、官方 SDK 互操作、跨入口任务续接、跨组织／跨用户隔离、权限不足、伪造／过期／错误用途令牌、幂等冲突、取消、重启持久化和来源检查。测试使用本地签发的测试访问令牌，**不代表第三方会员 OAuth 登录、Grok Bot／MUSE 兼容性或生产部署已验证**。

## 当前运行边界

- MCP 协议入口无状态，业务任务持久化；当前存储面向单实例、本地持久磁盘。多副本／无持久盘部署需要共享数据库与相应运行时，不能直接复制 SQLite 文件启动多个实例。
- 真实模型执行器是单进程、每次调用有超时的本地 Codex 子进程；最多同时运行两个任务，每个任务最多六次模型调用。尚无实际商业执行连接器、Payment、Webhook 推送或自动收费。
- 服务重启会将中断的 working 任务标记 failed，不自动重放可能已经计费的模型调用。取消会终止子进程，过期结果不能覆盖取消状态。
- 自包含 JWT 的撤销存在令牌有效期窗口；需要即时撤销时，增加身份提供方 introspection 或服务端撤销记录后再上线该能力。
- Dockerfile 仍只包含网关；使用 Codex 执行器时还需宿主安装与登录，镜像没有打包个人凭据或 Codex CLI。

## 项目资料

- [品牌说明与 Logo 评审方向](docs/brand-brief.md)：EIGOS 为优先候选，商业使用与商标状态待核查。
- [协议研究](docs/agent-protocol-research-2026-10-14.md)：MCP、A2A、ACP 与支付协议的职责边界。
- [项目协作规则](AGENTS.md)。
