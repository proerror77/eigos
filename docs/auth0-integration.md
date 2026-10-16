# Auth0 身份提供方与真实会员联调

选择日期：2026-10-16。采用 Auth0 托管登录与授权服务；EIGOS 继续管理会员资料、开通状态、连接停用及任务权限，不迁移会员库，也不自行搭建密码或 OAuth 授权服务器。

## 选择依据

当前需求是用户注册／登录后，由 Personal Agent 代表用户取得针对 EIGOS 的访问令牌。Auth0 已有托管 OIDC 登录、[MCP 授权支持](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/)及 [RFC 9068 access-token profile](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)，与现有 `at+jwt`、`client_id`、RS256 和资源 audience 校验契约匹配。

我的阶段性判断是：新项目优先减少身份系统的部署与维护工作，用 Auth0 验证真实用户链路。[Keycloak](https://www.keycloak.org/securing-apps/mcp-authz-server)保留为后续明确需要自托管时的选择，其部署、邮件、升级和恢复需要项目自行维护。此选择不把公开产品声明当成 EIGOS 已联调成功。

初期使用 [Free 开发计划](https://auth0.com/pricing)，不购买域名、不配置需要信用卡验证的 Auth0 自定义域名，不启用付费组织／企业 SSO、Token Vault 或 Agent as Principal。本轮保持 user `sub` 为会员身份；Agent 通过独立 OAuth 客户端代表用户调用。实际账户权益仍以控制台为准。

## 资源与客户端

| 对象 | 配置与职责 |
| --- | --- |
| EIGOS API | Identifier 为 Gateway 的 HTTPS origin；RS256；`rfc9068_profile`；访问令牌最长 900 秒；服务／任务 scope 与 `members:write`；允许离线续期并保留用户 consent |
| Member Portal | Regular Web Application；精确 `/members/callback`；授权码＋PKCE；`client_secret_post`；仅服务端持有 secret |
| Personal Agent | Native public client；独立 client ID；精确 `http://127.0.0.1:3211/callback`；授权码＋S256 PKCE；无 client secret |
| Agent connector | Native public client；Device Code＋Refresh Token；轮换刷新令牌，绝对期限 30 天、空闲期限 7 天；EIGOS 为每个安装实例保存独立登记 |
| 登录连接 | 两个客户端启用同一 Auth0 database connection，使用同一会员账号；保留连接上原有其他客户端 |
| Post Login Action | 仅对本 Portal 或 EIGOS API 生效；ID／Access Token 写入相同、管理员控制的 namespaced tenant claim；不读取可由用户修改的 metadata 作为租户 |

这三个预登记软件客户端由 EIGOS 自己管理，明确设置 `is_first_party=true`。授权码参考示例包含 `prompt=consent`，connector 使用 Device Flow；API 的 `skip_consent_for_verifiable_first_party_clients=false` 继续要求用户同意，刷新时使用已有委托。软件归属不代替会员授权。外部开发者的 third-party client 需要另外配置 domain connection 和 API client grant，不由本轮参考客户端自动开放。

Auth0 的[自定义 claim 约束](https://auth0.com/docs/secure/tokens/json-web-tokens/create-custom-claims)要求明确处理命名空间。EIGOS 配置 `OAUTH_TENANT_CLAIM=<resource>/claims/tenant_id`，首个个人会员空间取值为 `personal`；`issuer + tenant + sub` 继续共同隔离数据，不按邮箱合并账号。缺少指定 claim、错误 audience、错误用途／签名或超长寿命都仍拒绝。

## 配置与运行

先在 Auth0 控制台由账号持有人完成登录／注册，选择 EIGOS 专用开发租户。官方 CLI 安装和用户登录见 [Auth0 CLI](https://auth0.github.io/auth0-cli/)。CLI 管理授权用于创建本项目 API、客户端、连接及 Action；它与会员本人对 Agent 的服务授权是两个不同步骤。

```sh
npm run build
npm run setup:auth0 -- --public-url https://your-private-gateway-origin
```

默认只在忽略目录 `data/auth0-live/` 生成可检查的 `plan.json`，不调用 Auth0 API、不创建云端对象。CLI 登录后，显式指定已授权的开发租户：

```sh
auth0 login
npm run setup:auth0 -- --public-url https://your-private-gateway-origin --tenant your-dev-tenant.auth0.com --apply
```

脚本使用官方 CLI 的 Management API，复用由 EIGOS metadata 标记的资源和客户端，保存阶段 ID；不使用密码 grant 或 client-credentials grant 代替用户授权。已有同标识的非本项目对象、不同回调契约或重复对象会停止。发布 Action 时保留原有 trigger bindings。默认选择 `Username-Password-Authentication` 或唯一 database connection；多个自定义连接时用 `--connection <name>` 明确选择。

Auth0 已[停止在 connection 对象上管理 `enabled_clients`](https://auth0.com/docs/troubleshoot/product-lifecycle/deprecations-and-migrations)。脚本改用 [`connections/{id}/clients`](https://auth0.com/docs/api/management/v2/connections/patch-clients)，按 checkpoint 分页读取，只启用缺少的本项目客户端，再回读确认；不覆盖其他应用的连接。失败响应只写入私有 `setup-error.json`，用于判断原操作结果后恢复。

生成 `gateway.env`、`agent.env` 和恢复用 `state.json`，目录权限 0700、文件权限 0600。Portal secret 只写 Gateway 私有配置，不显示在命令输出、提示词或 Git 中。脚本不修改项目现有 `.env`。

Agent 自助接入另外生成 `connector.env`，Gateway 配置 `OIDC_AGENT_CLIENT_ID`。它启用设备授权、`offline_access`、`members:write` 和轮换续期；Post Login Action 的 `agent_enrollment` 签名 claim 限制新登记必须来自初次设备授权，刷新 grant 只能接续原登记。Node 适配器、邀请模式和公开发现入口见 [Agent 自助接入](agent-onboarding.md)。

开发联调可以使用 Mac 已有的 Tailscale Serve 私有 HTTPS。采用单独端口，例如 `8443` → loopback `3210`；保留已有 `443` 服务。Gateway 必须是 JWT 模式，认证与 HTTPS 校验均保持启用。Serve 的网络身份头不会代替 OAuth 身份。

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3210
node --env-file=data/auth0-live/gateway.env scripts/run-local.mjs --built
```

用户在该 HTTPS origin 的 `/members` 登录、填写资料并明确同意开通。使用同一 Auth0 会员账号完成下一步 Agent OAuth 授权：

```sh
npm run verify:member-agent
```

工具将授权 URL 写入私有 `agent-login.json`，等待用户在浏览器确认。回调完成后验证真实提供方的 ID／Access Token 与已开通会员绑定，再启动实际 Codex Personal Agent；它自行发现服务、创建唯一 `agent.execute` 任务并读取交付物。EIGOS Worker 再调用独立的真实模型生成文档。工具不会替模型预先提交任务，也不会以模拟令牌回退。

本轮受控客户端使用 Auth0 的 `audience` 授权参数。要支持不同外部 MCP 客户端的自动 OAuth，仍需按其实际行为核验 Auth0 的 Resource Parameter Compatibility Profile、客户端登记和 `resource` 参数；不能把一个预登记客户端成功推广为所有客户端兼容。

## 验收与证据

只有以下全部满足，才将“真实会员登录到 Agent 调用”标为完成：

1. 真实 Auth0 会员登录成功，EIGOS 自助开通记录持久化，用户／租户与令牌一致。
2. Personal Agent 经过独立 OAuth consent，获得绑定 EIGOS audience、指定 scope、有效寿命的签名访问令牌。
3. 两个实际模型运行时完成一次文档任务；客户端自己读取 completed 和交付物。
4. MCP 客户端、A2A 查询与 SQLite 独立读取的任务和 Markdown 字节一致。
5. 已归档经过脱密检查的任务编号、模型运行收据及交付物摘要；未归档任何 token、secret、密码或隐式推理。

未授权、未开通、停用连接、错 tenant／audience／scope、回调错误与重试行为继续由本地回归覆盖。真实工具保留失败轮的事件和请求标记；失败或超时先查原任务，不自动重新创建任务。

## 当前状态

2026-10-16 已完成 Auth0 账号首次开户、Japan 开发租户创建和官方 CLI 管理授权。EIGOS API、两个自有 OAuth 客户端、共享会员登录连接及 Post Login Action 已配置，并通过 Management API 回读。初次配置中未启用的第三方客户端草案，在确认本租户没有会员用户、草案没有 API grant 后移除；继续使用正确归属的参考客户端。

独立 Gateway／Worker 运行在本机，私有 HTTPS 使用单独 `8443` → loopback `3210`，原 `443` 服务保留。正常 TLS 校验、health、OAuth 资源发现和未授权 MCP `401` 已通过；会员门户已成功跳转到真实 Auth0 登录页。已检查的无凭据回执见 [提供方配置](evidence/auth0-member-2026-10-16/provider-configuration.json)和 [Gateway 就绪检查](evidence/auth0-member-2026-10-16/gateway-readiness.json)。

本地 88 项测试、类型检查、构建和差异空白检查通过，覆盖新版连接接口的分页、增量启用、失败回读、重复游标，以及会员表单的 Origin／Referrer-Policy 和校验重试。真实 Chrome 提交发现的 `Origin: null` 问题已修复，来源校验与 CSRF 防护保持启用。

**真实会员到 Agent 链路已在私有 HTTPS 联调环境验收通过**：2026-10-16 16:10（Asia/Shanghai），真实会员自助开通后完成独立 Agent OAuth consent。Personal Agent 自行发现服务、提交唯一 `agent.execute` 任务并读取完成交付物；独立 Worker 模型生成会议议程。任务 `93a908f6-7713-40c5-95db-00c670cadf74` 的 MCP、A2A 和 SQLite 回读字节一致，详细证据见 [本次验收](evidence/auth0-member-2026-10-16/README.md)。

本机凭据、会员库和原始截图位于忽略目录 `data/auth0-live/`，不纳入 Git。当前结论限于本机私有 HTTPS、预登记参考客户端和文档任务；公网生产部署、任意外部 MCP 客户端自动 OAuth 及真实商业履约另行核验。

后续的 Agent 自助登记、非会员申请、邀请兑换及真实令牌到期后自动续期也已通过独立环境验收；两侧实际 Agent 完成任务 `3daa1d00-0810-457c-a999-fb2a17775534`，MCP／A2A／SQLite 回读一致。轮换、停用与原 900 秒有效期恢复的证据见 [登记链路验收](evidence/agent-onboarding-2026-10-16/README.md)。
