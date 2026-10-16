执行被工具权限拦截：首次通过 `csv_normal.submit_task` 创建订单时，返回 **“MCP tool call requires approval, but approval policy is never”**。这是运行环境的审批限制，不是要求你再次确认模拟付款；我未改用其他通道绕过。

三条实际结果：

| 场景 | 实际结果 | taskId / orderId | 付款、验收及补救 |
|---|---|---|---|
| normal | 创建调用被拦截 | 未返回 | 未执行 |
| repair | 未创建 | 无 | 未执行 |
| refund | 未创建 | 无 | 未执行 |

已发现三个网关均提供 `data.quality.audit.simulated`，但未取得任何报价，无法继续确认或查询。需由运行环境允许这些 MCP 操作后才能完成演示。

**本演示为模拟付款，无真钱，不等于支付宝接入。**