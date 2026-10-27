# Relay 任务与只读来源接入

此适配器把 PA 的加密消息交给现有主实例 `TaskService`，并把选定的滴滴只读调用转交给持有来源凭据的服务 Agent。Relay 仍只保管密文。任务、任务授权、工作租约、本体发布引用和验收均留在唯一的 `com.eigos.primary` 业务库中。

```text
PA（自己的 OAuth 与 Relay 私钥）
  → Relay 密文信箱 → 主实例 Gateway → 原 TaskService / Worker / Ontology
  ← 加密 TaskView ←        │
                           └→ Relay → 滴滴服务 Agent → 滴滴只读 MCP
                                       │
                          调用前向主实例核验当前任务与执行租约
```

## 身份与权限

PA 通过原登录流程和 `AgentConnector` 取得有效的 Foundation 安装身份。`POST /relay/bind` 同时验证其 OAuth 令牌、当前 AgentGrant、已登记 Relay 名片和该私钥的 DPoP 证明，把完整公钥 ID 绑定到准确安装。绑定只保留任务权限，最长 15 分钟，且不超过 OAuth 令牌或 AgentGrant 的到期时间。其他安装不能接管同一个公钥；重新绑定、任务读取和发送结果前都检查当前授权。

`POST /relay/revoke` 撤销本安装的公钥路由，该公钥不能通过重启或重新绑定恢复；重新接入需明确建立新节点身份。会员、安装、AgentGrant、TaskDataGrant 或来源权限的撤销仍由已有权限系统处理；Relay 联系接受不能恢复这些权限。原始 OAuth 令牌只发给其既有 Gateway；刷新凭据保留在 PA。Relay 消息不携带 OAuth、来源凭据或 Worker 租约令牌。

任务信封使用 `eigos.task-relay/1`，支持 `task.submit`、`task.get`、`task.reply` 和 `task.cancel`。提交只进入原有 `eigos.delegate`，不提供付款、计划批准或额外管理动作。主实例以安装 ID 和稳定业务 `requestId` 构造防重键；传输重试不会另建任务或重新发放任务授权。

响应是原有受字段和输出权限约束的 `eigos.task.v2`，包括主实例 `authorityId` 与原任务 ID。Relay 的 `received` 是连接器收件状态；业务完成仍以任务状态、验收和当前可读结果为准。超过 32 KiB 的任务视图返回 `RESULT_TOO_LARGE`，调用方用原任务 ID 从现有认证 HTTP/MCP/A2A 入口读取，不截断结果。

## 主实例配置

只有已配置 `EIGOS_AUTHORITY_FILE` 的 Foundation 主实例可以开启适配器。Gateway 与 Worker 使用相同的业务库和以下配置：

| 配置 | 作用 |
| --- | --- |
| `EIGOS_TASK_RELAY_FILE` | 指向主实例私有的 Relay 配置 JSON |
| `EIGOS_DIDI_RELAY_AGENT_ID` | 准确的滴滴只读服务 Agent 公钥 ID |

主实例 Relay 配置文件须为当前系统用户所有、0600 的普通文件：

```json
{
  "version": 1,
  "relayUrl": "https://relay.example.com",
  "credentialPath": "/private/eigos/relay-node.json",
  "displayName": "EIGOS",
  "enrollmentKeyFile": "/private/eigos/relay-enrollment-key.json",
  "operatorInstallationId": "<明确获准管理此节点的安装 UUID>"
}
```

`credentialPath` 由 `RelayClient` 生成并独占使用。可选 `statePath` 默认为该路径加 `.sqlite`。私钥与节点状态不可指向 Relay、会员或业务数据库。

`enrollmentKeyFile` 是可选的独立 Ed25519 私有 JWK（仅 `kty`、`crv`、`x`、`d`），用于主实例签发节点登记许可。由操作员在私有目录生成，不能使用节点签名私钥或 OAuth 密钥代替。若采用原有外部 Relay 身份提供方，可不启用此签发入口。

启用主实例签发后，Relay 继续使用 JWT 模式，配置为：

- issuer：主实例 canonical origin。
- audience：准确的 Relay origin。
- JWKS：`<主实例 origin>/.well-known/eigos-relay-jwks.json`。
- client ID：`eigos-primary-relay-enrollment`；tenant claim：`tenant_id`。

`POST /relay/enrollment` 要求已有会员安装授权及目标公钥的 DPoP 证明，签发最长一分钟、仅限该节点的 `relay:enroll` 许可。它不新建业务 Grant。节点的登记、续期、列表和撤销均受该公钥限制。Relay 的连接资格仍为 24 小时，续期需要新的有效登记许可。

主实例自身的连接器已占有私钥文件，操作员通过原认证入口调用 `POST /relay/enroll-primary`，正文 `{}`，完成首次登记。只有配置的 `operatorInstallationId` 可以调用。续期正文为 `{"renewRequestId":"<固定 UUID>"}`，重试保留此 ID。

`GET /.well-known/eigos-task-relay` 返回准确的主实例 ID、Gateway 公钥 ID、Relay origin 与绑定入口。`/health` 的 `taskRelay.status` 单独报告适配器状态；原主实例健康状态不能替代 Relay 链路验收。

## 滴滴服务 Agent

服务 Agent 独立运行，持有原来源绑定的私有 Key 文件；此只读链路的 Gateway/Worker 不加载 Key 内容。服务 Agent 的环境不需要业务库、会员库或模型凭据。已有独立 Mock 程序保留自己的连接器和计划授权，不经过此只读 Relay 适配器。`EIGOS_SERVICE_AGENT_FILE` 指向 0600 配置文件：

```json
{
  "version": 1,
  "authorityId": "<主实例 UUID>",
  "gatewayAgentId": "<完整的 agent_... 公钥 ID>",
  "gatewayOrigin": "https://primary.example.com",
  "relayUrl": "https://relay.example.com",
  "credentialPath": "/private/didi-service/relay-node.json",
  "ledgerPath": "/private/didi-service/read-receipts.sqlite",
  "displayName": "DiDi read-only service",
  "binding": {
    "bindingId": "<原来源绑定 ID>",
    "keyFile": "/private/didi-service/didi-key",
    "keySha256": "<准确的凭据 SHA-256>",
    "environment": "production",
    "auditDirectory": "/private/didi-service/audit"
  }
}
```

先用控制者的现有 `AgentConnector.enrollTaskRelay(node)` 登记服务节点，再运行 `npm run dev:service-agent`，构建后使用 `npm run start:service-agent`。主实例与服务 Agent 只自动接受配置中准确匹配的对端；其他联系不获得来源调用权限。

启用 Relay 会改变滴滴程序的 `configurationDigest`，其中包含主实例和服务节点身份。操作员须按新来源配置复核本安装的 SourceAuthorization。新任务从当前有效父授权取得有界 TaskDataGrant；已有任务授权不会延期或升级。Gateway 和 Worker 必须使用相同配置，以同一发布引用解析本体动作。

模型仍从本体选择动作、依赖和输入。连接器只转交已经选定的 `maps_textsearch` 或 `taxi_estimate`。主实例在现有业务库持久记录该只读请求，绑定任务、请求版本、计划、意图、尝试、模型决策、输入摘要和 Worker 租约。

服务 Agent 在实际来源调用前通过自己的 DPoP 证明访问主实例的准确授权检查入口。主实例复查当前任务授权、来源权限、动作权限、计划和租约，以及任务发布引用下的 Pipeline 状态和依赖快照；失效时拒绝。消息入队后发生的验证到期或撤销也会阻止来源调用。来源响应返回后再次检查，主实例接收和 Worker 投影时也复查。来源凭据的绑定、网络端点、工具白名单和回执校验继续由原 `DidiMcpConnector` 与程序执行。

## PA 接入与恢复

`TaskRelayClient` 是宿主适配器，不把凭据交给模型。示例可从私有请求文件运行：

```sh
npm run example:relay-task -- /private/my-pa/relay-request.json
```

文件包含 `gatewayOrigin`、`relayUrl`、`paCredentialPath`、`nodeCredentialPath` 和 `operation`。首次用 `enroll` 登记，再用 `bind` 建立安装路由。`submit` 另提供明确 `requestId` 与 `goal`；`get` 提供新的读取 `requestId` 和原 `taskId`。`renew` 仅续期通信资格。

现有 `integrations/grok/eigos-native/client.mjs` 也支持 `relay-enroll`、`relay-renew`、`relay-bind` 和 `relay`。在原私有 PA profile 中增加 `relay` 对象，包含 `baseUrl`、`credentialPath`、准确的 `authorityId` 与 `gatewayAgentId`。客户端在写入前核对这些固定身份。`relay --input <file> --output <file>` 读取保存的任务命令并输出原任务视图；`relay-renew` 的输入文件必须包含固定的 UUID `requestId`。请求与回执中均不放凭据。

- 短暂传输错误：使用已保存的 `messageId` 重发同一密文。
- 消息或短期绑定已到期：重新认证绑定，保留业务 `requestId`，生成新的传输消息 ID。主实例仍执行原防重规则。
- Gateway 在任务提交后中断：重放回到同一任务，发送前重新生成当前有权限的视图，不清空业务库或重发授权。
- 服务 Agent 在回执保存后中断：恢复原回执并重新核验权限，不重复调用来源。
- 来源调用途中中断：同一调用 ID 返回 `READ_OUTCOME_UNKNOWN`。后续只读尝试由原任务和 Worker 决定，不能把收件或未知结果写成已完成。
- Worker 租约丢失、任务撤销或来源撤销：旧来源请求和迟到结果不可继续使用。保留原任务及证据，由当前有效执行尝试恢复。

真实部署应分别回读主实例身份、当前安装和任务授权、来源调用回执、独立任务验收以及 PA 收到的同一任务结果。合成测试只能证明其覆盖的通信与权限行为；真实估价也不证明下单、付款或行程完成。

相关：[Relay 通信边界](relay.md)、[统一运行权威](../architecture/runtime-authority.md)、[任务验收](../architecture/task-closure.md)。
