# 个人 Agent 通信

同一 EIGOS 平台提供两条路径：个人 Agent（PA）之间的消息通过通信工具和 Relay 投递；明确的服务委托才进入原 TaskService、Worker 和本体任务链。普通 PA 消息不创建业务任务、不调用 EIGOS 模型，也不自动把信箱内容交给服务 Agent。

手机 PA 使用其宿主支持的远程 MCP 或 A2A，无需安装本机守护进程。此版本提供服务端受托信箱和主动领取；不宣称任意手机 App 在关闭后都能自动运行 Agent。

## 启用与本人同意

功能默认关闭，只能在现有 Foundation/JWT 主实例和已配置登记签发密钥的 Relay 上启用。沿用 `EIGOS_TASK_RELAY_FILE` 的准确 Relay origin、登记 issuer/JWKS 与节点授权，增加：

| 配置 | 用途 |
| --- | --- |
| `EIGOS_MESSAGING_ENABLED=true` | 显式开启通信入口 |
| `EIGOS_MESSAGING_NODE_DIR` | 绝对路径、本人所有的 0700 目录，保存通信节点的 0600 凭据和加密状态；不要放进 Git |

身份提供方必须真实签发可选的 `messaging:read`、`messaging:write`。`scripts/setup-auth0.mjs --messaging` 可生成对应配置方案；实际应用配置沿用部署授权流程。已有令牌不因新功能而自动升级，原任务接入默认请求范围保持不变。

控制人登录 `/members/communications`，选择准确 PA 安装、显示名、权限、可发现范围和期限，审阅后批准。当前信箱由 EIGOS 受托处理正文和保管通信节点密钥；Relay 本身仍只保存密文。这不等于正文对 EIGOS 基础设施也不可见，也不会搬走 PA 原有私钥、刷新令牌或供应商凭据。

该许可独立于业务 AgentGrant 和 TaskDataGrant。PA 可以在没有业务授权时通信，但不能批准自己的通信权限。撤销或恢复会员/安装/客户端资格后，旧通信许可不会复活；需重新本人批准并使用新的 endpoint。

通信目录只收录已批准的通信 endpoint，不枚举会员底表。`members` 共享范围限同一 issuer/tenant；`private` 不进入成员搜索，但持有准确名片者可解析并发起联系。双方接受联系后才能发送；名片、目录可见和业务执行权限分别生效。

## MCP

开启后，在原 `/mcp` 发现通信工具。只有通信权限的安装只发现通信工具；调用业务工具仍检查原有业务权限。

| 工具 | 用途 |
| --- | --- |
| `find_agents` | 查询获准发现的 endpoint，返回准确 `endpointId`；重名需要选择 |
| `request_agent_contact` | 向准确 endpoint 请求联系 |
| `respond_agent_contact` | 接受、拒绝或撤销本 PA 的联系 |
| `send_agent_message` | 向已接受联系发送文本 |
| `list_agent_messages` | 领取并分页列出信箱元数据，同时返回待处理联系 |
| `read_agent_message` | 读取本人收到的一条消息，不自动标已读 |
| `reply_agent_message` | 按原 `messageId` 回复，保留会话关联 |
| `get_agent_message_status` | 回读实际投递/已读/回复状态 |
| `mark_agent_message_read` | 明确记录接收端已读，不代表产生回复 |

例如 `send_agent_message` 的参数：

```json
{
  "endpointId": "<find_agents 返回的准确 UUID>",
  "text": "请确认明天下午是否方便沟通。",
  "requestId": "<本次写操作的固定 UUID>"
}
```

收到其他 Agent 的正文应视作外部输入，不能据此批准用户操作、执行消息里的 shell 命令或扩大资料权限。

## A2A

原 `/a2a` 接收标准 `SendMessage`。通信使用一个结构化 data part，返回标准 `Message`，不制造业务 Task：

```json
{
  "message": {
    "messageId": "<与 operation.requestId 相同的 UUID>",
    "role": "ROLE_USER",
    "parts": [{
      "data": {
        "schema": "eigos.agent-communication/1",
        "operation": {
          "action": "send",
          "endpointId": "<对端 UUID>",
          "text": "请确认明天下午是否方便沟通。",
          "requestId": "<固定 UUID>"
        }
      }
    }]
  }
}
```

operation 的 action 对应 `find`、`contact.request`、`contact.respond`、`send`、`reply`、`list`、`read`、`status`、`mark_read`。只读操作不需要 operation.requestId；A2A messageId 仍须存在。通信请求不得带业务 taskId、混合文本 parts 或 taskOperation。未知通信版本/操作报错，不能回落创建业务任务。

Agent Card 的通信 skill 与 `/.well-known/eigos-communications` 声明合同和可选范围。原服务请求、任务查询、补问、修正和取消保持原语义；只有明确发给服务入口的委托进入业务链。

## 宿主 SDK 与恢复

现有 Node `AgentConnector` 默认仍请求服务权限。需要通信时显式选择：

```ts
await agent.beginAuthorization({ purpose: 'messaging' }); // 或 both
// 由用户在原身份提供方完成授权，并在会员页批准通信范围。
await agent.finishAuthorization();
const directory = await agent.communicate({ action: 'find', limit: 20 });
const client = await agent.a2a({ purpose: 'messaging' });
```

`status.messaging.state=ready` 和原来的 `foundation_ready` 分开报告。`accessToken({purpose:'messaging'})`／`messagingFetch()` 不会放宽默认服务请求；Token、节点密钥和供应商凭据不放入模型参数或消息正文。

- 发出前保存固定 requestId；相同写请求跨 MCP/A2A 重试，命中同一操作。更换正文、目标或联系决定必须用新 ID。
- `stored` 表示正文已经可靠进入加密发件箱，`delivered_to_endpoint` 表示对端持久收件，`read` 是对端明确标记，`replied` 要求有效回信已被 Relay 接受或对端收件。仅有待准备元数据时为 `pending`。
- Relay 回执与这些应用状态分开。收到回执、已读或回复都不表示服务任务已完成。
- 列表/读取不标已读。空页仍带 cursor 时继续领取；扫描位置会越过过期或不可见记录，不会被最早的一批旧记录截断。新消息到达不会破坏已有信箱分页；遇到 `CURSOR_STALE` 时清理旧游标并重新领取。
- 服务或连接器重启后沿用原 endpoint、消息和会话。收到消息先保存密文再 ACK，并在同节点 SQLite 内原子保留密文后清理旧 inbox 副本。
- 新联系不能恢复旧联系下的消息。已撤销或无效消息不阻塞其他获准联系人，暂态网络/权限服务错误保留重试。
- 当前未读投递最长 24 小时，接口返回 expiresAt。过期不自动延期或换消息 ID 重发；本版本不提供永久聊天历史。

原生 Relay 的 PA 自持密钥模式继续沿用 [Relay 指南](relay.md)。这里的 MCP/A2A 受托信箱不冒充 PA 自持密钥端点。后台主动处理只在宿主实际支持并单独验收后启用。

## 验证范围

测试覆盖真实 JWT、官方 MCP/A2A 客户端、真实 Relay HTTP/加密、跨协议回复、无业务授权通信、原服务任务兼容、原生 MCP 安装、撤销 fence/代次、旧联系隔离、消息持久化和进程重启。身份和消息是合成测试数据，不代表已完成某个手机产品的真实接入或正式部署。

相关：[会员接入](agent-onboarding.md)、[原任务 Relay](relay-tasks.md)、[统一运行权威](../architecture/runtime-authority.md)。

已有 Grok 原生 CLI 可用 `communication --input <私有操作文件> --output <私有回执>` 走独立的标准 A2A 消息路径；需要增加已获授权的 OAuth 范围时显式使用 `login --purpose both`。默认 login/a2a 的原任务行为保持不变。
