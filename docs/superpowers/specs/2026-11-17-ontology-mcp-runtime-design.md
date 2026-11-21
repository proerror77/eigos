# Ontology MCP Runtime：自助注册与任意 Agent 接入

- 日期：2026-11-17
- 基线：`origin/main` `5a7aa8e6`
- 状态：已确认（2026-11-17）。第 1 步的计划见 `docs/superpowers/plans/2026-11-17-accounts-and-sign-up.md`
- 依据：见文末「参考资料」

## 1. 背景和目的

这次要做到三件事：

1. 客户用 Google 或邮箱通过 Auth0 自己注册，系统自动开通 EIGOS 账号。
2. 任何 AI Agent 都能通过 MCP 或 A2A 接入：可以直接用我们的 MCP，也可以把任务交给我们的 Agent。
3. Ontology MCP Runtime 按 Palantir 的 Ontology MCP 设计重新划分。

方向是：用户带着自己的 PA 来，EIGOS 负责统一的 Ontology、权限、执行，以及每个用户各自的服务记录。第二阶段的商户 Agent 网络（`docs/architecture/network-contract.md`）沿用同一套 Action、确认和收据。

现状（2026-11-17 评审）：

- **注册后用不了。** 来源绑定写在服务器的私有文件里，每个 owner 都要运维手工配置，有几个来源只认一个 owner。
- **只能接 Grok。** Gateway 只认 Grok 一个 MCP 客户端，A2A Agent Card 只声明了 Bearer。
- **澄清后卡死。** 会员只有 `submit_task` 和 `get_task`。任务一旦要求澄清，就一直停在 `input-required`，同一对话后面的任务也被挡住。
- **工具混在一起。** `/mcp` 同时列出 17 个固定工具和 101 个 `ontology_*` 服务。其中一半以上是分支、发布、Machinery 这类建模工具，而且不管有没有权限都会列出来。
- **下单由 PA 自己批准。** 外部承诺（例如飞猪下单）靠「PA 直接调用 Action，并带回已审核的条款摘要」算批准，也就是 `ctx.directAction` 加摘要比对。我们自己的 Agent 不能下单。

## 2. Palantir 依据和映射

| Palantir | 官方说明 | EIGOS 对应 |
|---|---|---|
| Ontology MCP | 给外部 Agent 用：查对象、调 Function、通过 Action 受控写数据；不能改结构 | `/mcp`，消费者 Ontology MCP |
| Palantir MCP | 给建模者用：改 Ontology 结构和数据管道；不能写 Ontology 数据 | `/mcp/builder`，建模 MCP，只给运营者 |
| Ontology MCP 的工具 | 每个 Action 一个写工具；一个对象查询工具；查询 Function 工具；AIP Logic 和 Agent 也可以作为工具 | 生成 `action_*` 和 `function_*`；`describe_ontology` 和 `query_ontology` 读对象；`submit_task` 等任务工具把 EIGOS Agent 当作工具 |
| 应用限制 | 令牌的权限 = 用户权限 ∩ 应用上限 ∩ 请求的操作范围 | 账号授权 ∩ 接入档案 ∩ 令牌 scope |
| OAuth | 授权码（用户委托）；client credentials（服务用户） | Auth0 授权码加 PKCE；client credentials 留给第二阶段的商户 Agent |
| Chatbot Studio 的 Action 工具 | 可设为自动执行，或用户确认后执行 | Action 类型声明 `confirmation`，用户在 EIGOS 确认页确认后才执行 |
| Action 的 writeback 和 side effect webhook | writeback 在编辑前执行，失败就不写入；side effect 在编辑后尽力执行 | 沿用 `ExternalOperations`（先记账再派发，结果不明时不自动重提交）和 `Effects` 队列，不改动 |

和 Palantir 不同的地方：

- Palantir 的 Ontology MCP 绑定一个 Developer Console 应用，以及这个应用预先注册的 OAuth 客户端。EIGOS 要让任何 Agent 都能接入，所以按 MCP 规范允许客户端自动注册（优先 CIMD，DCR 作后备），并给自动注册的客户端套上默认接入档案。
- Palantir 把「确认后执行」设在 Agent 的工具上。EIGOS 把它写在 Action 类型上，这样无论从 MCP、A2A、我们的 Agent 还是 Workflow 调用同一个 Action，规则都一样，接入档案也关不掉。
- 读对象这一块，Palantir 用 SQL 工具。EIGOS 沿用现有 `query_ontology` 的查询结构，不另做 SQL 层。

## 3. 目标、非目标、反目标

**目标**

1. 用 Google 或邮箱密码自助注册，邮箱验证后自动开通 EIGOS 账号。一个已验证邮箱只对应一个账号。
2. 注册完马上能用。来源连接存进数据库、按账号管理，不再改服务器文件。
3. 任何 MCP 客户端按 MCP 授权规范接入；任何 A2A 客户端按 Agent Card 上声明的 OAuth 接入。
4. 消费者 MCP 的工具由发布版本生成，每个用户只看到自己授权交集里的工具。
5. EIGOS 派发的每一笔外部承诺，都要用户本人在 EIGOS 确认页点确认。
6. 建模工具移到单独的入口，自动注册的客户端拿不到。
7. 顺带修掉评审里的问题：
   - 澄清后卡死；
   - 登录状态存在进程内存里；
   - 开放注册时不强制 RLS；
   - 撤销后无法恢复；
   - 报错含糊；
   - 「member」一词有两种意思。

**非目标**（这次不做）

- 额度内免确认（方案 B）。以后加在同一个确认点上。
- AP2 支付授权，这是 network contract 的第三阶段。
- 商户 Agent 网络，这是第二阶段。
- 更换 Worker 的模型凭据、提高 Worker 并发（见第 4 节第 5 条）。
- MCP 规范里还在实验阶段的 Tasks 机制。
- 每个来源各自的连接流程。这次只做通用框架，第一个示范来源是高德：用户贴上自己的 Web 服务 key。运营者现有的连接用文件导入。
- 由平台统一提供来源凭据。目前所有来源都由用户自己连接，平台提供以后再议。
- 把写死的酒店流程和高德地点修正改成 Action。相关工具先保留，改造另立任务。

**反目标**（功能跑通了，只要出现下面任何一条，也算失败）

- 有 Agent 不经用户在 EIGOS 页面点确认，就能下单、付款、订位或报名。
- 自动注册的客户端拿到了建模工具，或者能改 Ontology 结构。
- 一个用户看得到另一个用户的地点、店铺、来源绑定或任务。
- 为了接入另造一套执行引擎、权限系统或某个领域专用的协议（违反 AGENTS.md）。
- 注册成功后，用户不找运营者就什么都做不了（就是现在的状态）。
- 确认链接预先带着登录状态，或者 URL 里有个人信息。

## 4. 约束

1. **AGENTS.md。**
   - 先查 Palantir 官方文档，再映射到现有实现。
   - 复用发布模型、调用契约、权限和 Action 执行。
   - 开发验收只做真实查询和 synthetic 执行：不写外部日历，不真实报名、下单或付款。
2. **数据隔离。** 数据按 owner 分区。地点、店铺和供应商绑定不跨用户共享。任何跨用户的功能都要用户自己开启。
3. **MCP 授权规范 2025-11-25 的硬性要求。**
   - 服务端提供 Protected Resource Metadata。
   - `WWW-Authenticate` 带上 `resource_metadata` 和 `scope`。
   - PKCE 必须用 S256，请求必须带 `resource` 参数，服务端必须校验 audience，令牌不能转发给上游。
   - scope 不够时返回 403 `insufficient_scope`，让客户端补授权。
4. **Auth0。**
   - 自动 CIMD 注册还在 Early Access，每个租户最多 500 个。这类客户端算第三方应用（strict 模式，不支持 Rules）。DCR 作为后备。
   - 要让第三方客户端能用 Google 和邮箱登录，这两个连接都得提升到 domain level。
   - 要打开 Resource Parameter Compatibility Profile 和 Include Issuer in Authorization Responses。API 的 token dialect 设为 `rfc9068_profile_authz`。
   - 第三方客户端需要配置 API access policy。Auth0 对第三方客户端一定会显示授权同意页。
5. **Worker。**
   - 只有 1 个定时通道和 2 个交互通道，每个任务都单独启动一个模型进程。
   - 所有用户共用一个 ChatGPT 登录凭据，harness 目前只接受 `auth_mode: chatgpt`。
   - 公开注册之前，得单独改用按量计费的模型凭据，否则可能违反这个订阅的使用条款，也很快会被限流。这次只做每个账号的配额。
6. **大陆网络。** 中国大陆有些用户打不开 Google 登录，所以邮箱密码登录一直保留。
7. **owner 计算方式不变。** 仍用 `digest([issuer, tenant, sub])`，已有数据不用迁移。

## 5. 方案比较

**整体架构（选 A）**

- **A. 按 Palantir 的方式拆分，从发布版本生成工具。**
  - 做法：
    - `/mcp` 给外部 Agent 用，每个 Action 和 Function 各生成一个工具，EIGOS Agent 也是其中一个工具；
    - `/mcp/builder` 给运营者用；
    - A2A 直接交给 EIGOS Agent。
  - 代价：工作量最大。
  - 好处：外部模型能看到每个 Action 的准确参数，权限按工具逐个检查，结构和 Palantir 一一对应。
- **B. 保留通用工具，按角色隐藏。**
  - 好处：改动小。
  - 问题：
    - 外部模型要先用 `describe` 查参数，更容易出错；
    - 接入档案在工具列表上体现不出来；
    - 两类工具仍然共用同一个 audience。
- **C. 外部 Agent 只能把任务交给 EIGOS Agent。**
  - 好处：攻击面最小。
  - 问题：
    - 每次都是两个模型串行，消耗我们的模型额度；
    - 用户没法直接读取自己的数据；
    - 和「用户自带 PA」的方向相反。

**外部承诺由谁批准（用户选 A）**

- A：每一笔都由用户在 EIGOS 确认页确认。
- B：用户预先设好额度，额度内自动执行。
- C：沿用现在的做法，由 PA 代为批准。

确认点做成通用的 Action 确认，以后可以在同一个地方加上 B 的额度规则。

## 6. 设计

### 6.1 总体结构

```
任意 AI Agent ──MCP──▶ /mcp            消费者 Ontology MCP（生成的工具，EIGOS Agent 也作为工具）
             └─A2A──▶ /a2a            EIGOS Agent（任务）
运营者客户端 ──MCP──▶ /mcp/builder    建模 MCP（结构、发布、评审）
浏览器 ─────────────▶ /account         注册登录、已连接的 Agent、来源连接
                    ▶ /confirm/:id    用户确认页
        │
Auth0（Google / 邮箱密码 + Post-Login Action）
        │
Gateway：验证令牌 → 账号 → 授权交集 → Action Engine / Functions / Tasks ── 同一个 PostgreSQL schema ── Worker
```

### 6.2 账号与注册

**Auth0 配置**

- 登录方式有两种：Google（`google-oauth2`）和数据库连接（邮箱密码）。两者都设为 domain level。
- Post-Login Action 的源码放进仓库（例如 `deploy/auth0/post-login.js`），并配单元测试。它负责三件事：
  1. **检查邮箱验证。** 请求的是 EIGOS 的 API 时，邮箱没验证就拒绝，并提示用户先去验证。账号页的登录只要 ID token，不会被拒绝，由账号页自己显示「请验证邮箱」。
  2. **合并同一个人的账号。** 如果已经有另一个邮箱相同、也验证过的用户，就按 Auth0 官方的服务端合并流程，把用户转到 EIGOS 的 `/account/link`，让他用原来的方式再登录一次。两边都通过之后再合并，并调用 `api.authentication.setPrimaryUser` 把登录切换到原来的用户上。
     - 没验证过邮箱的用户永远不合并。
     - 用户不能跳过合并去另开一个账号。
  3. **写入 tenant claim。** 往 ID token 和 access token 里写 `OAUTH_TENANT_CLAIM`。
     - access token 只在通过邮箱检查后才写这个 claim。Gateway 本来就要求有它，所以 access token 里有这个 claim，就说明 Action 执行过、邮箱也已验证。
     - ID token 一律写入。
- Management API 凭据只授予 `read:users` 和 `update:users`，存放在 Action secrets 里。

**EIGOS 账号**

- `member_accounts` 改名为 `accounts`。字段包括 owner、状态（active / suspended）、创建时间、停用时间和停用原因。
- 开户时机：用户第一次登录账号页，或者第一次带着有效令牌访问 `/mcp` 或 `/a2a`。
- 开户模式用 `EIGOS_SIGNUP` 设置：
  - `open`：自动开户；
  - `invite`：沿用现有的邀请码；
  - `closed`：不开新户。
- **默认授权。**
  - 新账号加入 `eigos-accounts` 组，这个组由 `eigos-member-queries` 改名而来。
  - 组里的授权按当前发布版本的业务资源生成，逻辑沿用 `memberGrants`，运营者用 `publish` 或 `activate` 命令激活新版本时同步；分支合并激活新版本后，运营者要用管理角色重新执行 `ontology:activate`，因为常驻运行角色不能写授权表。
  - 不含定义编辑权限；sandbox 资源按现有开关处理。
- **运营者命令。** 新增 `account show|suspend|restore`。账号停用后可以恢复。

**账号页 `/account`**

由 `/members` 改名而来，旧地址自动跳转。页面内容：

- 注册和登录。注册时带上 `screen_hint=signup`。
- 账号状态。
- 已连接的 Agent，可以撤销，也可以重新连接。
- 来源连接。
- 待确认的事项。
- 接入说明：MCP 地址和 A2A Agent Card 地址。

**顺带修掉的问题**

- **登录状态存进 cookie。** 登录过程中的 state、nonce 和 PKCE verifier 不再放在进程内存，改放进签名加密、HttpOnly、5 分钟后过期的 cookie。全局 500 个的上限也一并去掉。登录相关的接口按 IP 限流。
- **报错分开写清楚**，至少区分这几种情况：
  - 邮箱未验证（可以重发验证信）；
  - Auth0 配置缺少 tenant claim；
  - 暂停注册；
  - 账号已停用。
- **配置校验。** `EIGOS_SIGNUP` 不是 `closed` 时，必须开启 `EIGOS_ENFORCE_OWNER_RLS=true`。
- **统一叫法。** 自助注册的用户统一叫「账号」。运营者给 owner 发全部业务授权的 `grant-member` 命令，以及 `memberGrants`，改用别的名字，例如 `grant-business`。具体名字由实施者定。

### 6.3 来源连接

- **新表。** 新增 `source_connections` 表，字段包括：
  - owner、来源、binding ID；
  - 凭据引用、状态、到期时间；
  - 创建时间、撤销时间、最近一次检查的时间。
- **凭据。** 凭据加密后存在这张表里，不进 Ontology 对象。这沿用了现有原则「Secrets and raw provider responses are not Ontology rows」。
- **解析接口不变。** `ServiceResolver(owner, provider)`、`configuredAmap`、DiDi、日历等接口保持原样，只是改成从数据库读取。`assertCurrent` 照旧用绑定摘要检查绑定有没有变化。
- **旧文件可导入。** 旧的私有文件保留下来，作为导入方式（`sources import <file>`），已有的 owner 不受影响。
- **权限检查不变。** `read_source` 授权仍然逐个来源检查。
- **缺少连接时。** 仍然报 `SERVICE_AUTHORIZATION_REQUIRED`，各入口把用户带到 `/account/sources/<来源>/connect`：
  - MCP 用 URL 模式的 Elicitation，客户端不支持时，在结果里直接给链接；
  - A2A 用 `TASK_STATE_AUTH_REQUIRED`；
  - EIGOS Agent 的任务暂停，并附上链接。
- **凭据都由用户自己提供。**
  - 连接页先只支持贴 key 这一种方式，第一个来源是高德 Web 服务 key。连上之后，地图和天气就能用了。
  - 日历这类要走 OAuth 的来源，以后按来源一个个加。
  - 由平台统一提供凭据，以后再议；现在的表结构不妨碍以后加上。

### 6.4 授权交集与接入档案

**令牌 audience**

| audience | 用途 | 接受的入口 |
|---|---|---|
| 现有的 `OAUTH_AUDIENCE` | 第一方客户端：Workbench、运营者自己的客户端 | `/mcp/builder`、HTTP API、`/mcp`（套用 `first-party` 档案） |
| `PUBLIC_URL/mcp`（已有） | 任何 MCP 客户端 | `/mcp` |
| `PUBLIC_URL/a2a`（新增） | 任何 A2A 客户端 | `/a2a` |

- 在 Auth0 里，后两个 API 允许第三方客户端，第一个不允许。所以自动注册的客户端拿不到建模用的令牌。
- 第一方 audience 在 `/mcp/builder`、HTTP API 和 Workbench 上不套接入档案，和现在一样。在 `/mcp` 上套用 `first-party` 档案：资源不受限，所有消费者工具组都开放。
- **scope** 沿用现有的四个：`ontology:read`、`ontology:write`、`tasks:read`、`tasks:write`。授权同意页按这几个 scope 显示。

**Agent 客户端和连接**

- `agent_clients` 表记录每个客户端：
  - 字段：client ID、注册方式（预注册 / CIMD / DCR）、显示名、接入档案、状态。
  - 显示名从 Auth0 或 CIMD 元数据取一次，然后缓存起来。
  - Grok 迁移成一条预注册记录。
- `agent_connections` 表记录用户和客户端之间的连接：
  - 字段：owner、client ID、连接时间、撤销时间、最近一次使用的时间。
  - **自动连接。** 用户在 Auth0 同意授权后，第一次请求时自动建立连接，取代现在账号页上的「批准」按钮。
  - **撤销。** 撤销后，这个用户在这个客户端上的令牌一律被拒绝，直到用户在账号页重新连接。重新连接之前签发的令牌也会被拒绝。
  - **Auth0 一侧也要撤销（第 4 步的必做项）。** 撤销连接时，以及第 1 步的账号合并完成时，一并撤销这个用户在 Auth0 里的授权记录和 refresh token。只撤销 EIGOS 一侧不够：合并之前连接的 Agent 手里的 refresh token，合并之后仍然有效，用户重新授权后它换来的新令牌也会被接受，`invite` 模式也挡不住。具体做法见第 9 节。
  - **撤销后的报错。** 返回 403，并说明去哪里重新连接。

**接入档案（对应 Palantir 的应用上限）**

- `access_profiles` 由运营者维护，内容包括：
  - 允许的 agentProfiles（复用发布版本里的 `agentProfiles`）；
  - 额外允许或排除的资源；
  - 工具组：`core`、`tasks`、`advanced`。
- 档案里的资源范围自动加上依赖闭包，也就是 Action 和 Function 用到的对象类型、Interface、Link 和来源。
- 默认档案：
  - `pa-default`：给所有自动注册的客户端。包含全部业务 agentProfiles（不含 sandbox），工具组只有 `core` 和 `tasks`。
  - `first-party`：给运营者自己的 PA 客户端，包含现在全部的消费者工具。
- 运营者可以给某个客户端换一个档案。
- 用 `submit_task` 或 A2A 创建的任务，继承调用方的接入档案和 scope。EIGOS Agent 在任务里也只能用交集里的资源。

**交集在哪里计算**

- 交集在 `Access` 内部算，不只是在列工具时过滤。`Access.allows()` 依次检查三层：
  1. 现有的授权；
  2. 资源是否在接入档案里；
  3. 令牌 scope 是否允许这个操作。
- 这样一来，`describe`、`require`、Effects、ExternalOperations 恢复，以及确认后的执行，都受同一个上限约束。
- Effects 和外部操作本来就会冻结 requirements 和 scopes。这次再加上档案 ID 和摘要，回放时一并复核。

### 6.5 消费者 Ontology MCP（`/mcp`）

每个会话的工具列表来自 `access.describe(model, executable=true, include=接入档案)`。其中 model 是当前激活的发布版本；任务相关的工具沿用任务锁定的那个版本。

**`core` 工具组**

- **读对象。** 沿用现有的 `describe_ontology` 和 `query_ontology`。
- **每个可执行的 Action 生成一个 `action_<ApiName>`。**
  - 参数：Action 的 `parameters`，加上对象参数（object ref），再加上必填的 `requestId`。用同一个 `requestId` 重试，会拿到同一个结果。
  - 说明：Action 自己的 description，加上 agentProfiles 里写给它的 instructions。需要确认的 Action 还会注明「需用户在 EIGOS 确认」。
  - 标注：都标 `idempotentHint`；有外部影响的，另外标 `openWorldHint` 和 `destructiveHint`。
  - 执行：走现有的 `Actions.apply`，和现在的 `apply_ontology_action` 是同一条路径。
- **每个只读 Function 生成一个 `function_<apiName>`**，标 `readOnlyHint`。会编辑数据的 Function 只能通过它对应的 Action 调用。
- **保留 `complete_with_action`。** 它用来把 Interface Action 和结果读取合成一次调用。

**`tasks` 工具组：把 EIGOS Agent 当作工具**

- 保留现有的 `submit_task`、`get_task`、`supply_task_input`、`respond_to_task`、`list_pa_requests`、`select_task_places`、`amend_task_place`。
- 新增 `cancel_task` 和 `get_confirmation`。
- `respond_to_task` 可以拒绝 PA 请求，例如客户端读不到日历的时候。拒绝之后，发起请求的 Function 收到 `PA_REQUEST_DECLINED` 错误，由 EIGOS Agent 按普通错误处理：要么改问用户，要么说明原因后结束。
- 交互任务的 `input-required` 状态加上过期时间，由 `EIGOS_TASK_INPUT_TTL` 设置，默认 24 小时。到期后任务取消，不再挡住同一对话里后面的任务。定时任务和自动化提案仍按各自现有的截止时间处理。

**`advanced` 工具组**

- `apply_ontology_action`、`evaluate_ontology`、Scenario 的四个工具、`list_learned_hotel_workflows`。
- 附录 A 里归为消费者的 48 个 `ontology_*` 服务。

**其他**

- 发布版本变了，或者连接的档案变了，有状态的会话会收到 `notifications/tools/list_changed`。
- 建模服务不再出现在 `/mcp` 上。

### 6.6 用户确认（外部承诺）

**声明**

Action 类型新增一个可选字段 `confirmation`：

```ts
confirmation?: {
  object: string;   // 被确认的预览对象：objectParameters 里的参数名
  terms: string[];  // 确认页展示的对象属性，最多 20 个
  digest: string;   // 确认绑定的条款摘要属性，例如 approvalDigest、termsDigest
  expires?: string; // 预览对象上表示到期时间的属性；没有的话默认 15 分钟
}
```

- 声明了这个字段的 Action，只要不是在 Scenario 里，从任何入口调用都必须先经用户确认。
- 接入档案不能取消这个要求。

**流程**

1. **发起。** 调用时照常检查权限和提交条件。如果还没有对应的已确认记录，就写一条 `ActionConfirmation`，然后抛出 `ConfirmationRequired`。
   - 这条记录复用现有的对象类型，加上这些字段：Action、输入摘要、对象和修订号、条款快照和摘要、到期时间、发起的客户端、任务 ID。
   - 状态沿用现有的 awaiting-input → confirmed → completed / failed / canceled，另外新增 expired。
2. **各入口通知用户。**
   - MCP：客户端声明了支持 URL 模式 Elicitation，就返回 `-32042`（URLElicitationRequiredError）。不支持时返回普通结果 `{status:'confirmation_required', confirmation:{id,url,expiresAt}}`，并提示把链接交给用户。
   - A2A：任务进入 `TASK_STATE_AUTH_REQUIRED`，消息里带上链接。
   - EIGOS Agent 的任务：沿用现有的 `placeContinuation` 和 `recordActionConfirmation` 暂停、恢复机制，推广到所有声明了确认的 Action。
3. **确认页 `/confirm/:id`。**
   - 必须用同一个 owner 登录 EIGOS，没登录就先登录再回来。
   - URL 里只有随机 ID，不含个人信息，也不带登录状态。
   - 页面显示条款快照、发起的 Agent 名称和到期时间，提供「确认」和「拒绝」两个按钮。提交用 POST，并检查 Origin。
4. **用户确认后执行。**
   - 先重新读取对象。修订号和摘要必须和快照一致，否则提示「条款已变化」，这条确认作废。
   - 再用「冻结的权限 ∩ 当前授权」复核权限。
   - 然后执行原来的 Action，只执行一次：
     - 直接调用的，由 Gateway 在确认提交后立即执行；
     - 任务里的调用，等任务恢复后由 Worker 执行，沿用现有的 `placeContinuation` 路径。
   - `FunctionContext` 新增 `confirmation: { id, termsDigest, object, revision }`。连接器现在用「`ctx.directAction` 加摘要比对」做检查，改成判断 `ctx.confirmation.termsDigest === 对象摘要`。
   - 派发仍然走 `ExternalOperations`。
   - 执行结束后，记录完成或失败，以及执行结果。
5. **通知调用方。**
   - MCP：会话还在的话，发送 `notifications/elicitation/complete`。客户端用同一个 `requestId` 重试，就能拿到已经保存的结果，Action 现有的幂等记录本来就支持这一点。
   - A2A：任务转为完成或失败。
   - EIGOS Agent：任务继续执行。
6. **拒绝或过期**的确认都不派发。

**涉及哪些 Action**

- **需要加确认声明的**：凡是由 EIGOS 派发的承诺，都要加。下面这些是起点，实施者要逐一核对：
  - 飞猪酒店和机票的下单、确认付款、取消；
  - payments 里的 Stripe sandbox 和 Link 付款；
  - 订位提交；
  - Luma 报名；
  - 滴滴下单和定时叫车。
- **不加确认的**：由 PA 在用户自己的 App 或支付页里完成的承诺，例如瑞幸自取和支付宝 Agent Pay。用户本来就在供应商的可信页面上确认过，所以继续走 PA 请求，不再重复确认。
- **定时叫车这类排程**：确认一次，覆盖整个排程的条款。条款变了才需要再确认。
- **只要求客户端本人提交的**：有些 Action 只要求客户端自己提交、不能由我们的 Agent 代办，例如开启或停止航班和行程提醒。这些继续用 `directAction`，不改成确认。
- **加入默认档案**：确认上线之前，`pa-default` 不包含任何承诺类 Action。确认上线时，再把这些 Action 作为额外资源加进 `pa-default`，或者补进对应的 agentProfile。

**network contract**

- `commitmentApproval {termsDigest, approvedAt}` 改由确认记录产生，不再由调用方自己填写。
- 第三阶段的 AP2 mandate 只是换掉这条记录的证明方式，流程不变。

### 6.7 A2A（`/a2a`）

**Agent Card 的 `securitySchemes`**

- `oauth2`：授权码加 PKCE。authorize 地址带上 `audience=PUBLIC_URL/a2a`，同时给出 token 地址和 scope。
- `oidc`：指向 Auth0 的 discovery 地址，客户端可以从中找到注册入口。
- `bearer`：保留，兼容已经签发的令牌。
- 另外提供 `/.well-known/oauth-protected-resource/a2a`，方便客户端按 RFC 9728 发现授权服务器。

**skills**

- 由发布版本里的 `agentProfiles` 生成，取代现在手写的两个：
  - id 和名称来自 apiName；
  - tags 来自 terms；
  - 说明从 instructions 里摘要。
- 开启扩展 Agent Card。用户登录后，只返回他授权交集里的 skills。

**行为**

- 支持 `ListTasks`，只列出自己的任务。
- 状态对应关系：
  - 澄清和 PA 请求：`TASK_STATE_INPUT_REQUIRED`；
  - 用户确认和来源连接：`TASK_STATE_AUTH_REQUIRED`。
- 回答问题时，后续消息可以直接用文字，也可以用 `data.paResponse`。
- `CancelTask` 已经有了。
- 推送通知以后再加，先靠轮询。

### 6.8 建模 MCP（`/mcp/builder`）

- 只接受现有的第一方 audience。每个工具照旧检查 `edit_definition`、`manage_definition` 等授权。
- 工具就是附录 A 里归为建模的 53 个服务，涵盖：
  - 分支、提案和原始定义；
  - 发布与撤回、项目；
  - 包和迁移；
  - 语义索引配置；
  - 来源索引和物化；
  - 实体绑定和编辑策略；
  - 评估集；
  - Machinery。
- 和 Palantir MCP 的规则一样，建模 MCP 不执行业务 Action。
- 运营者现在用的客户端，改为建模连 `/mcp/builder`、业务连 `/mcp`。工具本身不变，只是换了地址。README 里写清楚怎么迁移。

### 6.9 配额

- 按账号限制：每天 `submit_task` 的次数，以及同时进行的任务数。
- 按连接限制：每分钟的工具调用次数。
- 超出时返回带 `Retry-After` 的错误。
- 默认值放在配置里，具体数值由实施者定。

### 6.10 数据变更与迁移

- **改名**：
  - `member_accounts` 改为 `accounts`；
  - `member_sessions` 改不改名，由实施者决定；
  - `member_invitations` 保留，给 invite 模式用。
- **新表**：`agent_clients`、`agent_connections`、`access_profiles`、`source_connections`。
- **Ontology 定义**：Action schema 新增 `confirmation`，`ActionConfirmation` 加字段，都按现有的版本兼容规则发布。
- **已有会员和 Grok 的连接**：自动迁移，第一次请求时补建连接记录。

## 7. 交付顺序

每一步单独开一个 PR，每个 PR 都要跑完整检查。

1. **账号与注册**：Post-Login Action 及其测试、`accounts` 表、用 cookie 存登录状态、限流、RLS 校验、报错、停用与恢复、改名。
2. **来源连接入库**：绑定存进数据库、旧文件导入、连接页框架和高德 key 连接、把 `SERVICE_AUTHORIZATION_REQUIRED` 转成连接链接。
3. **MCP 拆分**：生成工具、接入档案、在 `Access` 里算交集、`cancel_task`、`input-required` 过期、`/mcp/builder`。
4. **开放接入**：
   - Auth0 的 CIMD 和 DCR 配置清单；
   - PRM 和 `WWW-Authenticate`；
   - Agent 客户端与连接，以及「已连接的 Agent」页面；
   - A2A 的 OAuth 和扩展 Card。
5. **用户确认**：
   - `confirmation` 声明和确认页；
   - MCP 的 `-32042` 和不支持时的普通结果；
   - A2A 的 `AUTH_REQUIRED`；
   - 任务暂停；
   - 把现有连接器从 `directAction` 迁过来，并把承诺类 Action 加入 `pa-default`。

第 5 步落地之前，`pa-default` 不含任何承诺类 Action，所以第 3、4 步不会提前开放外部承诺。

每一步结束时，都用真实客户端从注册一路走到结果，完整跑一遍。第 1、2 步用现有的 Grok 连接，从第 4 步起改用新注册的客户端。

Auth0 租户上的改动属于对外操作，要等用户授权后才执行，包括：

- 新增 API；
- 提升连接级别；
- 部署 Post-Login Action；
- 打开 DCR 或 CIMD。

仓库里提供操作清单和脚本。

第 3 步会改变运营者现有客户端的连接地址，PR 里要写明迁移步骤。

## 8. 验收

**自动化测试**

沿用现有的测试工具，用本地签发的 JWT 模拟 Auth0。

- **账号**：
  - 两个身份合并后对应同一个 owner；
  - 邮箱未验证会被拒绝；
  - `closed` 和 `invite` 两种模式都按预期工作；
  - 停用之后可以恢复；
  - 多实例下也能完成登录。
- **MCP**：
  - 自动注册的客户端只看到交集里的工具，看不到建模工具；
  - scope 不够时返回 403，并带上需要的 scope；
  - `/mcp/builder` 拒绝消费者 audience；
  - 撤销后令牌被拒，重新连接后恢复。
- **确认**（用飞猪 sandbox 或订位的 synthetic 执行）：
  - `-32042` 和普通结果两种返回都能得到；
  - 用别的 owner 打开确认页会被拒绝；
  - 确认后只执行一次，用同一个 `requestId` 重试，得到同一个结果；
  - 拒绝、过期、条款变化三种情况都不会派发。
- **任务**：`cancel_task` 生效；可以拒绝 PA 请求；`input-required` 过期后，同一对话能继续往下走。
- **A2A**：
  - Card 里声明了 OAuth 和 OIDC；
  - 扩展 Card 的 skills 按交集过滤；
  - `AUTH_REQUIRED` 之后任务能恢复；
  - `ListTasks` 只列自己的任务。

**真实验收**

- 使用真实的 Auth0 租户。
- 至少用两个不同的 MCP 客户端（例如 Grok 和 Claude），从零开始注册、连接、查询。新账号贴上自己的高德 key 后，要能查地图和天气。
- 执行只用 synthetic，不真实下单或付款。测试连接要由运营者指定一个包含 sandbox 资源的档案，因为 `pa-default` 不含 sandbox。

**每个 PR 都要跑**

`npm run check`、`npm run build`、`npm test`、构建后的 `npm run test:e2e:run`，以及 `git diff --check`。

## 9. 留给实施者

- 表、工具、环境变量的具体名字。
- 配额的具体数值。
- cookie 的加密细节。
- 生成工具时的参数细节，例如对象参数怎么表示。
- 确认记录里的内部字段（例如冻结的权限）放在 `ActionConfirmation` 对象上，还是另放一张表。
- 需要加确认声明的 Action 的最终清单。
- 撤销连接和完成合并时，怎么撤销 Auth0 里的授权记录和 refresh token：用哪些 Management API，给 Management 应用什么权限。要不要撤销已经定了，见第 6.4 节。
- Post-Login Action 怎么部署：照清单手动部署，或者用脚本通过 Management API 部署。
- 确认页在派发期间如何显示进度，例如先显示「处理中」，再轮询结果。
- 先确认仓库里的 MCP SDK 和 A2A SDK 版本是否支持 URL 模式 Elicitation（`-32042`）、`TASK_STATE_AUTH_REQUIRED` 和扩展 Agent Card。不支持就先升级。

## 10. 已确认的决定

- 2026-11-17：目前所有来源都由用户自己连接，先把整个架构跑通。查询类来源（高德、航班动态、大众点评搜索等）的凭据改由平台统一提供，这件事以后再议。

## 附录 A：现有 101 个 `ontology_*` 服务的归类

下面按名称和说明归类，实施时可以微调。

**消费者（48 个，放在 `advanced` 工具组）**

- 对象读取（13 个）：`read_object`、`follow_links`、`explore_graph`、`map_objects`、`object_view`、`semantic_search`、`lookup_entity`、`edit_history`、`execution_trace`、`list_action_log`、`process_status`、`list_public_places`、`tasks`
- 对象集（6 个）：`evaluate_set`、`aggregate_set`、`save_set`、`get_set`、`list_sets`、`delete_set`
- Action 辅助（5 个）：`validate_action`、`apply_action_batch`、`undo_action`、`effect_status`、`retry_effect`
- Workflow 与规则（10 个）：`workflows`、`save_workflow`、`run_workflow`、`workflow_runs`、`retry_workflow`、`cancel_workflow`、`published_workflows`、`run_published_workflow`、`rules`、`save_rule`
- Scenario（14 个）：`open_scenario_session`、`close_scenario_session`、`share_scenario`、`rebase_scenario`、`invite_scenario_reviewers`、`pending_scenario_reviews`、`inspect_scenario_review`、`approve_scenario_review`、`compare_scenarios`、`continue_scenario`、`scenario_continuation_sources`、`trial_scenarios`、`scenario_trial_options`、`preview_automation`

**建模（53 个，放在 `/mcp/builder`）**

- 定义与分支（13 个）：`workbench_access`、`raw_definition`、`function_versions`、`proposal_diff`、`create_branch`、`get_branch`、`list_branches`、`update_branch`、`prepare_branch`、`review_branch`、`merge_branch`、`rebase_branch`、`catch_up_branch`
- 发布与项目（6 个）：`publish_workflow`、`withdraw_workflow`、`publish_public_place`、`withdraw_public_place`、`project`、`assign_project`
- 包与迁移（5 个）：`export_package`、`import_package`、`migrate_definitions`、`migrate_data`、`migration_receipt`
- 语义索引（3 个）：`semantic_configure`、`semantic_index`、`semantic_status`
- 来源索引与物化（7 个）：`submit_index`、`index_status`、`retry_index`、`cancel_index`、`materialize`、`read_materialization`、`materialized_links`
- 实体、策略与视图（4 个）：`bind_entity`、`entity_history`、`edit_policy`、`save_object_view`
- 评估（6 个）：`trial_candidate_scenarios`、`evaluation_suites`、`evaluation_cases_from_set`、`save_evaluation_suite`、`run_evaluation_suite`、`promote_evaluation_candidate`
- Machinery（9 个）：`machinery_processes`、`machinery_analysis`、`ingest_machinery_history`、`save_machinery_cases`、`machinery_propose_model`、`save_machinery_review`、`machinery_reviews`、`machinery_review`、`run_machinery_review`

## 参考资料

- Palantir：
  - [Ontology MCP 概览](https://www.palantir.com/docs/foundry/ontology-mcp/overview)
  - [Ontology MCP 工具与 Agent 配置](https://www.palantir.com/docs/foundry/ontology-mcp/mcp-tools-and-agent-configuration/)
  - [Ontology MCP 认证与授权](https://www.palantir.com/docs/foundry/ontology-mcp/authentication-and-authorization)
  - [应用限制](https://www.palantir.com/docs/foundry/developer-console/application-restrictions/)
  - [Palantir MCP 概览](https://www.palantir.com/docs/foundry/palantir-mcp/overview)
  - [Chatbot Studio 工具](https://www.palantir.com/docs/foundry/chatbot-studio/tools)
  - [Action webhooks](https://www.palantir.com/docs/foundry/action-types/webhooks/)
  - [Interface Action 约束](https://www.palantir.com/docs/foundry/interfaces/interface-action-type-constraints)
- MCP 规范 2025-11-25：
  - [授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  - [Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
- Auth0：
  - [CIMD](https://auth0.com/docs/get-started/auth0-overview/create-applications/cimd-overview)
  - [MCP 服务器授权](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server)
  - [Auth for MCP 正式发布](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/)
  - [账号合并](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/link-user-accounts)
  - [服务端建议合并流程](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/suggested-account-linking-server-side-implementation)
- A2A：[A2A 规范](https://a2a-protocol.org/latest/specification/)
