# Agent 自助登记、邀请与自动续期

原生 Codex MCP 邀请接入见[部署入口](deployment.md)。它使用预登记的公开 OAuth 客户端 ID，沿用会员和客户端连接检查；下文的 Node AgentConnector 则额外管理独立安装实例，两者的停用粒度分别说明。

客户的 Agent 从公开发现入口开始登记，Auth0 验证真实用户并签发令牌，EIGOS 校验会员资格、邀请和安装实例的停用状态。Gateway 不持有 Agent 的刷新令牌，也不另建 OAuth 授权服务器。

需要本人服务账号的能力另走[会员自有账号授权](member-sources.md)：启用后发现文档列出 `sources:read`／`sources:write`，PA 经用户同意后在独立通道传输供应商 Token。`AgentConnector.connectSource` 和 `examples/connect-member-source.ts` 提供宿主侧入口；Token 不进入模型或任务，EIGOS 的 OAuth 登录令牌与供应商凭据分别管理。

## 接入顺序

发现文档包含登记请求的 JSON Schema、凭据生成方式、会员申请 Schema／同意说明以及刷新后的绑定步骤，供 Agent 读取；它不会要求 Agent 从网页或报错中猜接口参数。

1. 读取 `/.well-known/eigos-agent-registration`。MCP 资源元数据和 A2A Agent Card 也会指向这个入口。
2. Agent 在自己的私有凭据文件中生成登记 UUID 和 32 字节随机登记凭据，再调用登记 API。相同 UUID／凭据的重试复用原登记。
3. 根据发现元数据，用预登记的 EIGOS public connector client 发起 Auth0 Device Authorization。首次由用户确认身份和权限，Agent 按提供方间隔等待；无需为每个 Agent 安装手工建立 Auth0 应用。
4. Agent 用真实 Auth0 访问令牌及登记凭据完成绑定。身份只取经验证的 `issuer + tenant + sub`，软件客户端只取签名中的 `client_id`。
5. 非会员提交资料和明确同意，需要 `members:write`。自助模式直接开通；人工审核或邀请制返回等待状态。
6. 资格可用后，携带绑定的 Auth0 Bearer Token 调用 `/mcp`、`/a2a` 或任务授权 API。调用方仍受具体 scope 和业务授权约束。

登记凭据只能查询进度和配合有效用户令牌管理登记；它本身不能调用业务。Auth0 可在身份授权阶段签发访问令牌，EIGOS 会在会员和 Agent 登记可用之前拒绝业务调用。

已有 active 会员接入另一个 Agent 时，复用已有会员资格；重复申请不会改写原会员资料或重置开通状态。

登记的对象是 **Agent 安装实例**。Auth0 的 connector 软件客户端预登记一次，每个安装实例在 EIGOS 中有独立 UUID、凭据和停用状态。不同外部 MCP 客户端的自动 CIMD／DCR 接入仍需按实际客户端适配，不能把本适配器视为所有客户端已自动兼容。

## HTTP 原语

所有登记请求携带 `X-EIGOS-Registration-Token`，其值由 Agent 本地生成，使用 32 字节随机值的 base64url 表示。下面的 `:id` 为登记 UUID。

| 方法／路径 | 权限与作用 |
| --- | --- |
| `GET /.well-known/eigos-agent-registration` | 公开：issuer、public client ID、audience、scopes、准入规则和登记入口 |
| `POST /agents/registrations` | 登记凭据；JSON `{registrationId, displayName}`；不创建会员或签发业务令牌 |
| `GET /agents/registrations/:id` | 登记凭据；查询状态、下一步、轮询建议及固定服务入口；不返回客户身份资料 |
| `POST /agents/registrations/:id/token` | 登记凭据＋有效 Auth0 JWT；首次绑定或绑定轮换后的新访问令牌 |
| `POST /agents/registrations/:id/application` | 登记凭据＋同一用户 JWT＋`members:write`；JSON `{displayName,locale,timezone,consent:true}` |
| `POST /agents/registrations/:id/invitation` | 登记凭据＋同一用户 JWT＋`members:write`；JSON `{invitationToken}` |
| `POST /agents/registrations/:id/revoke` | 登记凭据＋同一用户 JWT；停用该安装实例 |

状态包括 `authorization_required`、`registration_required`、`waiting_invitation`、`pending_approval`、`active`、`membership_suspended`、`connection_revoked`、`agent_registration_revoked`、`registration_expired`。等待状态返回 `nextAction`、`pollAfterSeconds` 和 `links`。登记不超过 30 分钟仍未绑定时过期；未绑定登记入口及每个会员的活跃登记均有数量上限。

未认证的协议请求保持 `401` 和 OAuth challenge；不满足会员或登记要求时返回 `403` 及引导入口，不伪装成一次成功的工具调用。

## Node Agent 适配器

`packages/agent-client/client.ts` 提供可组合的登记、授权、申请、查询、邀请兑换、访问及停用方法。每个 Agent 使用独立的私有凭据文件，不将凭据放进模型提示词。

纯 A2A 接入可直接使用 `agent.a2a()`，它返回配置好安装认证和续期的官方 A2A 客户端，完整示例见 [A2A 接入](a2a-agent.md)。受保护模式缺少安装许可时，状态中的 `links.permissions` 指向本人授权页；按同一登记等待，不能把 OAuth 登录成功当作已有业务权限。

```ts
const agent = await AgentConnector.open({
  baseUrl: 'https://your-eigos-origin',
  credentialPath: './data/my-agent/credentials.json',
  displayName: 'My Personal Agent',
});
const authorization = await agent.beginAuthorization();
// 将 verificationUri / userCode 呈现给用户；不要输出 device_code 或令牌。
await agent.finishAuthorization();
await agent.registerMembership({
  displayName: '客户授权的会员名称', locale: 'zh-CN', timezone: 'Asia/Shanghai',
}, true);
const status = await agent.status();
// 等待邀请时保持原登记，按建议查询；取得邀请后调用 redeemInvitation。
const response = await agent.fetch('/a2a', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'stable-request-id', method: 'ListTasks', params: {} }),
});
```

官方 MCP 客户端使用同一适配器的 fetch，即可自动续期：

```ts
const transport = new StreamableHTTPClientTransport(new URL(baseUrl + '/mcp'), {
  fetch: (input, init) => agent.fetch(input instanceof Request ? input.url : input.toString(), init),
});
await client.connect(transport);
```

已有凭据时重新 `open` 会复用同一登记；`accessToken()`／`fetch()` 在访问令牌即将过期时自动刷新。同一实例内的并发请求共享一次刷新，私有文件锁阻止多个进程同时消费同一轮换令牌。不确定的刷新结果会要求重新授权，避免反复重放旧刷新令牌。任务 POST 不因网络错误或 `401` 自动重试，调用方应先查询原任务并保留请求 ID。

授权成功后若登记绑定的响应丢失，适配器会在原访问令牌仍有效时接续同一次绑定；不重复创建登记、会员或设备授权。首次绑定的授权已经过期时，仍须重新取得用户授权。

只把一次访问令牌粘贴给其他客户端，不会自动接入本适配器的续期逻辑；该客户端需使用上述适配器或实现对应的 OAuth 刷新和登记绑定步骤。

## 邀请和会员管理

默认 `EIGOS_MEMBERSHIP_APPROVAL=self-service`，也支持 `manual` 和 `invite-only`。Agent 与会员网页共用这一规则，不能从另一入口绕过邀请制。

管理员在已核验并申请会员的身份下签发邀请：

```sh
node --env-file=path/to/private/gateway.env scripts/members.mjs invite <member-id> \
  --output data/private/invitation.json --expires-hours 24
node --env-file=path/to/private/gateway.env scripts/members.mjs revoke-invite <invitation-id>
```

邀请绑定已有会员身份，单次使用、默认 24 小时、最长 7 天；私有文件只创建一次，不在终端显示邀请凭据。它不能按自报邮箱转给另一个身份，也不能绕过会员同意或停用状态。普通 Agent 没有签发邀请的 API。

撤销邀请会阻止后续兑换；已兑换的邀请不会因此自动停用会员。停用会员使用现有 `members suspend` 管理命令。

会员可以在网页查看登记实例、停用单个助手或兑换邀请；这些操作继续检查自身会话、同源 Origin 和 CSRF。旧的按 OAuth 软件客户端停用连接功能继续保留，作用于该客户端的所有登记实例。

## 续期与停用边界

Auth0 connector 为 Native public client，启用 Device Code、Refresh Token 和轮换；API 允许 `offline_access`，访问令牌最长 900 秒，刷新令牌有绝对期限和空闲期限。它们始终是 Auth0 签名的访问令牌，原有 issuer、audience、用途、tenant、scope 与寿命检查保持启用。

Gateway 仅保存登记凭据、邀请和访问令牌的 SHA-256；原始刷新令牌在 Agent 的 `0600` 私有文件中。每次新访问令牌都先绑定原登记，协议调用再检查会员、软件客户端连接和安装实例状态。

Auth0 Action 为 connector 的初次 Device Code grant 写入签名的 `agent_enrollment=true`；刷新 grant 写入 `false`。首次登记要求新授权，且同一访问令牌只能绑定一个安装实例。旧令牌的绑定保留至其过期，防止已停用 Agent 仅凭刷新令牌或旧初始令牌登记替代实例。停用是 EIGOS 本地调用资格的撤销，不宣称已撤销 Auth0 上所有历史授权。
