# 账号注册与 Grok MCP

用户用 Google 或邮箱密码在 Auth0 自助注册，登录 `https://<gateway>/account` 后开通 EIGOS 账号。账号页只接受带 `email_verified: true` 的签名 ID Token。账号开通后，用户在账号页授权 Grok，再从 Grok Bot 的「连接应用 → 添加自定义连接器 → 远程 HTTPS」添加页面给出的 MCP URL 和 OAuth Client ID，完成 Auth0 用户同意。

Grok 使用授权码流程和 S256 PKCE 取得针对 `https://<gateway>/mcp` 的访问令牌。账号会话 Cookie 只用于账号页。MCP 使用 `submit_task` 提交只读查询，使用返回的任务 ID 调用 `get_task`，在同一 Grok 对话交付。旧地址 `/members`、`/members/*` 和 `/` 会 302 跳到 `/account`。

## 注册、开户和授权

### 注册方式

- 账号页的「注册」链接是 `/account/login?signup=1`，「登录」链接是 `/account/login`。
- 可用两种方式：Google（`google-oauth2` 连接）和邮箱密码（`auth0` 数据库连接）。
- 邮箱密码注册后，Auth0 发验证邮件。验证之前，账号页只提示先验证邮箱，不开通账号。用户验证后重新登录。配置了 `OAUTH_MANAGEMENT_CLIENT_ID` 和 `OAUTH_MANAGEMENT_CLIENT_SECRET` 时，页面上还有「重新发送验证邮件」按钮。
- 同一个已验证邮箱只对应一个账号。用另一种方式再登录时，Auth0 Action 把用户带到 `/account/link`。用户用原来的方式再登录一次，两种方式就合并成一个用户，对应同一个 owner。没验证过邮箱的用户不合并。

### 开户模式

用 `EIGOS_SIGNUP` 选择，默认 `open`。

| 值 | 新用户 |
| --- | --- |
| `open` | 第一次登录账号页，或第一次带着有效的 Grok 令牌访问 `/mcp` 时，自动开通账号。 |
| `invite` | 不自动开户。账号页显示邀请码表单，用户输入运营者用 `npm run account:invite` 发的邀请码开通。邀请码只能用一次，也只能由 Auth0 验证过的同一邮箱兑换。 |
| `closed` | 不开新户。 |

`open` 和 `invite` 要求 `EIGOS_ENFORCE_OWNER_RLS=true`。任何模式下，已有的账号都照常使用。

有 `Eigos` 定义授权（`view_definition`、`edit_definition` 或 `manage_definition`）的 owner 是运营者。运营者不会被开户，也不能兑换邀请码。账号页提示他继续使用原来的客户端。

### 授权 Grok

账号开通时还没有授权 Grok。用户在账号页点「授权 Grok」，页面随后显示 MCP 地址 `https://<gateway>/mcp` 和 OAuth Client ID。

- 点「撤销 Grok 授权」后，Gateway 立即拒绝这个账号的 Grok 令牌，包括撤销之后续发的令牌。
- 撤销后可以点「重新授权 Grok」。重新授权之前签发的令牌继续被拒绝，之后签发的令牌可用。旧令牌过期换新，或在 Grok 里重新连接后恢复。
- 停用账号同样立即拒绝它的令牌，见「运营者命令」。

## 上线顺序

第 2 步起的每一项，都会改动 Auth0 租户、数据库或线上服务，须先取得授权。

**升级邀请制部署前，先设置 `EIGOS_SIGNUP=invite`。** 新版本的默认值是 `open`。不设置的话，升级后任何人登录账号页都会自动开户。

邀请制和开放注册都要求开启 owner 隔离。暂时不能开启的部署设置 `EIGOS_SIGNUP=closed`：已有账号照常使用，不开新户。

全新部署没有旧版本：跳过第 4 步，第 5 步用 `npm run db:init`，其余相同。

准备，不影响线上：

1. 备份正式 schema。
2. 完成「Auth0」一节里部署 Action 之前的准备：新建 Management 应用，给门户应用加上新回调（原回调先保留），确认两个连接已启用，处理重复用户，记下现有的 tenant 映射。
3. 生成 `EIGOS_PORTAL_SECRET` 和 `EIGOS_ACCOUNT_LINK_SECRET`，写好新版本的环境变量。邀请制部署在这里加上 `EIGOS_SIGNUP=invite`。

停机窗口：

4. 停止旧版本的 Gateway 和 Worker，运行了 Indexer 的也一起停。旧版本还在读 `member_accounts`，下一步会把它改名。升级之后旧版本不能再启动，退路是第 1 步的备份。
5. 用管理角色执行 `npm run db:upgrade`。它把 `member_accounts` 改名为 `accounts` 并补上新列，把 `group:eigos-member-queries` 的授权移到 `group:eigos-accounts`。已有的账号、Grok 授权和邀请记录原样保留，Grok 连接不用重做。
6. 给运行角色授予新权限，包括 `accounts.email_hash`，见「PostgreSQL」。这一列到第 5 步才存在，所以权限只能在升级之后授予。
7. 用管理角色执行 `npm run db:enable-owner-isolation`。
8. 启动新版本的 Gateway 和 Worker，运行了 Indexer 的也一起启动。`/health` 返回 `ok`，`/account` 能打开。用户需要重新登录一次账号页，因为会话 Cookie 换了名字。

切换：

9. 部署 Action 并放进登录流程，见「Post-Login Action」。要在新 Gateway 运行之后部署，因为 Action 会把有重复用户的登录转到 `/account/link`。
10. 按「账号组」一节确认 `group:eigos-accounts` 已同步到当前定义。
11. 按「验收」验证。通过后，从门户应用删除原回调。

## Auth0

### 应用和连接

- 复用正式租户的 Universal Login 和数据库连接。验证邮件模板须启用，并允许测试邮箱接收邮件。数据库连接不要关闭自助注册（`Disable Sign Ups` 保持关闭）。
- 门户使用独立的 confidential web application。回调精确匹配 `https://<gateway>/account/callback`，令牌端点使用 `client_secret_post`，ID Token 使用 RS256，只要求 `openid email`。它的 client ID 和 secret 配给 Gateway 的 `OAUTH_MEMBER_CLIENT_ID` 和 `OAUTH_MEMBER_CLIENT_SECRET`。
- Grok 使用单独的公共客户端，设置不变：启用 Authorization Code 和 S256 PKCE，回调按实际 Grok Bot 客户端注册（既有 Grok Bot 回调为 `https://www.cursor.com/agents/mcp/oauth/callback`），需要长期连接时使用轮换、有限期 refresh token。它的 client ID 配给 `OAUTH_MEMBER_MCP_CLIENT_ID`。
- Google（`google-oauth2`）和邮箱密码两个连接，都要对门户应用和 Grok 应用启用。记录并保留其他应用原有的连接启用情况。
- 建立 identifier 为 `https://<gateway>/mcp` 的 Auth0 API，只提供 `tasks:read` 和 `tasks:write`。确认 Auth0 把真实客户端请求的 `resource` 映射到该 API audience。不要改旧 API 的 identifier。

### Management 应用

新建 Machine to Machine 应用，授予 Auth0 Management API 的 `read:users` 和 `update:users`，不要多给。Action 用它查找和合并用户。Gateway 用它重发验证邮件，`OAUTH_MANAGEMENT_CLIENT_ID` 和 `OAUTH_MANAGEMENT_CLIENT_SECRET` 可以填同一个应用的凭据。不配置时，账号页没有重发验证邮件的按钮。

### 部署前先检查

1. **重复用户。** 导出 Auth0 的全部用户，按小写邮箱分组，找出同一邮箱下有两个或更多 `email_verified` 为 `true` 的用户。Action 会在较新用户下次登录时，把它并入最早创建的那个用户，之后 owner 由最早的用户决定。owner 按 `digest([issuer, tenant, sub])` 计算，已有数据不迁移，所以较新用户名下的 EIGOS 数据在合并后不能再访问。逐组处理：
   - 较新用户没有要保留的 EIGOS 数据：不用处理，交给 Action。
   - 较新用户有要保留的数据：上线前手动合并，并让它做主用户。调用 Management API 的 `POST /api/v2/users/{主用户的 user_id}/identities`，请求体是被并入用户的 `provider` 和 `user_id`（不带 provider 前缀）。
   - 两个用户都有要保留的数据：由运营者决定保留哪一个，另一个的数据合并后访问不到。
2. **现有 tenant 映射。** 找到现有 Post-Login Actions 里写 tenant claim 的那一个，记下三个值：claim 名、读取的 `app_metadata` 键，以及用户没有这个键时得到的值。它们分别对应 Action 的 `TENANT_CLAIM`、`TENANT_METADATA_KEY` 和 `DEFAULT_TENANT`。
3. **保留现有的 Post-Login Actions。** 不要删除或改动其他应用的 Actions 和客户端授权。tenant 只从受管理的 `app_metadata` 取，不从邮箱、用户提交的内容或用户可编辑的 `user_metadata` 取。

### Post-Login Action

Action 的源码是 `deploy/auth0/post-login.cjs`，CommonJS，不依赖 npm 包。

1. 在 Auth0 创建自定义 Action，触发器选 Login / Post Login，运行时选 Node 22，把文件内容贴进去。
2. 配置下表全部 secrets。除 `TENANT_CLAIM` 和 `TENANT_METADATA_KEY` 外都必填，缺少时 Action 会抛错，登录会失败，所以先配好再部署。
3. 部署，并放进登录流程。

| Secret | 填什么 |
| --- | --- |
| `EIGOS_AUDIENCES` | 逗号分隔的 EIGOS API identifier，填 `https://<gateway>/mcp`。邮箱未验证的用户拿不到这些 API 的令牌，它们的 access token 由这个 Action 写入 tenant claim。不要列出原有的 `OAUTH_AUDIENCE`，除非要对原有客户端的用户同样要求已验证的邮箱。 |
| `TENANT_CLAIM` | 令牌里的 tenant claim 名，默认 `tenant_id`。必须和 Gateway 的 `OAUTH_TENANT_CLAIM` 完全相同。 |
| `TENANT_METADATA_KEY` | 用户 `app_metadata` 里保存 tenant 的键，默认 `tenant_id`。必须和现有 tenant 映射读取的键相同。 |
| `DEFAULT_TENANT` | 用户没有受管理的 tenant 时得到的值，Action 同时把它写回该用户的 `app_metadata`。新注册的用户也得到这个值。 |
| `LINK_URL` | `https://<gateway>/account/link`。 |
| `LINK_SECRET` | 必须和 Gateway 的 `EIGOS_ACCOUNT_LINK_SECRET` 相同。 |
| `MANAGEMENT_DOMAIN` | Auth0 租户域名，不带 `https://`，例如 `<tenant>.<region>.auth0.com`。 |
| `MANAGEMENT_CLIENT_ID`、`MANAGEMENT_CLIENT_SECRET` | Management 应用的凭据。 |

`DEFAULT_TENANT` 必须等于现有用户（没有受管理 tenant 字段的）现在得到的 tenant 值，否则这些用户的 owner 会变，找不到原来的数据。用「部署前先检查」第 2 步记下的值。值写回用户之后，再改 `DEFAULT_TENANT` 只影响还没写回的用户。上线前后，用同一个现有用户的令牌调用 `GET /identity`，owner 应当不变。

Action 的行为：

- 对登录流程里所有应用的每次登录都运行，不区分应用。租户里有 EIGOS 以外的应用时，先确认影响。
- 邮箱已验证、只有一个身份的用户，每次登录都调用一次 `users-by-email`，受 Management API 速率限制约束。Management API 不可用或被限流时，Action 让登录失败，不会跳过重复检查。刷新令牌换新不检查重复用户。
- 找到较早创建的已验证用户时，Action 把登录转到 `LINK_URL`，这时不写 tenant claim。用户在 `/account/link` 用原来的方式再登录后，Action 合并两个身份，把登录切换到原来的用户，再写 claim。合并没完成时登录被拒绝，用户看到提示「合并没有完成，请用原来的方式重新登录。」

Action 出问题时，先把它从登录流程里移走，其他 Actions 不受影响。已经写回的 `app_metadata` 和已经合并的用户不会撤销。

合并流程参考 Auth0 的[账号合并](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/link-user-accounts)和[服务端建议合并流程](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/suggested-account-linking-server-side-implementation)。

### 已知限制

- 重复用户检查调用 Auth0 的 `users-by-email`，它区分邮箱大小写。邮箱只有大小写不同的两个用户查不到对方，Action 不会自动合并它们。
- 合并请求不带 `connection_id`，只在租户只有一个 `auth0` 数据库连接时可靠。

## Gateway 环境变量

Gateway 在 `.env` 或部署环境里配置，示例见 `.env.example`。secret 只放在部署环境和 Auth0 的 Action secrets 里，不进仓库。

| 变量 | 说明 |
| --- | --- |
| `OAUTH_MEMBER_CLIENT_ID`、`OAUTH_MEMBER_CLIENT_SECRET` | 门户应用。 |
| `OAUTH_MEMBER_MCP_CLIENT_ID` | Grok 公共客户端。 |
| `OAUTH_EXISTING_CLIENT_IDS` | 逗号分隔的现有运营和 PA 客户端。先核对所有仍在使用的客户端 ID。启用后，既有客户端须持原 audience 的有效令牌，且 owner 仍须有既有 Eigos 定义授权。 |
| `OAUTH_TENANT_CLAIM` | tenant claim 名，默认 `tenant_id`，必须和 Action 的 `TENANT_CLAIM` 相同。 |
| `EIGOS_SIGNUP` | 开户模式：`open`（默认）、`invite` 或 `closed`。邀请制部署必须显式设为 `invite`。 |
| `EIGOS_ENFORCE_OWNER_RLS` | 设为 `true` 开启 owner 隔离。`EIGOS_SIGNUP` 不是 `closed` 时必须设置。Gateway、Worker 和 Indexer 都要设置。 |
| `EIGOS_PORTAL_SECRET` | 至少 32 个字符，加密登录过程中的 Cookie。 |
| `EIGOS_ACCOUNT_LINK_SECRET` | 至少 32 个字符，必须和 Action 的 `LINK_SECRET` 相同，且不能和 `EIGOS_PORTAL_SECRET` 相同。 |
| `OAUTH_MANAGEMENT_CLIENT_ID`、`OAUTH_MANAGEMENT_CLIENT_SECRET` | 可选，要么都配，要么都不配。配了，账号页才能重发验证邮件。 |
| `EIGOS_TRUST_PROXY` | Gateway 在反向代理或负载均衡后面时设置，见下。 |

`OAUTH_MEMBER_CLIENT_ID`、`OAUTH_MEMBER_CLIENT_SECRET`、`OAUTH_MEMBER_MCP_CLIENT_ID` 和 `OAUTH_EXISTING_CLIENT_IDS` 只要配了一个，Gateway 就要求这四个都配置。同时 `EIGOS_PORTAL_SECRET` 和 `EIGOS_ACCOUNT_LINK_SECRET` 也必须配置，即使 `EIGOS_SIGNUP=closed`。此外要求：

- `EIGOS_AUTH_MODE` 是 `jwt`。
- `OAUTH_ISSUER` 是以 `/` 结尾的 `https://` 租户地址，`OAUTH_JWKS_URL` 与它同源。
- `PUBLIC_URL` 是不带路径和结尾斜杠的 `https://` 地址。
- 门户、Grok 和现有客户端的 ID 互不相同。

任何一项不满足，Gateway 都拒绝启动。

两个 secret 各生成一个随机值，例如 `openssl rand -hex 32`。多个 Gateway 实例使用相同的两个 secret，登录状态放在加密 Cookie 里，不依赖某个实例的内存。轮换 `EIGOS_ACCOUNT_LINK_SECRET` 时同时更新 Action 的 `LINK_SECRET`。

`EIGOS_TRUST_PROXY` 的值是代理的跳数（例如 `1`），或 Express 的 `trust proxy` 取值（例如 `loopback`、代理的地址或 CIDR）。账号页的限流按真实客户端地址分别计数。不设置时，代理后面的所有用户共用一个额度。Gateway 直接暴露在公网时不要设置，否则客户端可以伪造 `X-Forwarded-For` 绕过限流。限流计数在每个 Gateway 进程内，多个实例各算各的。

## PostgreSQL

升级前先备份正式 schema。用管理角色（拥有表的角色）执行：

```sh
npm run db:upgrade
npm run db:enable-owner-isolation
```

`accounts` 表和它的新列到 `db:upgrade` 之后才存在，运行角色的新权限在升级之后授予。

Gateway、Worker 和 Indexer 设置 `EIGOS_ENFORCE_OWNER_RLS=true` 后，启动时会验证角色和策略。角色必须是普通角色：不是超级用户，不拥有这些表，也没有 `BYPASSRLS`，否则拒绝启动。详见 [Ontology 运行服务](ontology-services.md#postgresql-owner-隔离)。

运行角色的权限：

| 表 | Gateway 角色 | Worker 角色 |
| --- | --- | --- |
| `accounts` | SELECT；INSERT(`owner`, `email_hash`)；UPDATE(`approved_at`, `revoked_at`, `email_hash`) | SELECT |
| `member_invitations` | SELECT；UPDATE(`redeemed_by`) | 无 |
| `member_sessions` | SELECT、INSERT、DELETE | 无 |

对应的语句如下，`<schema>` 是 `EIGOS_PG_SCHEMA`：

```sql
GRANT SELECT ON <schema>.accounts TO <gateway_role>, <worker_role>;
GRANT INSERT (owner, email_hash), UPDATE (approved_at, revoked_at, email_hash)
  ON <schema>.accounts TO <gateway_role>;
GRANT SELECT ON <schema>.member_invitations TO <gateway_role>;
GRANT UPDATE (redeemed_by) ON <schema>.member_invitations TO <gateway_role>;
GRANT SELECT, INSERT, DELETE ON <schema>.member_sessions TO <gateway_role>;
```

升级已有部署时，`member_invitations` 和 `member_sessions` 的权限和以前一样。`accounts` 沿用 `member_accounts` 原有的权限，新增的只有 `email_hash` 的 INSERT 和 UPDATE。重复授予无害。

Gateway 角色不授予 `status`、`suspended_at` 和 `suspended_reason` 的 UPDATE。停用和恢复账号用管理角色执行运营者命令。邀请码也只由管理角色写入。数据库里只存会话令牌、邀请码和邮箱的摘要。

## 运营者命令

这些命令用管理角色的 `DATABASE_URL`（`.env` 或环境变量）运行，不用 Gateway 的运行角色。

| 命令 | 作用 |
| --- | --- |
| `npm run account -- show <owner\|email>` | 查看账号，输出 JSON：`owner`、`status`、`activatedAt`、`approvedAt`、`revokedAt`、`suspendedAt`、`suspendedReason`。 |
| `npm run account -- suspend <owner\|email> <理由…>` | 停用账号。理由 1 至 200 个字符，可以写多个词。 |
| `npm run account -- restore <owner\|email>` | 恢复停用的账号。 |
| `npm run account:invite -- <email> [小时]` | 生成邀请码，默认 48 小时，可设 1 至 168 小时。 |
| `npm run access:grant-business -- <owner>` | 一次性给指定 owner 当前定义里的全部业务授权，以后新增的能力不会自动加上。 |

- `<owner|email>`：64 位十六进制按 owner 查找，否则当作邮箱，不区分大小写。按邮箱查找要求账号已经记录邮箱摘要，升级前开通的账号在升级后第一次登录账号页时补上。同一邮箱有多个账号时取最近开通的一个，要精确就用 owner。
- 停用后，Gateway 立即拒绝这个账号的令牌。用这个账号身份加载的授权不再包含 `group:eigos-accounts`，已排队的任务在 Worker 执行时也会被拒绝。账号页显示「这个账号已停用，请联系 EIGOS 支持。」，也不能再授权 Grok。恢复后一切照旧，Grok 授权状态不变。
- 重复运行同一条 `suspend` 或 `restore` 不报错，输出当前状态。
- `account:invite` 输出的邀请码是一次性的私有材料，按凭据保管，不要写进日志。邀请码只能由 Auth0 验证过的同一邮箱兑换。

### 账号组

开通且未停用、已授权 Grok 的账号，通过组 `group:eigos-accounts` 获得 Ontology 授权。

- `npm run ontology:publish` 和 `npm run ontology:activate -- <release>` 成功后，这个组的授权被整组替换为当前定义的业务授权。`ontology:prepare` 不同步。
- 业务授权包括：`Eigos` 的 `view_definition`，业务对象的 `view_objects`，业务 Function 的 `execute_function`，业务 Action 的 `apply_action`，以及这些 Function 用到的来源的 `read_source`。不含 `edit_definition` 和 `manage_definition`。沙箱资源只在 `EIGOS_AGENT_SANDBOX_ENABLED=true` 的本地开发环境里包含。
- 整组替换意味着手工写在这个组上的授权，会在下一次发布或激活时被覆盖。不要再用 `access:configure` 配置 `group:eigos-accounts`。旧组 `group:eigos-member-queries` 不再使用，`db:upgrade` 把它的授权移到新组。给单个 owner 的授权仍可用 `access:configure`，不受同步影响。
- 升级后，新组先保留从旧组迁来的授权，直到下一次发布或激活才换成业务授权。要马上同步，对当前生效的 release 再运行一次 `npm run ontology:activate -- <release>`。release 在发布命令的输出里，也可以查表 `<schema>.ontology` 的 `release` 列。
- 通过 Ontology 分支提案的 `merge` 激活新版本时，当前不会同步。合并后再运行一次 `npm run ontology:activate -- <release>`。

账号需要读取某个来源时，仍要给该 owner 配置有效期明确的来源绑定，见 [供应商连接](service-planning.md#供应商连接)。账号无需提供供应商账号凭据。授权范围延续现有 Ontology 权限实现，参考 [Palantir 应用权限](https://www.palantir.com/docs/foundry/developer-console/permissions)。

## 账号页和 Gateway 的提示

### 路由和 Cookie

| 路由 | 说明 |
| --- | --- |
| GET `/account` | 账号页。 |
| GET `/account/login`、`/account/callback`、`/account/link`、`/account/link/continue` | 登录、回调和合并页。同一地址每分钟合计最多 20 次。 |
| POST `/account/activate`、`/account/approve`、`/account/revoke`、`/account/logout` | 账号页的表单。需要会话，并检查 `Origin` 等于 `PUBLIC_URL`。同一地址每分钟合计最多 30 次。 |
| POST `/account/resend-verification` | 重发验证邮件。同一地址每小时最多 5 次。 |

超过限制返回 429 和 `Retry-After`。表单提交的 `Origin` 不是 `PUBLIC_URL` 时，返回 403 和提示「请回到账号页重新提交。」要避免这种情况，用 `PUBLIC_URL` 的地址访问，反向代理也不要改写 `Origin`。

Cookie 都带 `__Host-` 前缀，只能通过 HTTPS 使用。

| Cookie | 内容 | 有效期 |
| --- | --- | --- |
| `__Host-eigos-account` | 账号会话 | 8 小时 |
| `__Host-eigos-account-login` | 登录过程的 state、nonce 和 PKCE verifier，加密 | 5 分钟 |
| `__Host-eigos-account-link` | 合并过程的上下文，加密 | 5 分钟 |
| `__Host-eigos-account-verify` | 等待验证邮箱的用户，加密 | 10 分钟 |

### 账号页提示

账号页用 `/account?status=<值>` 显示提示。

| `status` | 含义和处理 |
| --- | --- |
| `login` | 登录没有完成：Cookie 过期、被改动或已用过，或 code、ID Token 校验失败。用户重新登录。 |
| `verify` | 邮箱还没验证。用户验证后重新登录。 |
| `tenant` | ID Token 没有 tenant claim。检查 Action 是否已部署并放进登录流程，`TENANT_CLAIM` 是否等于 `OAUTH_TENANT_CLAIM`，`DEFAULT_TENANT` 是否已设置。 |
| `closed` | `EIGOS_SIGNUP=closed`，目前暂停注册新账号。 |
| `invite` | 邀请码无效、已过期，或和已验证的邮箱不一致。重新发一个邀请码。 |
| `operator` | 这是运营者账号，不需要开通，继续使用原来的客户端。 |
| `link` | 合并没有完成。用户用原来的方式重新登录，仍失败时检查 Action 日志和两边的 secret 是否相同。 |
| `resent` | 验证邮件已重新发送。 |

### Gateway 返回 403

账号令牌被拒绝时，Gateway 返回 403 和 JSON `{ "error": "…", "reason": "…", "account": "/account" }`。

| `reason` | 含义和处理 |
| --- | --- |
| `client_not_authorized` | 账号还没授权 Grok，授权已撤销，或令牌签发在最近一次授权之前。用户在账号页授权，之后用新签发的令牌。 |
| `account_suspended` | 账号已停用。运营者确认后 `npm run account -- restore`。 |
| `insufficient_scope` | 令牌缺 `tasks:read` 或 `tasks:write`。响应头 `WWW-Authenticate` 带 `error="insufficient_scope"`。检查 Auth0 API 的 scopes 和 Grok 客户端的授权。 |
| `client_not_allowed` | 令牌不是 Grok 公共客户端（`OAUTH_MEMBER_MCP_CLIENT_ID`）为 MCP audience 签发的，也不是运营者用原有客户端签发的。账号只能用 Grok 公共客户端。 |
| `invite_required` | `invite` 模式，账号还没开通。发邀请码。 |
| `signup_closed` | `closed` 模式，账号不存在。要开放注册，改 `EIGOS_SIGNUP`。 |
| `operator_account` | 这个 owner 有 `Eigos` 定义授权，是运营者。继续使用原来的客户端令牌。 |

## 验收

验收只做真实查询和 synthetic 执行，不写外部日历，不真实报名、下单或付款。验收前给测试 owner 配置有效期明确的 [FlyAI trial 来源绑定](service-planning.md#供应商连接)。每一项记录结果和标识，不记录令牌、邮箱、验证链接或任何凭据。

下面按 `open` 模式写。`invite` 模式下，第 1、2 项的新用户登录后看到邀请码表单，输入 `npm run account:invite` 发的邀请码后开通。`closed` 模式下，新用户登录后看到暂停注册的提示。

1. 用新的 Google 账号注册，自动开通，`npm run account -- show <owner|email>` 返回的 `status` 是 `active`。
2. 用新邮箱加密码注册。验证邮箱之前看到 `verify` 提示，`show` 查不到账号。验证之后重新登录，自动开通。
3. 用同一个邮箱换另一种方式登录，进入合并页。用原来的方式登录后合并完成，两种方式的 `show` 返回同一个 owner。
4. 授权 Grok，在 Grok Bot 里问一次只读航班查询。用原 `taskId` 读回结果，结果带来源证据，并在同一对话交付。
5. 撤销 Grok 授权后，请求被 Gateway 拒绝，返回 403，`reason` 是 `client_not_authorized`。重新授权后，新签发的令牌可用。
6. 停用账号后请求返回 403，`reason` 是 `account_suspended`。恢复后可用。
7. 从第二个账号读取第一个账号的任务，应返回不可访问。

以真实客户端验证 `401` 响应里的 `resource_metadata`、MCP 资源地址、Auth0 PKCE、精确回调、签名 JWT 的 audience、tenant claim、client ID 和 scopes。公开发现信息见 [MCP 授权规范](https://modelcontextprotocol.io/specification/latest/basic/authorization)，Auth0 的 resource 转换见 [Auth0 resource profile](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)，客户端入口见 [Grok Bot MCP](https://docs.x.ai/grok-bot/computer-and-apps)。
