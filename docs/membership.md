# 会员资料库与 OAuth 接入

会员先通过身份提供方登录，再完成 EIGOS 会员开通；Personal Agent 取得针对 EIGOS 资源的 OAuth 访问令牌后才可调用。首版按用户决定采用通用 OIDC 接入与自助开通，没有创建外部登录服务、真实账号或付费资源。

## 身份、会员与业务授权

1. **身份提供方**负责账号注册、验证身份、OAuth 客户端注册、用户同意授权，以及访问／刷新令牌签发。EIGOS 不自行实现密码登录或授权服务器。
2. **EIGOS 会员中心**位于 `/members`：经 OIDC 登录，填写显示名称、语言和时区，明确同意保存资料及接受授权范围内的助手调用后开通。已验证邮箱只取自身份提供方；普通资料更新不能改变身份、租户或会员状态。
3. **Personal Agent**使用自己在提供方注册的 OAuth 客户端取得 EIGOS 访问令牌。会员网页登录 Cookie、ID Token 和其他服务的访问令牌都不能用于 MCP/A2A。
4. **业务操作授权**继续使用现有任务与供应商流程。会员开通和 `tasks:write` 不自动授权购买、付款、发送或发布。

首次正确顺序为：会员网页登录 → 开通会员 → Personal Agent 发起其 OAuth 授权 → 在 MCP／A2A 调用 → 查询同一任务的交付物。未开通会员的有效令牌不会自动创建一个可调用的会员。

## 提供方配置

Gateway 的 `.env` 示例：

```dotenv
EIGOS_AUTH_MODE=jwt
PUBLIC_URL=https://your-eigos.example
OAUTH_ISSUER=https://your-identity.example
OAUTH_JWKS_URL=https://your-identity.example/jwks
OAUTH_AUDIENCE=https://your-eigos.example
OIDC_CLIENT_ID=registered-member-portal-client
OIDC_CLIENT_SECRET=replace-with-private-secret
MEMBERSHIP_DATABASE_PATH=./data/members.sqlite
EIGOS_MEMBERSHIP_APPROVAL=self-service
```

在提供方精确注册 `https://your-eigos.example/members/callback`。会员网页登录应用与 Personal Agent 是独立 OAuth 客户端：不要共享网页登录客户端密钥给个人助手。当前网页登录客户端支持 `client_secret_post`；提供方明确注册为公共客户端时，可省略 secret，使用 PKCE 和 `none` 客户端认证。实际提供方仍需联调。

会员网页登录请求 `openid profile email`，ID Token 必须携带经签名验证的 `iss`、`sub`、`tenant_id`，其中 `tenant_id` 必须与同一会员 Agent 访问令牌一致；只有 `email_verified=true` 时才保存邮箱。不按邮箱合并账号，不从请求参数、表单或 Agent 消息获取身份和租户。提供方应使用本客户端约定的默认 RS256 ID Token 签名算法。

Agent 的访问令牌仍遵守 [接入指南](integration.md)：正确的 EIGOS `aud`，`typ: at+jwt`，受支持签名算法，`sub`、`tenant_id`、`client_id`、`scope`、`iat`、`exp`，有效期不超过 15 分钟。只提供 opaque token、普通 ID Token 或不同 claim 结构的提供方需要明确适配，不能降低验证来凑通。

会员登录回调使用 `openid-client` 的 Authorization Code + S256 PKCE，并校验 state、nonce、issuer、audience、过期和签名。待完成登录保存在 Gateway 内存中，五分钟过期，一次消费；Gateway 重启后需重新开始登录。浏览器会话最长八小时，只有随机会话标识的 SHA-256 入库，使用 HttpOnly／Secure／SameSite Cookie，资料与连接修改须同源且通过 CSRF 验证。所有配置 URL 必须使用 HTTPS；仅测试代码显式注入的本地身份提供方允许 HTTP。

不保存上游 Access Token、Refresh Token、ID Token 或密码；会员资料不注入模型提示词。退出会员中心只撤销本地网页登录会话，身份提供方 SSO 会话与 Agent OAuth 授权需在对应渠道管理。

## 资料与调用检查

`packages/members/store.ts` 使用独立 SQLite 库，默认 `DATABASE_PATH + .members`，新建文件权限 `0600`。身份唯一键为 `issuer + tenant + subject`，任务所有权规则不变。库中保存基础会员资料、开通同意时间、状态、浏览器会话哈希，以及可信访问令牌中的客户端 ID／最近观察到的 scopes／最近访问时间。

JWT 模式下，`/mcp`、`/a2a`、`/tasks/:taskId/authorize` 都检查：

| 检查结果 | HTTP / error |
| --- | --- |
| 缺少或无效访问令牌 | `401 invalid_token`，保留 OAuth 资源发现 challenge |
| 有效令牌但尚无会员资料 | `403 membership_required` |
| 会员待开通／审核或已停用 | `403 membership_inactive` |
| 会员已停用该 OAuth 客户端连接 | `403 connection_revoked` |
| 会员可用，但缺少请求 scope | 原有 scope 拒绝行为 |

会员状态错误返回 `membership_url`，引导本人登录会员中心处理。连接列表显示已通过验证并实际访问过的客户端，不是身份提供方所有历史授权的同步目录。停用会即时拒绝该客户端的新请求，包括仍未过期的旧令牌；恢复连接是本人在会员中心的显式操作。它不取消已接受的任务或已发生的供应商操作，不把停用当成退款。

loopback 开发令牌继续保留为本地测试路径，不能证明真实会员 OAuth 接入，也不能在生产启用。公开 Agent Card、健康检查和 OAuth 资源元数据不要求会员登录。

升级后，已有 JWT 用户也需用同一身份完成会员开通；历史任务不会被用来隐式开通会员，也不会按邮箱合并身份。现有任务所有权保持原规则。

## 管理与人工审核选项

默认 `self-service`：本人登录并提交明确同意后即开通。若改为 `manual`，申请进入 pending，只有管理员本地操作能批准；表单不能自提权。

```sh
npm run build
npm run members -- list
npm run members -- approve <member-id>
npm run members -- suspend <member-id>
```

命令从私有 `.env` 读取会员库路径，不需要 Worker 或网页登录密钥。只有已提交会员申请的账号才能批准。没有开放可被普通会员调用的管理 API。

## 验证与当前边界

`tests/members.test.ts` 使用本地受控身份提供方、真实签名 ID Token、PKCE 验证和官方 MCP SDK，覆盖会员开通、跨 MCP/A2A 续接、同意缺失、人工审核、停用及恢复、重启持久化、Cookie 与 API 凭据隔离、CSRF、越权、HTML 转义、退出、错误 state／nonce／issuer／audience／签名。既有两协议、权限与 Worker 回归继续运行。

2026-10-16：类型检查、81 项全量测试（新增 11 项会员测试）、构建及差异检查通过；构建后的管理命令已在临时库验证 list／approve／suspend。Chrome 检查了开通表单和资料／连接管理页面；页面使用明确标注的示例资料，未连接真实账号。

这证明本地实现；还没有选定外部身份提供方，没有真实会员注册／OAuth 浏览器联调或公网部署。上线前需在选定提供方登记网页登录与 Agent 客户端、完成 claim/scope 映射，并验证真实用户的登录、同意、刷新、撤销及账号恢复。组织邀请／角色、套餐、计费、支付和复杂偏好资料不属于本次实现。

官方依据：[openid-client](https://github.com/panva/openid-client)、[OIDC 授权码示例](https://github.com/panva/openid-client/blob/main/examples/oidc.ts)、[MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[OAuth Security BCP / RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)。
