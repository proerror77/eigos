# Auth0 身份提供方与真实会员联调

选择日期：2026-10-16。采用 Auth0 托管登录与授权服务；EIGOS 继续管理会员资料、开通状态、连接停用及任务权限，不迁移会员库，也不自行搭建密码或 OAuth 授权服务器。

## 选择依据

当前需求是用户注册／登录后，由 Personal Agent 代表用户取得针对 EIGOS 的访问令牌。Auth0 已有托管 OIDC 登录、[MCP 授权支持](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/)及 [RFC 9068 access-token profile](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)，与现有 `at+jwt`、`client_id`、RS256 和资源 audience 校验契约匹配。

我的阶段性判断是：新项目优先减少身份系统的部署与维护工作，用 Auth0 验证真实用户链路。[Keycloak](https://www.keycloak.org/securing-apps/mcp-authz-server)保留为后续明确需要自托管时的选择，其部署、邮件、升级和恢复需要项目自行维护。此选择不把公开产品声明当成 EIGOS 已联调成功。

初期使用 [Free 开发计划](https://auth0.com/pricing)，不购买域名、不配置需要信用卡验证的 Auth0 自定义域名，不启用付费组织／企业 SSO、Token Vault 或 Agent as Principal。本轮保持 user `sub` 为会员身份；Agent 通过独立 OAuth 客户端代表用户调用。实际账户权益仍以控制台为准。

## 资源与客户端

| 对象 | 配置与职责 |
| --- | --- |
| EIGOS API | Identifier 为 Gateway 的 HTTPS origin；RS256；`rfc9068_profile`；访问令牌最长 900 秒；三项服务／任务 scope；保留用户 consent |
| Member Portal | Regular Web Application；精确 `/members/callback`；授权码＋PKCE；`client_secret_post`；仅服务端持有 secret |
| Personal Agent | Native public client；独立 client ID；精确 `http://127.0.0.1:3211/callback`；授权码＋S256 PKCE；无 client secret |
| 登录连接 | 两个客户端启用同一 Auth0 database connection，使用同一会员账号；保留连接上原有其他客户端 |
| Post Login Action | 仅对本 Portal 或 EIGOS API 生效；ID／Access Token 写入相同、管理员控制的 namespaced tenant claim；不读取可由用户修改的 metadata 作为租户 |

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

生成 `gateway.env`、`agent.env` 和恢复用 `state.json`，目录权限 0700、文件权限 0600。Portal secret 只写 Gateway 私有配置，不显示在命令输出、提示词或 Git 中。脚本不修改项目现有 `.env`。

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

2026-10-16 本次已准备提供方配置、Action、namespaced claim 适配和真实 Agent 工具；本地 85 项测试、类型检查与构建通过。Auth0 CLI 1.37.0 已从官方 Homebrew tap 安装。

Mac 私有 HTTPS 已通过证书验证和 loopback 代理探测；临时探测端口随后移除，原 `443` 服务保留。私有探测回执及配置草案在 `data/auth0-live/`，不纳入 Git。

**尚未完成真实链路**：Auth0 控制台仍待账号持有人登录，没有可用的已授权租户／客户端凭据，尚未创建云端资源或运行真实会员 OAuth／Agent 验收。账号凭据、验证码和注册条款由账号持有人处理；准备好的代码和本地回归不代替这些步骤。
