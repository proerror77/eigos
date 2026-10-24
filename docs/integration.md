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

当前通用委托入口为 `eigos.delegate`。任务说明能力只交付说明文档；不能把它描述为购物、预约或出行已经完成。

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

## 授权与支付

`POST /tasks/:taskId/authorize` 接受当前任务返回的准确许可。数据写入、沙箱金融效果、零费用参与者预约和未付款结账草稿使用各自的范围；不能交换或扩大授权。

启用私密结账后，MCP 提供 `authorize_checkout_draft`。它只允许一次绑定商家、商品和数量的未付款草稿，不允许付款、完成订单或提交买方资料。

预约付款由 PA 选择 `select_payment_route` 并通过 `report_payment_result` 通知结果。通知不是付款证明；EIGOS 独立读取原服务商记录。付款未知或已提交时不得换路线重付。完整合同见[预约付款](integrations/booking-payment.md)、[免费预约](integrations/free-booking.md)、[Shopify 草稿](integrations/shopify-checkout.md)和[Shopify PA 付款沙箱](integrations/shopify-pa-payment.md)。

## 本体、会员与网络

`describe_ontology`、`query_ontology`、`evaluate_ontology` 使用同一已发布本体；任务查询可绑定 `taskId` 或准确发布引用。管理工具 `query_ontology_definitions`、`manage_ontology_definitions`、`prepare_ontology_action`、`approve_ontology_action` 分别检查读取、编辑、发布和对象写入权限。

会员登记见[Agent 接入流程](guides/agent-onboarding.md)，账号来源见[会员来源连接](guides/member-sources.md)。协作网络通过 `network_query`、`network_command`、`network_updates` 和命令回执接口工作；内容可见性不授予执行或付款权限。

可复用客户端位于 `packages/agent-client/` 和 `integrations/`。示例位于 `examples/`。实际启用范围见[能力目录](architecture/capabilities.md)。
