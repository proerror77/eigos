# 独立加密 Relay 与节点连接器

Relay 是 PA、EIGOS 聚合 Agent 与服务 Agent 之间的独立通信服务，提供节点登记、双方接受的联系、持久密文信箱、收件回执和撤销。它不执行模型、日历、订单或其他业务操作。原有 Gateway 的 `/mcp`、`/a2a` 继续作为业务入口；本模块不替换这些协议或放宽任务权限。

## 运行与隔离

要求与主工程相同的 Node.js 版本。开发配置只绑定本机回环地址：

```sh
npm run setup:relay
npm run dev:relay
```

在另一个终端运行 `npm run example:relay`。示例创建发起人 PA、EIGOS 协调节点和两位参与者 PA，以成对加密会话查询合成空闲时间并返回交集。它不连接真实日历、不写日程、不通知实际联系人，也不接入现有 Coordinator 的业务验收。这是通信及宿主接线示例，不是已完成的真实多人日程产品。

构建后使用 `npm run start:relay`。脚本读取私有 `.env.relay`，不会读取业务 `.env`。Relay 数据库必须使用独立的绝对路径；已有业务库、会员库和节点库会被拒绝。文件权限要求 0600。部署时使用不同系统身份和目录，勿将业务库或节点凭据挂载到 Relay。

生产必须配置 HTTPS 外部地址及 TLS 终止层，并使用 JWT 登记授权：

TLS 终止层应与 Relay 通过同机回环链路连接；跨主机后端链路也必须加密。代理和宿主日志不得记录 Authorization、原始登记令牌或凭据文件内容。原始日历/供应商 Token 优先留在所属 PA，不通过普通业务消息交给模型处理。

| 配置 | 用途 |
| --- | --- |
| `EIGOS_RELAY_HOST`、`EIGOS_RELAY_PORT` | 默认 `127.0.0.1:8788` |
| `EIGOS_RELAY_TRUST_LOOPBACK_PROXY` | 默认 `false`；同机 TLS 代理使用 `true`，且 Relay 只能监听回环地址。代理须覆盖或追加真实客户端地址到 `X-Forwarded-For`，不能原样信任客户端提供的地址 |
| `EIGOS_RELAY_PUBLIC_URL` | 唯一外部 origin，用于端点和请求证明校验；生产必须 HTTPS |
| `EIGOS_RELAY_DATABASE_PATH` | 独立持久通信库 |
| `EIGOS_RELAY_AUTH_MODE` | 默认 `jwt`；`development` 仅允许非生产回环环境 |
| `EIGOS_RELAY_DEV_TOKEN` | setup 生成的本地登记凭据，不能用于公网 |
| `EIGOS_RELAY_OAUTH_ISSUER`、`EIGOS_RELAY_OAUTH_AUDIENCE`、`EIGOS_RELAY_OAUTH_JWKS_URL` | 受信身份服务与专属 Relay audience |
| `EIGOS_RELAY_CLIENT_IDS` | 允许登记的软件客户端 ID，逗号分隔 |
| `EIGOS_RELAY_TENANT_CLAIM` | 可信租户声明名，默认 `tenant_id` |

登记授权要求 `at+jwt`、正确 issuer/audience、`relay:enroll`、允许的 `client_id`、tenant、sub、iat/exp，寿命不超过 15 分钟。身份提供方须实际配置这些许可；现有任务令牌不自动获得 Relay 权限。

Relay 不提供 OAuth 登录或 Token Exchange 服务。除了受信身份提供方的密钥读取，它不主动请求联系人端点、运行外部 Webhook 或访问供应商。节点主动连接 Relay，无需开放 PA 本机入站端口。

入口限流使用经过上述代理信任检查的客户端地址；节点与登记身份仍各自接受认证后的限流。默认不会使用请求方自行提供的转发地址。

节点使用独立的 `.lock.sqlite` 写锁保护整个连接器生命周期，崩溃后由操作系统释放。保留的 `.lock` PID 标记用于识别旧连接器；升级时先停止旧进程，再启动新版本。锁数据库、节点状态和私钥须放在同机私有目录，不能放在跨主机共享文件系统，也不能删除仍在使用的锁数据库。

恢复待发消息时使用 `outbox({ after, limit, pendingOnly })` 分页，下一页的 `after` 取上一页最后一条的 `cursor`，直到返回空页。`pendingOnly: true` 只筛选尚无 Relay 收件响应的发送，不表示业务完成状态；已有千条历史记录不会遮住后续页的待发消息。

## 身份与信任

节点在自己的环境生成 Ed25519 签名密钥、X25519 加密密钥和随机连接凭据。身份 ID 由签名公钥的 JWK Thumbprint 得出；签名名片同时绑定加密公钥与名称。接收者使用预期的完整 Agent ID 校验名片，Relay 不能在同一个 ID 下替换密钥。

显示名称不证明真实人的身份。首次联系应通过用户已信任的 PA、名片或其他已确认渠道取得完整 ID。当前接口按准确 ID 查找，不提供全局名字搜索或第三方身份背书。

控制者的登记 JWT 仅用于登记、续期、列出自己的节点及撤销，不保存到节点文件，不转给其他节点。节点连接凭据保存在本机 0600 文件，Relay 只保存哈希并绑定签名公钥；资源请求使用 RFC 9449 格式的 DPoP 证明，校验方法、准确地址、令牌哈希、签名、时间和持久防重 ID。

连接凭据有效期 24 小时；显式 `renew` 需要新的有效登记授权。撤销后原节点 ID 不能重新启用。密钥不可原地替换：建立新身份，经可信渠道重新联系，再撤销旧身份。第一版不支持多设备同步、密钥恢复或联邦。身份提供方停用一个用户也不会自动触发所有已登记节点的即时撤销；应同步调用 Relay 的节点撤销入口，或等待连接资格到期。

## 节点客户端

`packages/agent-transport/client.ts` 提供 `RelayClient`：

```ts
const node = await RelayClient.open({
  baseUrl: 'https://relay.example.com',
  credentialPath: '/private/my-pa/relay-credentials.json',
  displayName: 'My PA',
});
await node.register(ownerAccessToken); // 宿主授权流程取得，不放入模型参数
const request = await node.requestContact(confirmedPeerAgentId);
// 接收方查看 contacts()，明确 respondContact(request.id, 'accept')。
// 联系被接受后：
const messageId = await node.queue(confirmedPeerAgentId, request.id, {
  kind: 'availability.request', taskId, purpose: 'meeting',
});
await node.deliver(messageId);
```

同一凭据文件只允许一个连接器进程打开；崩溃后的过期进程锁可恢复。凭据及本机状态库绑定 Relay origin 和节点身份，不允许静默换服务器或混用另一个节点的存储。

- `queue` 在首次发送前保存固定密文；`deliver` 重试复用原 ID 和字节，同一 ID 不可改变内容。
- `poll({waitSeconds:25})` 验证并持久保存收件后再 ACK。无法解密的合法签名消息进入本地隔离列表，不触发宿主。
- `pending()` 返回重启后尚未处理完的消息；`markHandled(senderId,id)` 在宿主完成幂等受理后清除本地密文。
- `listen(handler,signal)` 只调用提供的函数，不解释外部消息为 shell 命令或自动授予工具权限。函数失败保留消息并向调用方报错；宿主负责有界退避和恢复。
- 业务受理与 `markHandled` 之间可能发生进程中断，宿主须使用稳定消息 ID 做业务防重。本模块不承诺业务 exactly-once。

网络错误不会自动更换请求键或新建任务。调用方使用发件箱原 ID 查询回执或再次 `deliver`。本地待处理消息过期后不再交给宿主。节点关闭前应先停止并等待活动轮询或 handler 结束。

## 端点与状态

公开发现为 `GET /.well-known/eigos-relay`，健康检查为 `GET /health`。

| 端点 | 权限与作用 |
| --- | --- |
| `POST /v1/agents` | 登记 JWT + 节点私钥证明；提交签名名片、连接凭据哈希、固定 requestId |
| `GET /v1/owned-agents` | 登记 JWT；只列出该主体的节点 |
| `POST /v1/agents/:id/renew` | 原控制者 JWT + 节点私钥证明；准确 requestId 续期 |
| `POST /v1/agents/:id/revoke` | 原控制者 JWT，可在节点丢失时撤销 |
| `GET /v1/agents/:id` | 节点凭据 + DPoP；读取准确 ID 的签名名片与状态 |
| `GET/POST /v1/contacts` | 查询自己的联系或发起请求 |
| `POST /v1/contacts/:id` | 接收者 accept/reject，任一方 revoke；发起人不能替对方接受 |
| `POST /v1/messages` | 验证发送方签名、联系、大小、期限和配额，保存密文 |
| `GET /v1/inbox` | 仅接收节点；`wait=0..25` 秒，`limit=1..20` |
| `POST /v1/messages/:sender/:id/ack` | 仅准确接收节点和信封摘要；确认连接器持久接收 |
| `GET /v1/messages/:sender/:id` | 仅发送方或接收方；查询投递回执 |

消息状态为 queued、received、expired、revoked。received 只说明连接器收件，可能仍待处理或已被本机隔离，不表示日程写入、任务完成或授权生效。

联系接受只授予通信资格。业务主体、用途、资源、工具、输出对象及撤销仍由 PA/EIGOS 的业务权限层决定；发起人不能替朋友授权，朋友关系不提供日历读取或付款权。

## 加密与保留边界

消息使用标准 JOSE：X25519 ECDH-ES + A256GCM 的 JWE，外层为 Ed25519 JWS。签名覆盖密文、消息 ID、收发身份、联系及期限；解密后再检查正文与信封上下文一致。现有 `jose` 库实现算法，本模块定义有限的消息与接入合同。

Relay 不持有节点私钥，但可见公开名片、联系关系、收发身份、时间、大小和投递状态。EIGOS 作为受托接收端可以解密发送给自己的内容。

第一版没有前向保密或群组 Ratchet：接收者长期私钥被攻破后，攻击者可能解密此前保存的密文。不能描述为 Signal/MLS 等级的会话安全，也不宣称 A2A-over-SLIM 或 ANP 互操作。

消息最长 24 小时；ACK、到期或撤销后清除 Relay 活动记录里的密文。投递元数据在过期后最多保留 30 天并随请求清理。SQLite 日志和备份可能保留历史密文，字段清除不等于介质安全擦除。身份及撤销墓碑保留以防旧身份复活。节点自己的凭据、发件箱、历史摘要与备份由节点控制者管理。

撤销节点或联系阻止新投递并清理未送达消息，不能追回已被接收者解密的信息。对已接收任务的后续执行，宿主应另外验证业务许可。

默认每个控制者最多 16 个登记身份，单节点最多 128 个待处理/活跃联系，信箱最多 256 条或 4 MiB 密文；请求和长轮询也有上限。超限显式报错，不静默丢弃消息。生产规模、真实 PA 宿主唤醒和外部身份服务仍需实例验证。

## 与业务协议的关系

Relay 本身承载有限 JSON 消息。可选的[主实例任务适配器](relay-tasks.md)通过当前安装、公钥绑定与任务授权，把限定消息交给原 `TaskService`，并支持独立滴滴只读服务 Agent。它复用原任务防重、版本和输出保护；MCP/A2A 与 Relay 访问同一业务核心。未配置适配器时，收到普通消息不会创建任务或授权。

相关资料：[任务验收](../architecture/task-closure.md)、[会员来源凭据](member-sources.md)、[JOSE](https://github.com/panva/jose)、[JWE](https://www.rfc-editor.org/rfc/rfc7516.html)、[DPoP](https://www.rfc-editor.org/rfc/rfc9449.html)。

## Cloudflare 与 PostgreSQL 的隔离迁移预备

`apps/relay/cloudflare.ts` 是 Worker 请求入口，`packages/relay/postgres-store.ts` 使用 PostgreSQL 事务和每个 Relay schema 的事务锁保护登记、配额、去重、撤销和收件语义。入口从 Cloudflare 的 `CF-Connecting-IP` 取得客户端地址，在共享存储中限制入口速率，并用有过期时间的租约限制跨实例长轮询。每个请求独立创建和关闭数据库客户端；Hyperdrive 承担连接复用。此入口仍需按目标账户配置、验收后才能投入使用，不会自动替换现有 Relay。

Worker 配置示例见 [`apps/relay/wrangler.example.jsonc`](../../apps/relay/wrangler.example.jsonc)；复制到忽略目录后须调整 `main` 相对路径。Worker 绑定 `RELAY_DATABASE`（Hyperdrive）和 `RELAY_SCHEMA`；另需设置 `EIGOS_RELAY_PUBLIC_URL`、`EIGOS_RELAY_OAUTH_ISSUER`、`EIGOS_RELAY_OAUTH_AUDIENCE`、`EIGOS_RELAY_OAUTH_JWKS_URL`、`EIGOS_RELAY_CLIENT_IDS`，可选 `EIGOS_RELAY_TENANT_CLAIM`。生产只允许 HTTPS 和 JWT 登记。Hyperdrive 连接应使用可信数据库根证书和 `verify-full`，并关闭查询缓存；为 Relay 使用只具备其 schema 权限的独立数据库角色。

离线导入入口先运行 `npm run build`。准备**已停止源写入且完成 checkpoint 的数据库副本**，将副本切换到 SQLite `DELETE` journal 模式并确保不存在 `-wal`／`-shm`／`-journal` 文件；不要更改原数据库。通过私有环境变量 `EIGOS_RELAY_POSTGRES_URL` 和 `EIGOS_RELAY_POSTGRES_CA_FILE` 提供 PostgreSQL 连接与根证书路径，连接 URL 不接受查询参数，密码中的特殊字符须做 URL 编码。先使用 `shasum -a 256 /private/offline-relay.sqlite` 计算并审查源文件摘要，之后显式执行：

```sh
node scripts/relay-postgres-import.mjs --apply --snapshot /private/offline-relay.sqlite --expected-file-digest <reviewed-sha256> --schema eigos_relay_example
```

只接受 UTF-8 编码的绝对快照路径和新的 `eigos_relay_` 命名空间。导入检查数据库标识、完整性、表和列，绑定事先审查的文件 SHA-256，使用一个 PostgreSQL 事务分批复制并核对全部行，单行编码超过 2 MiB 时拒绝导入；导入回执记录文件摘要、逐表摘要和数量且通过数据库触发器禁止更新或删除；发现目标存在、外键失败或读回不一致时回滚，不覆盖原有 schema。若提交时连接中断，结果可能未知；必须先检查原目标的 `relay_migration_receipt` 与已审查摘要，不能自动重试或覆盖。回执只证明导入时的快照和目标读回一致，不证明导入后目标未发生变化；切换前仍须确保源端停止写入并核对目标后续变化。成功只表示快照已验证导入，不代表线上已切换。导入后须单独创建受限角色并授权该 schema 的表、序列和 `relay_cleanup(bigint,bigint,bigint)` 函数；不应将管理员密码交给 Worker。

现有 Relay 使用的 origin、JWT audience、客户端凭据和 DPoP 地址校验相互绑定。切换前需要逐项确认新 origin、身份提供方 audience、已登记客户端和待发／待收消息的恢复方式；仅更改 DNS 或部署 Worker 不能迁移连接器身份。测试环境应使用独立身份签发器和合成节点，不应授予真实业务权限。

### 导入后的运行角色授权

`node scripts/relay-postgres-grant.mjs --apply --source-stopped --schema eigos_relay_live_<id> --role eigos_relay_live_<id> --source-digest <已审查快照的 SHA-256>` 只处理与目标 schema 同名的独立登录角色。连接环境沿用 `EIGOS_RELAY_POSTGRES_URL` 和 `EIGOS_RELAY_POSTGRES_CA_FILE`，不得把密码写入参数。工具要求目标角色无继承、无成员关系、无管理属性和目标外数据访问；在同一事务持有 Relay 锁，核对导入回执、各表内容摘要、列结构、约束、清理函数及消息序列，再授权运行所需的表操作、序列和清理函数。迁移回执不可由运行角色读取或更改。它只适用于导入后、目标尚未投入使用的状态；已经授权的角色会被拒绝，提交结果不明时必须先独立检查，不能盲目重试。

`--source-stopped` 是操作员的断言，不是自动停写检查。授予权限不会部署或启用 Worker，也不能证明源 Relay 已停止写入。切换前仍需复查角色有效权限、目标部署绑定以及全部节点；为避免丢失并发写入，整个导入、授权和节点切换期间都要保持源端停写。

### 节点地址切换

`node scripts/relay-client-repoint.mjs --apply --source-stopped --config /private/cutover.json --credential /private/node.json --agent-id <existing-agent-id>` 是离线操作入口；可用 `--state` 指定非默认节点状态文件。`--source-stopped` 是操作员对源 Relay 已停止写入的明确断言，程序无法替代全体节点停写和源快照核对。**不得在旧 Relay 继续接收消息时切换节点。**

配置文件须为当前用户持有的 `0600` JSON，包含以下已审查信息：

```json
{
  "oldUrl": "https://old-relay.example.com",
  "newUrl": "https://worker-name.account-subdomain.workers.dev",
  "targetSchema": "eigos_relay_example",
  "expectedSourceDigest": "<reviewed-snapshot-sha256>",
  "workerName": "worker-name",
  "workersSubdomain": "account-subdomain",
  "projectRef": "<20-character-supabase-project-ref>",
  "poolerHost": "<session-pooler-host>",
  "runtimeRole": "<reviewed-hyperdrive-role>",
  "caCertificateId": "<cloudflare-ca-certificate-id>",
  "expectedCaSha256": "<reviewed-ca-pem-sha256>",
  "expectedScriptEtag": "<reviewed-worker-script-hash>",
  "expectedCompatibilityDate": "2026-10-02",
  "expectedCompatibilityFlags": [],
  "wranglerPath": "/absolute/path/to/wrangler",
  "wranglerConfigPath": "/private/wrangler.json",
  "auth": { "issuer": "https://issuer.example.com", "audience": "https://relay.example.com", "jwksUrl": "https://issuer.example.com/jwks", "clientIds": "<reviewed-client-ids>" }
}
```

连接仍由 `EIGOS_RELAY_POSTGRES_URL` 和 `EIGOS_RELAY_POSTGRES_CA_FILE` 提供；密码只放私有环境或钥匙串，不放配置文件。`expectedScriptEtag` 必须来自已审查的构建／部署记录，不能临时信任目标自己返回的值。 `caCertificateId` 与 `expectedCaSha256` 必须分别来自已审查的 Cloudflare CA 配置和本地 CA 文件；本工具核对配置 ID 与本地文件摘要，但不会读取 Cloudflare 证书内容来证明两者相同。当前验证器只支持已审查的 `workers.dev` 地址、Supabase 会话连接池和直接数据库 Hyperdrive；自定义域名及其他数据库连接方式须先实现相应的独立绑定验证。

入口会核对目标导入回执、原节点凭据、Cloudflare 100% 单版本部署和 Worker 版本／脚本摘要／兼容设置、Hyperdrive 目标、CA 与 TLS、认证参数，再向目标发送节点证明。切换前后会复核目标；本地状态在未完成时保持迁移围栏，客户端拒绝启动，重复执行可恢复中断。须在整个切换期间保持源 Relay 停写及目标部署配置不变。该入口不会审查数据库角色是否还拥有其他权限，也不会迁移 OAuth 签发配置、业务授权或其他节点；这些项目须单独核验，不能据此认定所有业务服务已经迁移。

### 单独暂停和恢复本机 Gateway

使用包含此功能的 `run-local.mjs` 启动器，并在启动前设置 `EIGOS_RELAY_CUTOVER_SIGNALS=true`，并等待 `Gateway cutover control ready` 后，才可由同一系统用户向**启动器进程**发送 `SIGUSR1`。Worker 首先停止领取新任务，并在现有任务和恢复工作结束后确认排空；启动器随后正常停止 Gateway，并写入 `Gateway paused; Worker claims drained`。此前不能认为 Gateway 已停止。默认未启用这些信号，已运行的旧启动器不会自动获得此能力。

第一次 `SIGUSR2` 启动新的 Gateway 并重新读取 Relay 配置文件；出现 `Gateway ready; Worker claims remain paused` 后，须另行检查 Gateway 健康状态、身份、目标地址及节点重连。确认后第二次 `SIGUSR2` 恢复 Worker 领取任务，并等待 `Worker claims resumed`。其他阶段的过早恢复信号会被忽略。Worker 在排空时继续保持现有任务的授权和租约；如果任务长期不结束，Gateway 会保持运行，不能强行将其视为已暂停。

此控制不停止独立服务 Agent、PA、源 Relay 或其他写入者，也不验证数据库快照、迁移围栏、节点凭据和目标环境；必须分别完成和核实这些步骤，才能认定源端已停写。Gateway 或 Worker 非正常退出仍按启动器既有的故障处理停止进程组，不会被记录为成功暂停。
