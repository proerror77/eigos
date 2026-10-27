# PA 接入 EIGOS

MCP 与 A2A 共用任务、身份、权限和执行状态。先发现当前实例的接口与能力，再提交明确目标；服务配置和业务授权分别检查。

## 发现与认证

- `GET /health` 返回实例、运行契约和构建摘要。
- `GET /.well-known/agent-card.json` 返回 A2A Agent Card。
- `GET /.well-known/oauth-protected-resource` 返回 OAuth 资源与 scope 元数据。
- MCP 使用 `/mcp`，A2A JSON-RPC 使用 `/a2a`。

缺失认证配置默认拒绝。开发 Bearer 令牌只用于 loopback；会员使用受信发行者的 OAuth 身份。会员资格、令牌 scope、具体来源连接和准确业务许可都不能相互替代。令牌不得放入目标文本、模型参数或日志。

## 任务接口

以 MCP `tools/list` 返回的输入 schema 为准：

| 工具 | 用途 |
| --- | --- |
| `get_runtime_info` | 核对当前实例与版本 |
| `list_services` | 发现当前身份可见的能力 |
| `submit_task` | 以稳定 `requestId` 提交 `service`、目标及约束 |
| `get_task`、`list_tasks` | 查询有权限的任务摘要与结果 |
| `reply_to_task`、`amend_task` | 在原任务中补充或更正信息，绑定当前版本 |
| `resume_task` | 技术问题修复后续接原任务 |
| `cancel_task` | 取消任务；不自动撤销已发生的供应商操作 |
| `reconcile_task` | 按原操作身份查证未知结果 |
| `revoke_task_authorization` | 阻止未来派发，保留原操作查证责任 |
| `control_task_observation` | 对已明确委托的有界观察报告提示、停止或按原预算恢复 |

当前通用委托入口为 `eigos.delegate`。任务说明能力只交付说明文档；不能把它描述为购物、预约或出行已经完成。

需要地点的任务，PA 先从用户已保存地址或本次设备定位取得地址并确定城市，再通过同一个 `submit_task` 或 A2A data part 传入可选 `locationContext`。原始 `goal` 保持用户原话；“家”等别名通过上下文绑定，不要求用户重述完整地址：

```json
{
  "service": "eigos.delegate",
  "goal": "从家到前滩太古里，只查估价，不下单、不付款",
  "locationContext": {
    "city": "上海市",
    "origin": { "name": "PA 已取得的准确地点名", "address": "PA 已取得的完整住址", "label": "家", "source": "saved_address" },
    "destination": { "name": "前滩太古里", "source": "user_provided" }
  },
  "requestId": "stable-location-delegation-id"
}
```

`source=current_location` 时必须携带实际 `observedAt`。地址上下文先写入当前 `ServiceRequest.confirmedInputs.location`、`RequestSpecification` 与有原始指令依据的 `RequestFact`，Worker 从同一任务发布读取这些事实，继续统一的 Ontology 目标、动作和验收流程。它们属于 PA／用户提供的事实，不是供应商坐标、履约证明或业务许可。供应商地点必须与当前城市、名称及已提供的完整地址相符，才能把“家”等别名计入路线验收。

已确认信息在原任务内沿用；补充车型等信息不清空地址。确需更正时，在正常 `reply_to_task`／`amend_task` 中传入 `locationContext`，未出现的端点保持，`null` 明确清除对应端点。已有固定业务操作不能靠改地址绕过原操作查证。普通约束直接保留在 `goal`，不要让 PA 把中文原话填成内部 predicate 编号。`get_task` 摘要中的 `delegation.knownLocations` 供 PA 在补问前核对，只有真正缺失或有歧义的事实才交给用户。

A2A 使用 `SendMessage` 提交或续接，使用 `GetTask` 回读。长任务可以设置 `configuration.returnImmediately=true`。保存原 `taskId`、`contextId`、请求标识及版本；补问、授权和恢复沿用原任务，不能为了清除未知状态创建替代任务。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "SendMessage",
  "params": {
    "configuration": { "returnImmediately": true },
    "message": {
      "messageId": "replace-with-a-stable-unique-id",
      "role": "ROLE_USER",
      "parts": [{ "data": { "service": "eigos.delegate", "goal": "根据给定信息生成任务说明" } }]
    }
  }
}
```

查询返回的摘要限制内部执行信息；具体交付物在最终 artifact 中。`working` 可以包含等待 Worker、来源或异步回读；`paused` 的技术恢复信息与实际缺少用户选择分别表达。只有完成验收后的结果才能作为所请求交付的依据。

## 有界观察

对已配置并验证了 Pipeline 观察适配器的来源，PA 可以在同一次提交中提供 `observationBudget`：

```json
{
  "until": "2026-11-01T10:00:00+08:00",
  "maxReads": 100,
  "maxActiveMs": 60000
}
```

`until` 应替换为本次委托的未来截止时间。此预算只允许 Worker 在原任务权限内重复一个模型选定、已经独立验收的只读步骤；它不启用尚未接入的来源。模型不能增加期限和额度。任务和来源授权可能更早到期。

`get_task` 的 `observation` 返回累计用量和可读观察项；`paused`、`stale`、`unavailable` 或 `coverageGapAt` 表示观察有未解决的限制，不能声称完整覆盖。结束观察不等于完成报名、到场、日历写入或付款。未变化的读取保持持久等待，不反复调用模型。

MCP 控制示例（ID 和修订来自当前任务）：

```json
{
  "action": "stop_observation",
  "taskId": "00000000-0000-4000-8000-000000000001",
  "expectedRevision": 1,
  "requestId": "stable-observation-stop-id"
}
```

调用 `control_task_observation`；可选 `watchId` 限定一个观察。`resume_observation` 使用同一结构并重新检查原来源，累计用量和截止时间不变。`report_observation_change` 另外要求 `watchId`、`eventId` 和 64 位十六进制 SHA-256 `contentDigest`，不能传来源载荷；提示只安排独立回读。

A2A 在原 `taskId`／`contextId` 的 `SendMessage` data part 中传相同 `action`、`expectedRevision` 及可选字段；幂等标识使用 `message.messageId`。观察摘要位于 `Task.metadata.observation`。两种协议都检查同一任务、当前修订和权限，不会由 Gateway 执行来源调用。Foundation 只返回当前接收方可读的字段和观察信息。

## 授权与支付

`POST /tasks/:taskId/authorize` 接受当前任务返回的准确许可。数据写入、沙箱金融效果、零费用参与者预约和未付款结账草稿使用各自的范围；不能交换或扩大授权。

启用私密结账后，MCP 提供 `authorize_checkout_draft`。它只允许一次绑定商家、商品和数量的未付款草稿，不允许付款、完成订单或提交买方资料。

预约付款由 PA 选择 `select_payment_route` 并通过 `report_payment_result` 通知结果。通知不是付款证明；EIGOS 独立读取原服务商记录。付款未知或已提交时不得换路线重付。完整合同见[预约付款](integrations/booking-payment.md)、[免费预约](integrations/free-booking.md)、[Shopify 草稿](integrations/shopify-checkout.md)和[Shopify PA 付款沙箱](integrations/shopify-pa-payment.md)。

## 本体、会员与网络

`describe_ontology`、`query_ontology`、`evaluate_ontology` 使用同一已发布本体；任务查询可绑定 `taskId` 或准确发布引用。管理工具 `query_ontology_definitions`、`manage_ontology_definitions`、`prepare_ontology_action`、`approve_ontology_action` 分别检查读取、编辑、发布和对象写入权限。

会员登记见[Agent 接入流程](guides/agent-onboarding.md)，账号来源见[会员来源连接](guides/member-sources.md)。协作网络通过 `network_query`、`network_command`、`network_updates` 和命令回执接口工作；内容可见性不授予执行或付款权限。

可复用客户端位于 `packages/agent-client/` 和 `integrations/`。示例位于 `examples/`。实际启用范围见[能力目录](architecture/capabilities.md)。

## 受保护模式

上述完整主线接口对应 legacy。显式 `EIGOS_SECURITY_MODE=foundation` 使用共同 TaskView、任务范围查询和独立来源／输出许可；未审查的 legacy 管理与网络入口不自动开放。接入合同及限制见[本体权限指南](guides/ontology-security.md)。目标覆盖与统一结果回写见[任务闭环](architecture/task-closure.md)，测试下单见[滴滴 Mock](integrations/didi-order-test.md)。
