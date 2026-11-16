# 邀请制会员与 Grok MCP

用户从 `/members` 注册或登录。Auth0 发送验证邮件，会员中心只接受带 `email_verified: true` 的签名 ID Token。验证后重新登录，输入寄给该邮箱的 EIGOS 邀请码，开通会员。用户随后在会员中心授权 Grok，再从 Grok Bot 的「连接应用 → 添加自定义连接器 → 远程 HTTPS」添加页面给出的 MCP URL 和 OAuth Client ID，完成 Auth0 用户同意。

Grok 使用授权码流程和 S256 PKCE 取得针对 `https://<gateway>/mcp` 的访问令牌。会员会话 Cookie 只用于会员中心。MCP 使用 `submit_task` 提交只读查询，使用返回的任务 ID 调用 `get_task`，在同一 Grok 对话交付。会员中心的撤销操作会使该会员的 Grok 访问立即失效，即使 Auth0 令牌还有效或客户端续发令牌。撤销后，同一个 OAuth 客户端的现有授权不能通过网页按钮重新启用。

## Auth0

- 复用正式租户的 Universal Login 和数据库连接。验证邮件模板须启用并允许测试邮箱接收邮件。会员门户使用独立 confidential web application，回调精确匹配 `https://<gateway>/members/callback`，令牌端点使用 `client_secret_post`，ID Token 使用 RS256。只要求 `openid email`。
- Grok 使用单独的公共客户端，启用 Authorization Code、S256 PKCE，回调按实际 Grok Bot 客户端注册。既有 Grok Bot 回调为 `https://www.cursor.com/agents/mcp/oauth/callback`。需要长期连接时使用轮换、有限期 refresh token。将同一数据库连接启用到这两个应用；记录并保留原连接客户端。
- 建立 identifier 为 `https://<gateway>/mcp` 的 Auth0 API，只提供 `tasks:read` 和 `tasks:write`。确认 Auth0 把真实客户端请求的 `resource` 映射到该 API audience。不要改旧 API 的 identifier。
- 将现有受管理的租户字段写入门户 ID Token 和该 API access token。应使用现有用户一致的租户映射，不能从邮件、用户提交内容或可编辑的用户 metadata 取租户。部署前保留其他应用的 Post Login Actions 和客户端授权。
- Gateway 配置 `OAUTH_MEMBER_CLIENT_ID`、`OAUTH_MEMBER_CLIENT_SECRET`、`OAUTH_MEMBER_MCP_CLIENT_ID` 和逗号分隔的 `OAUTH_EXISTING_CLIENT_IDS`。先核对所有仍在使用的运营和 PA 客户端 ID。启用后，既有客户端须持原 audience 的有效令牌，且 owner 仍须有既有 Eigos 定义授权。新会员令牌只接受新的 MCP audience 和配置的 Grok client ID。
- 以真实客户端验证 `401` 中的 `resource_metadata`、MCP 资源地址、Auth0 PKCE、精确回调、签名 JWT 的 audience、tenant claim、client ID 和 scopes。公开发现信息见 [MCP 授权规范](https://modelcontextprotocol.io/specification/latest/basic/authorization)，Auth0 的 resource 转换见 [Auth0 resource profile](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)，客户端入口见 [Grok Bot MCP](https://docs.x.ai/grok-bot/computer-and-apps)。

## PostgreSQL

在正式 schema 备份后用管理角色执行 `npm run db:upgrade`。表权限按实际运行角色套用。Gateway 需要：

- `member_accounts` 的 SELECT、INSERT(owner)、UPDATE(approved_at, revoked_at)。
- `member_invitations` 的 SELECT、UPDATE(redeemed_by)。使用数据库管理员生成邀请。
- `member_sessions` 的 SELECT、INSERT、DELETE。浏览器会话和邀请令牌只存摘要。执行会员查询的 Worker 需要 `member_accounts` 的 SELECT。已有执行和只读查询角色沿用原权限。

用管理角色运行 `npm run access:invite-member -- <已授权的测试邮箱> 48`。输出是单次邀请码，按私有材料保管；有效期可设 1 至 168 小时。邀请与 Auth0 验证后的邮箱一致才可兑换。

已开通且 Grok 授权有效的会员可使用 `group:eigos-member-queries` 上已有的 Ontology 资源授权。根据首个查询能力用 `access:configure` 配置该组，只选经过确认的外部只读能力。举例，首条只读航班查询可用：

```json
{"subjects":[{"owner":"group:eigos-member-queries","grants":[
  {"resource":"Eigos","permission":"view_definition"},
  {"resource":"Eigos/function/readFliggyFlights","permission":"execute_function"},
  {"resource":"Eigos/source/Fliggy","permission":"read_source"}
]}]}
```

同时给实际测试 owner 配置有效期明确的既有 [FlyAI trial 来源绑定](service-planning.md#供应商连接)。该绑定仍由现有来源配置和授权检查管理。会员无需提供供应商账号凭据。只读资源和来源的范围延续现有 Ontology 权限实现。参考 [Palantir 应用权限](https://www.palantir.com/docs/foundry/developer-console/permissions)。

## 验收

1. 用独立、真实新邮箱走注册和验证。验证前保持未开通，验证后登录兑换邀请并单独同意 Grok 访问。
2. 在 Grok Bot 原对话询问一次只读航班查询。使用原 `taskId` 读回结果，确认结果带来源证据并在相同对话交付。
3. 从第二个已获授权的身份读取第一个任务，应返回不可访问。撤销第一个身份的 Grok 授权，重复读同一任务和提交请求，应在 Gateway 被拒绝。保留测试标识和状态，避免输出邮件、令牌、邮箱验证链接或任何凭据。
