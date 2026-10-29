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
