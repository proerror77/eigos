# Beta 账号申请与 Grok MCP

用户用 Google 或邮箱密码在 Auth0 注册。账号页只接受带 `email_verified: true` 的签名 ID Token。用户在 `https://<gateway>/account` 提交使用申请，运营审核后单独提供邀请码。用户兑换邀请码开通 Beta 账号，并在账号页授权 Grok。申请用途供运营审核，开通后的账号共用已发布的 Beta 业务能力。用户从 Grok Bot 的「连接应用 → 添加自定义连接器 → 远程 HTTPS」添加页面上的 MCP URL 和 OAuth Client ID，完成 Auth0 用户同意。

Grok 使用授权码流程和 S256 PKCE 取得针对 `https://<gateway>/mcp` 的访问令牌。账号会话 Cookie 只用于账号页。MCP 使用 `submit_task` 提交只读查询，使用返回的任务 ID 调用 `get_task`，在同一 Grok 对话交付。旧地址 `/members` 和它下面的所有路径（包括旧的门户回调 `/members/callback`），以及 `/`，都会 302 跳到 `/account`。

## 注册、开户和授权

### 注册方式

- 账号页的「注册」链接是 `/account/login?signup=1`，「登录」链接是 `/account/login`。
- 可用两种方式：Google（`google-oauth2` 连接）和邮箱密码（`auth0` 数据库连接）。
- 邮箱密码注册后，Auth0 发验证邮件。验证之前，账号页只提示先验证邮箱，不开通账号。用户验证后重新登录。配置了 `OAUTH_MANAGEMENT_CLIENT_ID` 和 `OAUTH_MANAGEMENT_CLIENT_SECRET` 时，页面上还有「重新发送验证邮件」按钮，见「重发验证邮件」。
- 同一个已验证邮箱只对应一个账号。没验证过邮箱的用户不合并。
- 原来的账号是最先成为 EIGOS 账号的那个。已验证的用户第一次拿到 EIGOS 的 claim 时，Action 在它的 `app_metadata.eigos_since` 记下时间，以后不再改。比较两个用户时，有这个时间的排在没有的前面，时间早的排在前面；都没有时，创建早的排在前面。邮箱可能在创建很久以后才验证，所以只看创建时间，会把一个从没用过 EIGOS、甚至是别人抢先注册的账号当成原来的账号。
- 用另一种方式再登录同一个邮箱时，如果有排在它前面、门户也能登录的已验证用户，要先并入那个用户，顺序是：
  1. Auth0 Action 暂停这次登录，把浏览器送到合并页 `/account/link`。
  2. 用户点「用原来的方式登录」（`/account/link/continue`），用原来的方式再登录一次。
  3. 账号页确认这次登录是原来的那个账号，显示「继续」按钮。用户点「继续」，浏览器用 POST 把确认结果交回 Auth0，Auth0 才继续被暂停的登录。
  4. 两种方式合并成一个用户，对应原来那个账号的 owner。从账号页发起的登录，合并后回到账号页。
- 账号页在第 3 步确认了原来那个账号，就撤销它的 Grok 授权，之后账号页显示「重新授权 Grok」。用户没点「继续」，授权也已经撤销。合并之前连接到这个账号的 Agent，要等刚刚证明了账号归属的人重新授权才能再用。
- 登录的不是原账号，或登录没有完成时，账号页显示「合并没有完成，请用原来的方式重新登录。」，用户重新登录。Auth0 继续登录之后，回到账号页的不是原来那个账号时，也是这个提示，不开会话，也不开户。

### 开户模式

用 `EIGOS_SIGNUP` 选择，默认 `invite`。

| 值 | 新用户 |
| --- | --- |
| `open` | 第一次登录账号页，或第一次带着有效的 Grok 令牌访问 Gateway（例如 `/mcp`）时，自动开通账号。 |
| `invite` | 用户用已验证邮箱提交申请，运营审核并逐个发码。新邀请码绑定申请身份和已验证的邮箱，只能兑换一次。 |
| `closed` | 不开新户。 |

`open` 和 `invite` 要求 `EIGOS_ENFORCE_OWNER_RLS=true`。任何模式下，已有的账号都照常使用。

**`open` 就是公开注册，正式环境先不要用。** 下面三件事落地之前，正式环境保持 `invite` 或 `closed`：

1. Worker 改用按量计费的模型凭据。现在所有账号的任务共用一个 ChatGPT 订阅的登录凭据，公开注册可能违反这个订阅的使用条款，也很快会被限流（设计文档第 4 节第 5 条）。
2. 每个账号的配额：每天的任务数、同时进行的任务数，以及每个连接每分钟的调用次数（设计文档第 6.9 节）。第 1 步没有做配额。
3. 撤销 Agent 连接，或者完成合并时，同时撤销这个用户在 Auth0 里的授权记录和 refresh token，设计文档的第 4 步会做（第 6.4 节）。在这之前，合并之前连接到这个账号的 Agent，合并之后仍然拿着 refresh token，`invite` 模式也挡不住这一点：refresh token 由 Auth0 发，和 Gateway 开不开户无关。见「已知限制」。

在这之前，`open` 用于开发环境。正式 Beta 环境显式设置 `EIGOS_SIGNUP=invite`。

配置了门户（`OAUTH_MEMBER_MCP_CLIENT_ID`）的 Gateway，启动时输出一行 `EIGOS account sign-up mode: <mode>`。升级后用它确认生效的模式。

有 `Eigos` 定义授权（`view_definition`、`edit_definition` 或 `manage_definition`）的 owner 是运营者。运营者不会被开户，也不能兑换邀请码。账号页提示他继续使用原来的客户端。

### 授权 Grok

账号开通时还没有授权 Grok。用户先在账号页点「授权 Grok」，页面随后显示 MCP 地址 `https://<gateway>/mcp` 和 OAuth Client ID，再到 Grok 里添加连接。顺序不能反：授权之前签发的令牌，一直被 Gateway 拒绝（403 `client_not_authorized`）。

- 点「撤销 Grok 授权」后，Gateway 立即拒绝这个账号的 Grok 令牌，包括撤销之后续发的令牌。
- 撤销后可以点「重新授权 Grok」。重新授权之前签发的令牌，包括撤销之前和撤销期间签发的，继续被拒绝。所以撤销或重新授权之后，用户都要在 Grok 里重新连接，拿重新授权之后签发的令牌。
- 停用账号同样立即拒绝它的令牌，见「运营者命令」。
- 同一个邮箱的另一个用户要并入这个账号，账号页确认了这个账号时，Grok 授权也被撤销，见「注册方式」。

## 上线顺序

第 2 步起的每一项，都会改动 Auth0 租户、数据库或线上服务，须先取得授权，见「需要授权的操作」。

正式环境设置 `EIGOS_SIGNUP=invite` 或 `closed`。

邀请制和开放注册都要求开启 owner 隔离。暂时不能开启的部署设置 `EIGOS_SIGNUP=closed`：已有账号照常使用，不开新户。

已有 `/account` 的部署沿用现有 Auth0 应用、回调和密钥。备份 schema 后停掉运行进程，再执行 `npm run db:upgrade` 和下文的 Gateway 申请表授权。保留既有账号组权限以及仍有效的旧邀请码。重启后核对 `invite` 模式，并验证申请、发码和相互隔离的任务。以下完整步骤用于首次配置账号页或从早期 `/members` 版本升级。

全新部署没有旧版本：跳过第 4 步，第 5 步用 `npm run db:init`，其余相同。

准备，不影响线上：

1. 备份正式 schema。
2. 完成「Auth0」一节里部署 Action 之前的准备：新建 Management 应用，给门户应用加上新回调（原回调先保留），确认两个连接已启用，处理重复用户，记下现有的 tenant 映射，以及门户和 Grok 的 client ID 和门户能登录的连接（Action 的 `EIGOS_CLIENT_IDS` 和 `EIGOS_CONNECTIONS`）。
3. 生成 `EIGOS_PORTAL_SECRET` 和 `EIGOS_ACCOUNT_LINK_SECRET`，写好 Gateway 和 Worker 新版本的环境变量。Worker 启动时做同样的配置检查，见「Gateway 环境变量」。正式环境在这里加上 `EIGOS_SIGNUP=invite` 或 `closed`。`OAUTH_ISSUER` 是 Auth0 自定义域名，又要用重发验证邮件时，再加上 `OAUTH_MANAGEMENT_DOMAIN`。

停机窗口：

4. 停止旧版本的 Gateway 和 Worker，运行了 Indexer 的也一起停。旧版本还在读 `member_accounts`，下一步会把它改名。升级之后旧版本不能直接启动。要退回旧版本，见「回退」：可以用反向 SQL，也可以用第 1 步的备份。
5. 用管理角色执行 `npm run db:upgrade`，创建申请表并增加邀请码的身份绑定列。对于早期版本，本步骤也把 `member_accounts` 改名为 `accounts`，把 `group:eigos-member-queries` 的授权移到 `group:eigos-accounts`。已有账号、Grok 授权及未过期的邀请码继续可用。
6. 给运行角色授予所需权限，包括 Gateway 的申请表权限，见「PostgreSQL」。
7. 用管理角色执行 `npm run db:enable-owner-isolation`。
8. 启动新版本的 Gateway 和 Worker，运行了 Indexer 的也一起启动。`/health` 返回 `ok`，`/account` 能打开。确认 Gateway 启动日志里的 `EIGOS account sign-up mode: <mode>` 是预期的模式。正式环境看到 `open` 时，先停掉 Gateway，改好 `EIGOS_SIGNUP` 再启动。用户需要重新登录一次账号页，因为会话 Cookie 换了名字。

切换：

9. 部署 Action 并放进登录流程，见「Post-Login Action」。要在新 Gateway 运行之后部署，因为 Action 会把有重复用户的登录转到 `/account/link`。
10. 确认 `group:eigos-accounts` 已同步到当前定义。先用 `SELECT release FROM <schema>.ontology WHERE id='Eigos'` 查出业务 Ontology 的 release，运行 `npm run ontology:activate -- <release>`，运行前后各用 `SELECT count(*) FROM <schema>.resource_grants WHERE subject='group:eigos-accounts'` 查一次这个组的授权条数。怎么读结果，见「账号组」。
11. 按「验收」验证。通过后，从门户应用删除原回调。

### 需要授权的操作

下面每一项都是对外操作。执行前，向用户逐项列出，取得对这次部署的明确授权。

- **Auth0：**
  - 给门户应用加上回调 `https://<gateway>/account/callback`，验收通过后删除原回调；
  - 新建 Management 应用，授予 `read:users` 和 `update:users`；
  - 处理「部署前先检查」查出的重复用户：给有数据的用户写 `app_metadata.eigos_since`，删除没验证的较早用户，手动合并邮箱只有大小写不同的用户；
  - 部署 Action，配置全部 secrets（包括 `EIGOS_CLIENT_IDS` 和 `EIGOS_CONNECTIONS`），放进登录流程。
- **正式环境的环境变量**，Gateway 和 Worker 都要改。
- **数据库：**`db:upgrade`，给运行角色授予新权限，`db:enable-owner-isolation`，以及用 `ontology:activate` 同步账号组。
- **部署**新版本的 Gateway 和 Worker，运行了 Indexer 的也一起部署。

同时让用户确认这些后果：

- **账号组的授权会扩大。** `db:upgrade` 把旧组 `group:eigos-member-queries` 的授权原样移到 `group:eigos-accounts`。上面第 10 步的 `ontology:activate`，以及以后每一次发布或激活业务 Ontology，都把这个组整组替换成全部业务授权：所有业务 Function 的 `execute_function`，所有业务 Action 的 `apply_action`，以及这些 Function 用到的全部来源的 `read_source`。旧组原来只给了一部分能力时，所有账号会多出其余的能力。
- **合并不能撤销，而且对整个租户生效**，见「Action 的行为」。
- **部署前没处理的重复用户**，较新用户名下的 EIGOS 数据在合并后访问不到。会员同邮箱下还有一个较早创建、没验证的用户时也一样：那个用户一验证，会员就可能被并入它。
- **合并之后要重新授权 Grok。** 账号页确认原来那个账号时撤销它的 Grok 授权，用户在账号页重新授权，再在 Grok 里重新连接。
- **正式环境不开放注册。** 开户模式是 `invite` 或 `closed`，见「开户模式」。

## Auth0

### 应用和连接

- 复用正式租户的 Universal Login 和数据库连接。验证邮件模板须启用，并允许测试邮箱接收邮件。数据库连接不要关闭自助注册（`Disable Sign Ups` 保持关闭）。这个设置对所有使用这个连接的应用都生效。
- 门户使用独立的 confidential web application。回调精确匹配 `https://<gateway>/account/callback`，令牌端点使用 `client_secret_post`，ID Token 使用 RS256，只要求 `openid email`。旧的门户回调现在只会 302 跳到 `/account`，不能再完成登录，所以要加上新回调，切换完成后删掉旧回调。它的 client ID 和 secret 配给 Gateway 的 `OAUTH_MEMBER_CLIENT_ID` 和 `OAUTH_MEMBER_CLIENT_SECRET`。
- Grok 使用单独的公共客户端，设置不变：启用 Authorization Code 和 S256 PKCE，回调按实际 Grok Bot 客户端注册（既有 Grok Bot 回调为 `https://www.cursor.com/agents/mcp/oauth/callback`），需要长期连接时使用轮换、有限期 refresh token。它的 client ID 配给 `OAUTH_MEMBER_MCP_CLIENT_ID`。
- Google（`google-oauth2`）和邮箱密码两个连接，都要对门户应用和 Grok 应用启用。记录并保留其他应用原有的连接启用情况。这两个连接的名字填进 Action 的 `EIGOS_CONNECTIONS`。
- 建立 identifier 为 `https://<gateway>/mcp` 的 Auth0 API，只提供 `tasks:read` 和 `tasks:write`。确认 Auth0 把真实客户端请求的 `resource` 映射到该 API audience。不要改旧 API 的 identifier。

### Management 应用

新建 Machine to Machine 应用，授予 Auth0 Management API 的 `read:users` 和 `update:users`，不要多给。Action 用它查找和合并用户，凭据填进 Action 的 `MANAGEMENT_*` secrets。Gateway 的重发验证邮件也用 Management API，见下一节。

### 重发验证邮件

未验证邮箱的用户在 `/account?status=verify` 可以点「重新发送验证邮件」。

- 配置了 `OAUTH_MANAGEMENT_CLIENT_ID` 和 `OAUTH_MANAGEMENT_CLIENT_SECRET` 才有这个按钮，也才有路由 `POST /account/resend-verification`。不配置时，用户只能自己找验证邮件。
- 这个路由不需要会话，靠 Cookie `__Host-eigos-account-verify` 找到用户。Cookie 在未验证的登录之后写入，10 分钟有效。过期后点按钮不会发信，页面回到 `verify`，用户重新登录一次。
- 同一客户端地址（IP）每小时最多 5 次。限流按地址计数（IPv6 按 /64 前缀，见「Gateway 环境变量」），不按邮箱或用户：换一个地址，就能对同一个邮箱再次触发。没设置 `EIGOS_TRUST_PROXY` 时，代理后面的所有用户共用这每小时 5 次。
- Gateway 的 Management 客户端需要 `update:users`。可以填 Action 用的同一个应用（`read:users`、`update:users`）的凭据，也可以另建一个只授予 `update:users` 的应用。
- 设置了 `OAUTH_MANAGEMENT_DOMAIN` 时，Management 令牌请求、audience（`https://<域名>/api/v2/`）和验证邮件任务都发往这个域名。没设置时发往 `OAUTH_ISSUER`。`OAUTH_ISSUER` 是 Auth0 自定义域名时，Management API 和它的 audience 仍在租户的默认域名上，所以这样的部署必须设置 `OAUTH_MANAGEMENT_DOMAIN`，否则重发验证邮件会失败。
- 失败时用户只会回到 `verify` 页，原因记在 Gateway 日志里，见「Gateway 日志」。

### 部署前先检查

1. **重复用户。** 导出 Auth0 的全部用户，按小写邮箱分组，找出同一邮箱下有两个或更多 `email_verified` 为 `true` 的用户。部署时还没有用户带 `eigos_since`，所以这些用户按创建时间排：较新的用户下次登录 EIGOS（刷新令牌换新除外）时，被并入最早创建、门户能登录的那个用户，之后 owner 由那个用户决定。owner 按 `digest([issuer, tenant, sub])` 计算，已有数据不迁移，所以较新用户名下的 EIGOS 数据在合并后不能再访问。没处理的用户里，谁先拿到 EIGOS 的 claim（包括用刷新令牌换新），谁就先记上 `eigos_since`，排到前面。逐组处理：
   - 较新用户没有要保留的 EIGOS 数据：不用处理，交给 Action。
   - 较新用户有要保留的数据：部署 Action 之前，给它写上 `eigos_since`，做法见「写 `eigos_since`」。带 `eigos_since` 的用户排在没有的前面，所以较早创建的那个用户下次登录 EIGOS 时，是它并入较新的这个用户，较新用户的数据不动。
   - 两个用户都有要保留的数据：由运营者决定保留哪一个，给它写上 `eigos_since`。另一个的数据合并后访问不到。
   - 有 EIGOS 数据的会员（升级前是 `member_accounts` 里的 owner），同邮箱下还有一个创建得比它早、邮箱没验证、门户能登录的用户，通常是密码用户。这样的组要另外查，因为同邮箱已验证的用户只有会员一个，上面的分组找不到它。部署 Action 之前二选一：给这个会员写上 `eigos_since`（做法见「写 `eigos_since`」），或者删掉那个没验证的用户（删之前先确认没有人在用它）。不处理的话，那个用户一验证邮箱，就因为创建得早，排到还没有 `eigos_since` 的会员前面，它先登录 EIGOS 的话还先拿到 `eigos_since`。会员下次登录 EIGOS 时被并入它，会员名下的 EIGOS 数据在合并后不能再访问。
   - 邮箱只有大小写不同的重复用户：Action 用 `users-by-email` 查重，它区分大小写，查不到这样的用户，所以不会合并它们（见「已知限制」）。要合并只能手动：调用 Management API 的 `POST /api/v2/users/{主用户的 user_id}/identities`，请求体是被并入用户的 `provider` 和 `user_id`（不带 provider 前缀），让有数据的那个做主用户。
2. **现有 tenant 映射。** 找到现有 Post-Login Actions 里写 tenant claim 的那一个，记下三个值：claim 名、读取的 `app_metadata` 键，以及用户没有这个键时得到的值。它们分别对应 Action 的 `TENANT_CLAIM`、`TENANT_METADATA_KEY` 和 `DEFAULT_TENANT`。
3. **保留现有的 Post-Login Actions。** 不要删除或改动其他应用的 Actions 和客户端授权。tenant 只从受管理的 `app_metadata` 取，不从邮箱、用户提交的内容或用户可编辑的 `user_metadata` 取。

### 写 `eigos_since`

给有 EIGOS 数据的用户写 `app_metadata.eigos_since`，用 Management API 的一个 PATCH。令牌用 Management 应用的 client credentials 换，audience 是 `https://<域名>/api/v2/`。`<域名>` 是租户的默认 Auth0 域名，和 Action 的 `MANAGEMENT_DOMAIN` 相同。

```http
PATCH https://<域名>/api/v2/users/<user_id>
Authorization: Bearer <Management API 令牌>
Content-Type: application/json

{ "app_metadata": { "eigos_since": "2026-11-18T09:00:00.000Z" } }
```

- `<user_id>` 是要保留数据的那个 Auth0 用户，例如 `auth0|abc123`。放进地址时，`|` 要编码成 `%7C`。
- 时间写做这件事时的当前时间，ISO 8601、UTC，格式同上。Action 读不出时间的值，等于没有写。
- PATCH 只合并 `app_metadata` 的顶层键，其他键（例如 tenant）不动。
- 写了以后，这个用户排在所有没有 `eigos_since` 的用户前面。之后才拿到 EIGOS claim 的用户，时间都晚于它。
- 这是 Auth0 租户上的改动，要先取得授权，见「需要授权的操作」。

### Post-Login Action

Action 的源码是 `deploy/auth0/post-login.cjs`，CommonJS，不依赖 npm 包。

1. 在 Auth0 创建自定义 Action，触发器选 Login / Post Login，运行时选 Node 22，把文件内容贴进去。
2. 配置下表全部 secrets。除 `TENANT_CLAIM` 和 `TENANT_METADATA_KEY` 外都必填，逗号分隔的列表不能为空。缺少时 Action 会抛错，登录会失败；缺 `EIGOS_AUDIENCES` 或 `EIGOS_CLIENT_IDS` 时，Action 分不出哪些是 EIGOS 的登录，所有应用的登录都会失败。所以先配好再部署。
3. 部署，并放进登录流程。

| Secret | 填什么 |
| --- | --- |
| `EIGOS_AUDIENCES` | 逗号分隔的 EIGOS API identifier，现在只填给自助账号用的 MCP audience `https://<gateway>/mcp`。邮箱未验证的用户拿不到它的令牌，它的 access token 由这个 Action 写入 tenant claim。主 audience（`OAUTH_AUDIENCE`）不列：这个 Action 不会对它拒绝邮箱未验证的用户，也不会往它的 access token 写 tenant claim。它的 tenant 映射仍由现有的 Post-Login Action 负责，所以要保留（见「部署前先检查」第 3 步）。以后接入 A2A 时，会再加上它自己的 audience。 |
| `EIGOS_CLIENT_IDS` | 逗号分隔的 EIGOS 应用的 client ID：门户（`OAUTH_MEMBER_CLIENT_ID`）和 Grok（`OAUTH_MEMBER_MCP_CLIENT_ID`），以后接入的 EIGOS 客户端也加在这里。不要填 `OAUTH_EXISTING_CLIENT_IDS` 里运营和 PA 的客户端：它们用主 audience，tenant 映射由现有的 Action 负责。 |
| `EIGOS_CONNECTIONS` | 逗号分隔的、门户能登录的连接，例如 `Username-Password-Authentication,google-oauth2`，和「应用和连接」里对门户启用的连接一致。只有在这些连接上有身份的用户才能做主用户，因为合并页要让用户用这个连接再登录一次。 |
| `TENANT_CLAIM` | 令牌里的 tenant claim 名，默认 `tenant_id`。必须和 Gateway 的 `OAUTH_TENANT_CLAIM` 完全相同。 |
| `TENANT_METADATA_KEY` | 用户 `app_metadata` 里保存 tenant 的键，默认 `tenant_id`。必须和现有 tenant 映射读取的键相同。 |
| `DEFAULT_TENANT` | 用户没有受管理的 tenant 时得到的值，Action 同时把它写回该用户的 `app_metadata`。新注册的用户也得到这个值。 |
| `LINK_URL` | `https://<gateway>/account/link`。 |
| `LINK_SECRET` | 必须和 Gateway 的 `EIGOS_ACCOUNT_LINK_SECRET` 相同。 |
| `MANAGEMENT_DOMAIN` | 租户的默认 Auth0 域名，不带 `https://`，例如 `<tenant>.<region>.auth0.com`。租户用自定义域名时，Management API 也在默认域名上。和 Gateway 的 `OAUTH_MANAGEMENT_DOMAIN` 指同一个域名。 |
| `MANAGEMENT_CLIENT_ID`、`MANAGEMENT_CLIENT_SECRET` | Management 应用的凭据。 |

`DEFAULT_TENANT` 必须等于现有用户（没有受管理 tenant 字段的）现在得到的 tenant 值，否则这些用户的 owner 会变，找不到原来的数据。用「部署前先检查」第 2 步记下的值。值写回用户之后，再改 `DEFAULT_TENANT` 只影响还没写回的用户。上线前后，用同一个现有用户的令牌调用 `GET /identity`，owner 应当不变。

Action 的行为：

- 它只处理 EIGOS 的登录：请求的 API 在 `EIGOS_AUDIENCES` 里，或者客户端在 `EIGOS_CLIENT_IDS` 里。租户里其他应用的登录，Action 原样放行：不写 `app_metadata`，不查重，不转去合并，也不写 claim。这些应用的 tenant claim 仍由现有的 Action 负责。
- 对 EIGOS 的登录，Action 做这几件事：
  1. 用户没有受管理的 tenant 时，把 `DEFAULT_TENANT` 写进该用户的 `app_metadata`。
  2. 没有被转去合并的登录，都往 ID Token 里写 tenant claim。已验证的用户第一次这样拿到 claim 时，再写上 `app_metadata.eigos_since`。
  3. 邮箱已验证、只有一个身份的用户，每次登录（刷新令牌换新除外）都调用一次 Management API 的 `users-by-email`，受速率限制约束。Management API 不可用或被限流时，Action 让这次 EIGOS 登录失败，不会跳过检查，其他应用的登录不受影响。缓存的 Management 令牌被拒绝（401）时，Action 丢掉它，换新令牌再试一次。
  4. 同一邮箱有排在这个用户前面的已验证用户，并且那个用户在 `EIGOS_CONNECTIONS` 里的某个连接上有身份时，这次登录被转到 EIGOS 的 `/account/link`。用户要用原来的方式再登录一次才能继续，合并没完成登录就被拒绝。`users-by-email` 跨所有连接查找，其他连接上的同邮箱用户被忽略。
- 合并虽然只由 EIGOS 的登录触发，结果却对整个租户生效，授权前要让用户知情：
  1. 被并入的用户不再单独存在。其他应用看到的是原来那个用户的 `user_id`，按被并入用户的 `user_id` 存的数据对不上了。
  2. 被并入的登录方式以后在所有应用里都登录成原来那个用户。
  3. `eigos_since` 和 `DEFAULT_TENANT` 写在 `app_metadata` 里，其他应用的 Actions 也读得到。
- 合并时 Action 和账号页的分工：
  1. 找到排在当前用户前面的已验证用户时，Action 暂停登录，转到 `LINK_URL`，这时不写 tenant claim。
  2. 用户在合并页用原来的方式再登录。
  3. 账号页确认这次登录是原来的那个已验证账号，撤销这个账号的 Grok 授权，然后显示「继续」按钮。用户点「继续」，浏览器用 POST 把 `session_token` 送到 `<OAUTH_ISSUER>continue?state=<暂停登录的 state>`。`session_token` 是用 `EIGOS_ACCOUNT_LINK_SECRET` 签名的 HS256 JWT，claims 是 `sub`（被合并的用户）、`state` 和 `primary`（原来的用户），5 分钟有效。页面不运行脚本，所以要用户点一下。
  4. Auth0 继续登录。Action 按暂停时的规则再核对一遍原来的用户：已验证，邮箱相同，在 `EIGOS_CONNECTIONS` 里的连接上有身份，排在当前用户前面。它还没有 `eigos_since` 时，Action 先通过 Management API 给它写上，再合并两个身份，把登录切换到原来的用户，最后写 claim。
  5. 合并没完成时登录被拒绝，用户看到提示「合并没有完成，请用原来的方式重新登录。」
  6. 被暂停的登录如果是从账号页发起的，Auth0 继续之后会回到账号页。账号页这时只接受原来那个用户的已验证登录，回来的是别人时不开会话，也不开户。

Action 出问题时，先把它从登录流程里移走，其他 Actions 不受影响。已经写回的 `app_metadata`（包括 `eigos_since`）和已经合并的用户不会撤销。

合并流程参考 Auth0 的[账号合并](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/link-user-accounts)和[服务端建议合并流程](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/suggested-account-linking-server-side-implementation)。

### 已知限制

- 重复用户检查调用 Auth0 的 `users-by-email`，它区分邮箱大小写。邮箱只有大小写不同的两个用户查不到对方，Action 不会自动合并它们。
- 合并请求不带 `connection_id`，只在租户只有一个 `auth0` 数据库连接时可靠。
- 合并时撤销的只是 EIGOS 这边的 Grok 授权。合并之前连接到这个账号的 Agent，在 Auth0 那里还有 refresh token：用户重新授权 Grok 之后，它换来的新令牌也会被 Gateway 接受。`invite` 模式也挡不住这一点，因为 refresh token 由 Auth0 发，和 Gateway 开不开户无关。撤销连接或完成合并时，一并撤销 Auth0 里这个用户的授权记录和 refresh token，是设计文档第 4 步的必做项（第 6.4 节），也是开放注册的前提之一，见「开户模式」。

## Gateway 环境变量

Gateway 在 `.env` 或部署环境里配置，示例见 `.env.example`。secret 只放在部署环境和 Auth0 的 Action secrets 里，不进仓库。

| 变量 | 说明 |
| --- | --- |
| `OAUTH_MEMBER_CLIENT_ID`、`OAUTH_MEMBER_CLIENT_SECRET` | 门户应用。 |
| `OAUTH_MEMBER_MCP_CLIENT_ID` | Grok 公共客户端。 |
| `OAUTH_EXISTING_CLIENT_IDS` | 逗号分隔的现有运营和 PA 客户端。先核对所有仍在使用的客户端 ID。启用后，既有客户端须持原 audience 的有效令牌，且 owner 仍须有既有 Eigos 定义授权。 |
| `OAUTH_TENANT_CLAIM` | tenant claim 名，默认 `tenant_id`，必须和 Action 的 `TENANT_CLAIM` 相同。 |
| `EIGOS_SIGNUP` | 开户模式为 `invite`（默认）、`closed` 或 `open`。正式环境显式设为 `invite` 或 `closed`。 |
| `EIGOS_ENFORCE_OWNER_RLS` | 设为 `true` 开启 owner 隔离。`EIGOS_SIGNUP` 不是 `closed` 时必须设置。Gateway、Worker 和 Indexer 都要设置。 |
| `EIGOS_PORTAL_SECRET` | 至少 32 个字符，加密登录过程中的 Cookie。 |
| `EIGOS_ACCOUNT_LINK_SECRET` | 至少 32 个字符，必须和 Action 的 `LINK_SECRET` 相同，且不能和 `EIGOS_PORTAL_SECRET` 相同。 |
| `OAUTH_MANAGEMENT_CLIENT_ID`、`OAUTH_MANAGEMENT_CLIENT_SECRET` | 可选，要么都配，要么都不配。配了，账号页才有重发验证邮件的按钮。`OAUTH_ISSUER` 是 Auth0 自定义域名时，还要设置 `OAUTH_MANAGEMENT_DOMAIN`。 |
| `OAUTH_MANAGEMENT_DOMAIN` | 可选。租户的默认 Auth0 域名，写成小写的纯主机名，例如 `dev-abc.us.auth0.com`，不带 `https://`、端口、路径和结尾的点，格式不对时 Gateway 拒绝启动。设置后，Management 令牌请求、audience 和验证邮件任务都发往它，不设置时发往 `OAUTH_ISSUER`。`OAUTH_ISSUER` 是 Auth0 自定义域名的部署必须设置，否则重发验证邮件失败。没有配置 `OAUTH_MANAGEMENT_CLIENT_ID` 和 `OAUTH_MANAGEMENT_CLIENT_SECRET` 时，这个变量被忽略。 |
| `EIGOS_TRUST_PROXY` | 只在可信的反向代理后面设置，见下。 |

`OAUTH_MEMBER_CLIENT_ID`、`OAUTH_MEMBER_CLIENT_SECRET`、`OAUTH_MEMBER_MCP_CLIENT_ID` 和 `OAUTH_EXISTING_CLIENT_IDS` 只要配了一个，Gateway 就要求这四个都配置。同时 `EIGOS_PORTAL_SECRET` 和 `EIGOS_ACCOUNT_LINK_SECRET` 也必须配置，即使 `EIGOS_SIGNUP=closed`。此外要求：

- `EIGOS_AUTH_MODE` 是 `jwt`。
- `OAUTH_ISSUER` 是以 `/` 结尾的 `https://` 租户地址，`OAUTH_JWKS_URL` 与它同源。
- `PUBLIC_URL` 是不带路径和结尾斜杠的 `https://` 地址。
- 门户、Grok 和现有客户端的 ID 互不相同。

任何一项不满足，Gateway 都拒绝启动。

Worker 启动时也读同一份配置，做同样的检查。Worker 和 Gateway 共用一份环境时，Worker 同样需要 `EIGOS_PORTAL_SECRET` 和 `EIGOS_ACCOUNT_LINK_SECRET`，`EIGOS_SIGNUP` 不是 `closed` 时还需要 `EIGOS_ENFORCE_OWNER_RLS=true`；设置了 `EIGOS_TRUST_PROXY` 时，它的值也要合法。缺了或不合法，Worker 同样启动失败。Indexer 不做这些检查，不过 `EIGOS_ENFORCE_OWNER_RLS` 它也要设置。

两个 secret 各生成一个随机值，例如 `openssl rand -hex 32`。多个 Gateway 实例使用相同的两个 secret，登录状态放在加密 Cookie 里，不依赖某个实例的内存。轮换 `EIGOS_ACCOUNT_LINK_SECRET` 时同时更新 Action 的 `LINK_SECRET`。

`EIGOS_TRUST_PROXY` 只在 Gateway 前面有可信的反向代理，并且这个代理会覆盖客户端发来的 `X-Forwarded-*` 头时设置。

- 只接受两类值：
  - 代理的跳数，例如 `1`，只能单独写；
  - 用逗号分隔的列表，每一项是预设名（`loopback`、`linklocal` 或 `uniquelocal`）、代理地址或 CIDR，例如 `loopback, 10.0.0.0/8`。CIDR 的前缀 IPv4 是 1 到 32，IPv6 是 1 到 128，`/0` 等于信任所有地址，不接受。

  其他写法，包括 `true`、`false`、`yes` 和空值，都让 Gateway 和 Worker 启动失败，错误信息里写明 `EIGOS_TRUST_PROXY`。
- 设置后，Express 不只从 `X-Forwarded-For` 取客户端地址，也从 `X-Forwarded-Host` 和 `X-Forwarded-Proto` 取 `req.hostname` 和 `req.protocol`。Gateway 的 Host 检查用的就是 `req.hostname`。代理没有覆盖这些头时，客户端可以伪造地址绕过限流，也可以伪造主机名。
- 账号页的限流按真实客户端地址分别计数。不设置时，限流按连接地址计数，代理后面的所有用户共用一个额度。
- 「同一客户端地址」对 IPv4 是同一个地址。IPv6 的客户端通常拿到整个 /64 网段，可以随意换网段里的地址，所以按 /64 前缀计数。写成 IPv4 映射形式的地址（`::ffff:198.51.100.1`）按它对应的 IPv4 地址计数。
- Gateway 直接暴露在公网时不要设置。
- 限流计数在每个 Gateway 进程内，多个实例各算各的。

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
| `account_applications` | SELECT、INSERT、UPDATE（邮箱、用途和申请时间） | 无 |

对应的语句如下，`<schema>` 是 `EIGOS_PG_SCHEMA`：

```sql
GRANT SELECT ON <schema>.accounts TO <gateway_role>, <worker_role>;
GRANT INSERT (owner, email_hash), UPDATE (approved_at, revoked_at, email_hash)
  ON <schema>.accounts TO <gateway_role>;
GRANT SELECT ON <schema>.member_invitations TO <gateway_role>;
GRANT UPDATE (redeemed_by) ON <schema>.member_invitations TO <gateway_role>;
GRANT SELECT, INSERT, DELETE ON <schema>.member_sessions TO <gateway_role>;
GRANT SELECT, INSERT ON <schema>.account_applications TO <gateway_role>;
GRANT UPDATE (email_hash, email, purpose, applied_at) ON <schema>.account_applications TO <gateway_role>;
```

升级已有部署时，`member_invitations` 和 `member_sessions` 的权限和以前一样。`accounts` 沿用 `member_accounts` 原有的权限，新增的只有 `email_hash` 的 INSERT 和 UPDATE。重复授予无害。

Gateway 角色不授予 `status`、`suspended_at` 和 `suspended_reason` 的 UPDATE。停用和恢复账号用管理角色执行运营者命令。邀请码也只由管理角色写入。会话令牌和邀请码只保存摘要。用户提交申请时，申请表保存用于审核和发码的邮箱及用途，运营通过私有终端读取。

### 回退

回退到已有 `/account` 的版本时，暂停开户，核对升级以来的申请和发码。旧版仅按邮箱验证邀请码。先让新增且尚未兑换的邀请失效，再按需要重新发码。已激活账号的 Grok 授权和共享能力仍由原表提供。下面是回退到早期 `/members` 版本的步骤。

旧版本读 `member_accounts` 和旧组 `group:eigos-member-queries` 的授权，这两样 `db:upgrade` 都改了，所以升级之后旧版本不能直接启动。从第 1 步的备份恢复，会丢掉升级之后写入的数据。要保留这些数据，用反向 SQL 退回：

1. 停止新版本的 Gateway 和 Worker，运行了 Indexer 的也一起停。
2. 把 Action 从登录流程里移走。旧版本的门户回调是 `/members/callback`，已经从门户应用删除的，先加回去。
3. 用管理角色执行下面的语句，`<schema>` 是 `EIGOS_PG_SCHEMA`。`UPDATE` 那一句是可选的：旧版本没有停用这回事，先撤销停用账号的 Grok 授权，旧版本就仍然拒绝它们的令牌。

   ```sql
   BEGIN;
   UPDATE <schema>.accounts SET revoked_at=now()
     WHERE status='suspended' AND approved_at IS NOT NULL AND revoked_at IS NULL;
   ALTER TABLE <schema>.accounts RENAME TO member_accounts;
   INSERT INTO <schema>.resource_grants(subject,resource,permission)
     SELECT 'group:eigos-member-queries',resource,permission FROM <schema>.resource_grants
     WHERE subject='group:eigos-accounts'
     ON CONFLICT DO NOTHING;
   DELETE FROM <schema>.resource_grants WHERE subject='group:eigos-accounts';
   COMMIT;
   ```

4. 换回旧版本的环境变量，启动旧版本。

说明：

- 升级之后写入的数据都留在改回名字的表里：自助开通的账号，新的授权和撤销时间，以及 `status`、`suspended_at`、`suspended_reason`、`email_hash` 这几列。旧版本不认识这几列，照常运行。自助开通的账号在旧版本里就是会员。
- 移回旧组的是升级之后的那份授权。升级之后发布或激活过业务 Ontology 的，它已经是全部业务授权，不是旧组原来那份。要恢复原来那份，从第 1 步的备份里取回 `group:eigos-member-queries` 的行，或者用 `access:configure` 重新配置。
- 新列、约束 `accounts_status_check` 和索引 `accounts_email` 可以留着。以后再升级，`db:upgrade` 会再改一次名，已经有的不会重复添加。运行角色的权限跟着表走，改名不影响。
- Auth0 里已经合并的用户，以及已经写进 `app_metadata` 的 tenant 和 `eigos_since`，都不会撤销。

## 运营者命令

这些命令用管理角色的 `DATABASE_URL`（`.env` 或环境变量）运行，不用 Gateway 的运行角色。

| 命令 | 作用 |
| --- | --- |
| `npm run account -- show <owner\|email>` | 查看账号，输出 JSON：`owner`、`status`、`activatedAt`、`approvedAt`、`revokedAt`、`suspendedAt`、`suspendedReason`。 |
| `npm run account -- suspend <owner\|email> <理由…>` | 停用账号。理由 1 至 200 个字符，可以写多个词。 |
| `npm run account -- restore <owner\|email>` | 恢复停用的账号。 |
| `npm run account -- applications [offset]` | 查看申请的邮箱、用途、owner 和邀请有效期，每次最多 100 条。 |
| `npm run account:invite -- <owner\|email> [小时]` | 为该申请签发一次性邀请码，默认 48 小时，可设 1 至 168 小时。 |
| `npm run access:grant-business -- <owner>` | 把指定 owner 名下的全部授权，整体替换成当前定义的业务授权，不是追加。以后新增的能力不会自动加上。只对不走账号路径的 owner 有意义，例如运营者或本地开发身份 `local-developer`；账号的授权由 `group:eigos-accounts` 决定。对持有 `manage_definition` 的运营者或发布者（默认是 `deployment`，可用 `EIGOS_PUBLISHER_SUBJECT` 改）执行，会撤掉它的 `manage_definition`。 |

- `<owner|email>`：64 位十六进制按 owner 查找，否则当作邮箱，不区分大小写。按邮箱查找要求账号已经记录邮箱摘要，升级前开通的账号在升级后第一次登录账号页时补上。同一邮箱有多个账号时取最近开通的一个，要精确就用 owner。
- 停用后，Gateway 立即拒绝这个账号的令牌。用这个账号身份加载的授权不再包含 `group:eigos-accounts`，已排队的任务在 Worker 执行时也会被拒绝。账号页显示「这个账号已停用，请联系 EIGOS 支持。」，也不能再授权 Grok。恢复后一切照旧，Grok 授权状态不变。
- 重复运行同一条 `suspend` 或 `restore` 不报错，输出当前状态。
- `account:invite` 输出的邀请码由运营逐个交给申请人。匹配到多个身份时用申请的 owner 发码。重发会让该申请之前未兑换的码失效。

旧命令已经删除，没有保留别名：

| 旧命令 | 现在用 |
| --- | --- |
| `npm run access:invite-member -- <email> [小时]` | `npm run account:invite -- <owner\|email> [小时]` |
| `npm run access:grant-member -- <owner>` | `npm run access:grant-business -- <owner>` |

### 账号组

Beta 账号开通并授权 Grok 后，自动使用 `group:eigos-accounts` 的统一业务能力。账号令牌和 Worker 任务加载这个组的资源授权。

- **资源授权没有作用。** `access:configure` 的 JSON 里 `subjects[].grants` 给账号 owner 写的资源授权，以及 `access:grant-business` 写给它的业务授权，对它的 Grok 访问都不起作用。目前没有只对某一个账号增减资源授权的办法。
- **`memberships` 照常按 owner 生效。** `access:configure` 的 JSON 里 `memberships`（给 owner 配的组和标记，对象策略用）仍然按 owner 读取，对账号同样有效。memberships 里的组只影响对象策略，账号不会因加入某个组而得到该组的资源授权。

同步规则：

- 只有运营者命令会同步这个组。`npm run ontology:publish` 和 `npm run ontology:activate -- <release>` 成功后，如果激活的是业务 Ontology（`Eigos`），这个组的授权被整组替换为当前定义的业务授权。其他 Ontology（例如公共地点）的发布和激活不改动这个组，`ontology:prepare` 也不同步。
- 业务授权包括：`Eigos` 的 `view_definition`，业务对象的 `view_objects`，业务 Function 的 `execute_function`，业务 Action 的 `apply_action`，以及这些 Function 用到的来源的 `read_source`。不含 `edit_definition` 和 `manage_definition`。沙箱资源只在 `EIGOS_AGENT_SANDBOX_ENABLED=true` 的本地开发环境里包含。
- 整组替换意味着手工写在这个组上的授权，会在下一次发布或激活时被覆盖。不要再用 `access:configure` 配置 `group:eigos-accounts`。旧组 `group:eigos-member-queries` 不再使用，`db:upgrade` 把它的授权移到新组。
- 升级后，新组先保留从旧组迁来的授权，直到下一次发布或激活才换成业务授权。要马上同步，对当前生效的 release 再运行一次 `npm run ontology:activate -- <release>`。整组替换会把旧组受限的授权扩大到全部业务能力：所有业务 Function 和 Action（包括 `apply_action`），以及这些 Function 用到的全部来源。旧组原来只给了一部分能力的部署，要在授权时让用户确认，见「需要授权的操作」。
- **分支提案合并之后，运营者要再同步一次。** 提案的 `merge` 在运行角色下激活新版本，运行角色不能写授权表，所以 `merge` 不同步这个组，也不改任何授权行。合并之后，用管理角色运行 `npm run ontology:activate -- <release>`，`<release>` 是 `merge` 返回的 `release`。对已经生效的 release 再激活是允许的。合并到这次激活之间，账号拿不到新版本新增的业务能力的授权。

确认同步，用两条查询，`<schema>` 是 `EIGOS_PG_SCHEMA`：

```sql
SELECT release FROM <schema>.ontology WHERE id='Eigos';
SELECT count(*) FROM <schema>.resource_grants WHERE subject='group:eigos-accounts';
```

- 第一条给出业务 Ontology 当前的 release，就是 `ontology:activate` 要用的 `<release>`。`ontology` 表里每个 Ontology 各有一行，必须带 `WHERE id='Eigos'`。拿别的 Ontology（例如公共地点）的 release 运行 `ontology:activate`，命令照常成功，但会静默跳过这个组的同步。
- 第二条是这个组现有的授权条数，0 表示还没同步过。运行 `ontology:activate` 之后，它应当等于当前定义的业务授权条数。分支合并新增了能力，或升级换掉了旧组的授权时，同步前后的条数通常不同，可以用它看同步有没有发生。`ontology:activate` 的输出里没有同步结果，只能这样查。

账号需要读取某个来源时，仍要给该 owner 配置有效期明确的来源绑定，见 [供应商连接](service-planning.md#供应商连接)。账号无需提供供应商账号凭据。授权范围延续现有 Ontology 权限实现，参考 [Palantir 应用权限](https://www.palantir.com/docs/foundry/developer-console/permissions)。

## 账号页和 Gateway 的提示

### 路由和 Cookie

| 路由 | 说明 |
| --- | --- |
| GET `/account` | 账号页，没有限流。 |
| GET `/account/login`、`/account/callback`、`/account/link`、`/account/link/continue` | 登录、回调和合并页。同一客户端地址（IP）每分钟合计最多 20 次。 |
| POST `/account/apply`、`/account/activate`、`/account/approve`、`/account/revoke`、`/account/logout` | 账号页的表单。需要会话，没有会话返回 401。同一客户端地址（IP）每分钟合计最多 30 次。 |
| POST `/account/resend-verification` | 重发验证邮件，只在配置了 `OAUTH_MANAGEMENT_CLIENT_ID` 和 `OAUTH_MANAGEMENT_CLIENT_SECRET` 时存在。不需要会话。同一客户端地址（IP）每小时最多 5 次，见「重发验证邮件」。 |

超过限制返回 429 和 `Retry-After`。三组限流各算各的，互不占用额度。「同一客户端地址」对 IPv6 指同一个 /64 前缀，见「Gateway 环境变量」。

合并的第二次登录成功时，`/account/callback` 不跳转，而是返回带「继续」按钮的页面，按钮把 `session_token` POST 给 Auth0。这个页面的 CSP 只允许表单提交到 Gateway 自己和 `OAUTH_ISSUER` 的源：浏览器还会检查 Auth0 回应这个 POST 的重定向，它指回 `/account/callback`。页面的 `Referrer-Policy` 是 `strict-origin`，Auth0 只看到 Gateway 的源，看不到带授权码的地址。

所有表单都要带 `Origin`，并且等于 `PUBLIC_URL`。没有 `Origin` 头时，账号页返回 403 和「请回到账号页重新提交。」。`Origin` 头不是 `PUBLIC_URL` 时，Gateway 对所有请求先返回 403 `{"error":"Origin is not permitted"}`。请求的主机名不是 `PUBLIC_URL` 的主机名时，Gateway 返回 403 `{"error":"Host is not configured"}`。反向代理转发时，`Host`（设置了 `EIGOS_TRUST_PROXY` 时是 `X-Forwarded-Host`）要保持 `PUBLIC_URL` 的主机名，也不要改写 `Origin`。

Cookie 都带 `__Host-` 前缀，只能通过 HTTPS 使用。

| Cookie | 内容 | 有效期 |
| --- | --- | --- |
| `__Host-eigos-account` | 账号会话 | 8 小时 |
| `__Host-eigos-account-login` | 登录过程的 state、nonce 和 PKCE verifier，加密。合并完成后交回的那次登录，还带着原来那个账号 | 5 分钟 |
| `__Host-eigos-account-link` | 合并过程的上下文，加密 | 5 分钟 |
| `__Host-eigos-account-verify` | 等待验证邮箱的用户，加密 | 10 分钟 |

### 账号页提示

账号页用 `/account?status=<值>` 显示提示。

| `status` | 含义和处理 |
| --- | --- |
| `login` | 登录没有完成：登录 Cookie 过期、被改动或已用过，`state` 对不上，或 code、ID Token 校验失败。用户重新登录。到了 Auth0 那一步才失败的，Gateway 日志里有一行原因，见「Gateway 日志」。 |
| `verify` | 邮箱还没验证。用户验证后重新登录。 |
| `tenant` | ID Token 没有 tenant claim。检查 Action 是否已部署并放进登录流程，`TENANT_CLAIM` 是否等于 `OAUTH_TENANT_CLAIM`，`DEFAULT_TENANT` 是否已设置。 |
| `closed` | `EIGOS_SIGNUP=closed`，目前暂停注册新账号。 |
| `invite` | 邀请码无效、已过期，或和已验证的邮箱不一致。重新发一个邀请码。 |
| `application` | 申请未提交。核对申请使用的邮箱和用途。 |
| `operator` | 这是运营者账号，不需要开通，继续使用原来的客户端。 |
| `link` | 合并没有完成：`session_token` 无效或已过期，合并 Cookie 过期，第二次登录的不是原来的账号，或者 Auth0 继续登录之后回来的不是原来的账号。用户用原来的方式重新登录。仍失败时检查 Action 日志，以及 `LINK_SECRET` 和 `EIGOS_ACCOUNT_LINK_SECRET` 是否相同。 |
| `resent` | 验证邮件已重新发送。 |

### Gateway 返回 403

账号令牌被拒绝时，Gateway 返回 403 和 JSON `{ "error": "…", "reason": "…", "account": "/account" }`。`error` 是给机器客户端看的英文，`reason` 是稳定的代码。

Gateway 按下表的顺序检查，第一个不通过的就是返回的 `reason`：账号是否存在或能否开户，是否停用，客户端和 audience，是否已授权，scope，最后才是请求的路径。所以前面几项都通过、只是 scope 不够的令牌，不论访问哪个路径，得到的都是 `insufficient_scope`，不会是路径的原因。

| `reason` | `error` | 含义和处理 |
| --- | --- | --- |
| `signup_closed` | `EIGOS sign-up is closed` | `closed` 模式，账号不存在。要开放注册，改 `EIGOS_SIGNUP`。 |
| `invite_required` | `Redeem an EIGOS invitation on the account page first` | `invite` 模式，账号还没开通。发邀请码。 |
| `operator_account` | `Operator accounts use their existing client` | 这个 owner 有 `Eigos` 定义授权，是运营者。继续使用原来的客户端令牌。 |
| `account_suspended` | `This EIGOS account is suspended` | 账号已停用。运营者确认后 `npm run account -- restore`。 |
| `client_not_allowed` | `This client is not allowed for EIGOS accounts` | 令牌不是 Grok 公共客户端（`OAUTH_MEMBER_MCP_CLIENT_ID`）为 MCP audience 签发的，也不是运营者用原有客户端签发的。令牌本身合格时，访问 `/mcp` 和 `/identity` 以外的路径也是这个原因：账号令牌只能用这两个路径。 |
| `client_not_authorized` | `Authorize this client on the EIGOS account page` | 账号还没授权 Grok，授权已撤销，或令牌签发在最近一次授权之前。用户先在账号页授权，再在 Grok 里（重新）连接，用重新签发的令牌。 |
| `insufficient_scope` | `The token is missing tasks:read or tasks:write` | 令牌缺 `tasks:read` 或 `tasks:write`。响应头 `WWW-Authenticate` 是 `Bearer error="insufficient_scope", scope="tasks:read tasks:write", resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"`。检查 Auth0 API 的 scopes 和 Grok 客户端的授权。 |

### Gateway 日志

账号门户把两种失败写到 Gateway 的标准错误输出，每次一行：

| 日志行 | 什么时候出现 |
| --- | --- |
| `EIGOS account: sign-in could not be completed: <原因>` | 登录回调已经到了和 Auth0 交换授权码这一步，没有成功。用户看到 `?status=login`。 |
| `EIGOS account: verification email resend failed: <原因>` | 重发验证邮件失败。用户回到 `verify` 页，看不到原因。 |

`<原因>` 是固定的短句，或者错误的类名。常见的有：

- 登录：`Identity provider rejected the authorization code`（Auth0 不认这个授权码）、`Identity token did not match this login`、`unexpected "aud" claim value`、`signature verification failed`、`"exp" claim timestamp check failed`、`ZodError`（Auth0 的回答里没有 ID Token，或邮箱格式不对）、`SyntaxError`（回答不是 JSON）。
- 重发：`Auth0 token request failed with status <HTTP 状态>`、`Auth0 verification email request failed with status <HTTP 状态>`、`Auth0 token answer is not usable`。
- 两种都可能出现：`fetch failed`（连不上 Auth0）、`TimeoutError`（10 秒内没有回答）。

日志里没有授权码、令牌、用户标识和邮箱。`<原因>` 最长 200 个字符，没有换行，整行比这多出固定的前缀。

下面这些不是故障：

- 授权码只能用一次，也有有效期。回调被重放（例如浏览器重复发出同一个请求），或者 code 已过期时，Auth0 拒绝它，Gateway 记一行 `sign-in could not be completed: Identity provider rejected the authorization code`。用户重新登录即可。
- 登录 Cookie 缺失或过期、`state` 对不上、没有 code 的请求，在到达 Auth0 之前就被拒绝。用户同样看到 `?status=login`，但 Gateway 不记日志。
- 邮箱没验证（`?status=verify`）是登录的结果，不是失败，不记日志。

如果每次登录都是 `Identity provider rejected the authorization code`，常见原因是门户应用的 client secret（`OAUTH_MEMBER_CLIENT_SECRET`）、令牌端点认证方式（`client_secret_post`）或回调地址不对。如果重发总是失败，常见原因是 Management 应用的凭据不对、没有被授权使用 Auth0 Management API 或缺少 `update:users`，以及自定义域名的部署没有设置 `OAUTH_MANAGEMENT_DOMAIN`。

## 验收

验收只做真实查询和 synthetic 执行，不写外部日历，不真实报名、下单或付款。验收前给测试 owner 配置有效期明确的 [FlyAI trial 来源绑定](service-planning.md#供应商连接)。每一项记录结果和标识，不记录令牌、邮箱、验证链接或任何凭据。

全程使用 `invite`。每个测试账号独立申请、兑换邀请码和授权 Grok。

1. 用新 Google 账号注册并提交申请。运营在 `applications` 查到申请后单独发码。兑换后 `account show` 返回 `active`。
2. 用新邮箱加密码注册。验证前只看到验证提示。验证后，使用其他邮箱的申请应被拒绝。使用已验证邮箱申请后，另一个账号无法兑换该申请的码，重发后旧码失效。
3. 用同一个邮箱换另一种方式登录，按合并页提示用原来的方式登录。合并后仍使用原 owner，原来授权过 Grok 的账号显示「重新授权 Grok」。
4. 先在账号页授权 Grok，再在 Grok Bot 里添加连接并问一次只读航班查询。用原 `taskId` 读回结果，结果带来源证据，并在同一对话交付。
5. 撤销 Grok 授权后，请求被 Gateway 拒绝，返回 403，`reason` 是 `client_not_authorized`。重新授权后，在 Grok 里重新连接，新签发的令牌可用，重新授权之前签发的令牌仍被拒绝。
6. 停用账号后请求返回 403，`reason` 是 `account_suspended`。恢复后可用。
7. 两个受邀账号分别运行同一项 Beta 查询，验证各自读回自己的结果。交叉读取对方的任务应返回不可访问。

合并要在真实租户上多核对下面几点，结果写进验收记录：

- **Auth0 接受用 POST 送回的继续令牌。** 账号页的「继续」按钮把 `session_token` 放在请求体里，POST 到 Auth0 的 `continue?state=<state>`。`session_token` 的 claims 是 `sub`、`state`、`primary`，HS256 签名，5 分钟有效。确认 Auth0 接受这个 POST，Action 读到 `primary`，登录继续。
- **Action 自己发出的 `session_token` 不能直接用来继续。** 把 Action 转到 `/account/link` 时地址里带的 `session_token` 直接送到 Auth0 的 `continue?state=<state>`：Auth0 应当拒绝，登录不能继续。这个令牌里没有 `state`，而 Action 继续时要求有。
- **验证晚的账号不会抢走原来的账号。** 先用新邮箱加密码注册 A，先不验证。再用同一个邮箱的 Google 账号 B 登录账号页并开通。然后验证 A，用 A 登录：A 被转到合并页，要用 B 的方式登录才能合并。合并后 `show` 返回的 owner 仍是 B 的，B 名下的任务仍可读取。B 自己再登录，不会被转到合并页。
- **其他应用不受同邮箱用户影响。** 用租户里另一个应用（client ID 不在 `EIGOS_CLIENT_IDS` 里，也不请求 `EIGOS_AUDIENCES` 里的 API）登录一个有同邮箱已验证用户的身份：不会被转到 `/account/link`，`app_metadata` 里没有新写入的 `eigos_since`，令牌里的 tenant claim 仍由那个应用原有的 Action 决定。
- **暂停的登录是否绑定发起它的浏览器。** 把同一个表单（同样的 `state` 和 `session_token`）在另一个浏览器（或隐私窗口）里 POST 给 Auth0，看登录能否继续。预期不能继续；如果能，记为问题并报告。

以真实客户端验证 `401` 响应里的 `resource_metadata`、MCP 资源地址、Auth0 PKCE、精确回调、签名 JWT 的 audience、tenant claim、client ID 和 scopes。公开发现信息见 [MCP 授权规范](https://modelcontextprotocol.io/specification/latest/basic/authorization)，Auth0 的 resource 转换见 [Auth0 resource profile](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)，客户端入口见 [Grok Bot MCP](https://docs.x.ai/grok-bot/computer-and-apps)。
