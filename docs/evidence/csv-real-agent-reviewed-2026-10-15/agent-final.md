已完成三个场景，每个仅建一张订单，均确认模拟付款 100 分 CNY（¥1.00），并按指定 MCP/A2A 通道读回终态。

1. **normal：正常交付通过**
   - taskId：`17f88142-ddd4-4617-a293-103dc8f5942c`
   - orderId：`060394dc-baff-4b0e-b699-b5a74d571ad3`
   - 状态：`completed`；付款 `paid`；验收 `accepted`；补救 `none`；`step=done`。

2. **repair：首次拒收，补交后通过**
   - taskId：`655ef9fd-73cb-4b56-9506-5dd7bb13a445`
   - orderId：`a3ce908a-60af-4a25-aa1c-de6841533374`
   - 已核实轨迹：`delivery_rejected → redelivery_requested → delivery_accepted`，两次验收分别为 false、true。
   - 状态：`completed`；付款 `paid`；验收 `accepted`；补救 `none`；`step=done`。

3. **refund：持续错误，模拟退款完成**
   - taskId：`4d5b43ec-7b18-45ff-a57a-57939b9895e4`
   - orderId：`aa25c07d-155e-49f3-8a94-87ff062bd8c2`
   - 首交、补交均被拒收；轨迹包含 `refund_pending → simulated_refund_verified`。
   - 终态：任务 `failed`；付款记录 `paid`；验收 `rejected`；**`remediation=refunded`、`step=done`**，退款已核验完成。

**以上均为本地模拟，无真钱；模拟付款与退款≠支付宝接入。**