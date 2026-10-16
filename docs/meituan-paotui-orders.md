# 跑腿订单与支付链接：待启用实现

2026-10-15。当前本地运行明确设置 `EIGOS_PAOTUI_ORDERS_ENABLED=false`。代码已接入官方 CLI 的订单和收银台链接能力，但未创建真实美团订单、未生成真实订单的支付链接、未付款。

## Agent 调用

MCP submit_task 和 A2A SendMessage 的 data part 共用服务 `meituan.paotui.order`，goal 为以下 JSON 的字符串，requestId/messageId 使用各次操作的幂等键。通过 get_task/GetTask 读回结果；单次操作任务 completed 只表示操作处理完毕，不表示订单履约。

1. prepare_order：

```json
{"action":"prepare_order","intentId":"one-delivery-intent","preview":{"action":"preview","senderAddressId":"saved-id-A","recipientAddressId":"saved-id-B","goodsName":"文件","category":"文件","weightKg":1,"service":"ordinary"}}
```

得到 previewId、digest、amountFen、expiresAt 和完整路线/物品/服务/报价摘要。状态为 awaiting_confirmation。intentId 必须稳定，同一意图不得因 HTTP 重试生成新值；同意图参数改变会被拒绝。改变路线、物品、重量或服务需要新的意图/预览和新的用户确认。本地预览有效期保守设为5分钟，非美团官方有效期承诺。

2. 将完整摘要和最终金额展示给用户，获得其明确确认后才可发送 confirm_order：

```json
{"action":"confirm_order","previewId":"returned-uuid","digest":"returned-digest","amountFen":5250,"confirmation":"确认下单"}
```

确认请求只引用已保存的预览，不能修改路线、商品或价格。备注等新要求需要重新预览；“放门口”等文本不会通过确认校验。接口的确认字段是客户端提交的批准记录，并不独立证明发言者是人类；接入方必须把明确的用户批准绑定到该预览，不得由模型自行补写。当前全局关闭真实下单，因此即便提交正确确认也会被拒绝。

3. 成功创建订单后才可请求 payment_links：

```json
{"action":"payment_links","previewId":"returned-uuid"}
```

返回移动端、PC端 HTTPS 美团收银台链接及登录链接。链接生成不会执行支付，不证明付款或配送。真实收银台域名白名单需要在首次获准的真实联调中核实；当前只允许 meituan.com 及其子域。客户端不得抓取或自动打开链接完成支付。

4. order_state 查询本地工作流结果：

```json
{"action":"order_state","previewId":"returned-uuid"}
```

这是 EIGOS 保存的操作状态，不是实时美团配送/支付查单。awaiting_payment 表示已获取供应商订单标识，未验证付款。submission_unknown 表示可能已提交但结果不明，orderCreated 为 null，必须人工核查。

## 防重与恢复

- 独立 SQLite 数据库在主数据库路径后加 `.paotui`；每个 owner+intent 唯一。
- 在外部调用前原子占用预览并持久化确认摘要/时间。并发或换 requestId 重试同一预览不会再次提交。
- submitting 或 submission_unknown 在重启后不会自动重放。不能通过新建意图绕过未知订单核查。
- 没有宣称供应商 exactly-once；网络超时无法证明未下单。此时停在未知状态，人工核查后才能另行处理。
- 订单已创建、取支付链接失败时，可以用新 requestId 重试 payment_links，只取链接，不重提单。
- 外部订单任务不接受 cancel_task 作为撤销订单；取消真实订单需美团端另行处理。
- 官方预览凭据、提交参数（包含联系人电话）与支付凭据保存在 AES-256-GCM 加密订单库；本地密钥文件为同路径 `.key`，权限0600。数据库与密钥必须一起备份，密钥丢失不会自动生成替代密钥覆盖旧数据。
- 个人美团授权仅用于本地固定开发身份，禁止公开服务和多会员共享。授权令牌变化后须重新预览。

## 验证证据与限制

32项测试、类型检查、构建通过。测试替身验证了 MCP预览→A2A确认→支付链接、跨入口/重启/并发防重复、报价篡改/过期/归属拒绝、提交超时停止重试、支付链接重试不重新下单、关闭开关的双层拦截与凭据加密。

本地实际 MCP Agent 验证：真实报价5250分；确认调用被关闭开关拒绝；读回状态仍 awaiting_confirmation，orderCreated=false。私有回执 `data/paotui-staged-verification.json` 不进入Git。

真实 submit_order 返回结构、实际 checkout 域名、优惠券及最终实付金额、订单状态/退款尚未生产验证。启用开关前必须另获用户实际下单授权，并在首次真实联调核实这些条件。本次不能据测试替身或预览认定真实下单和支付已打通。

官方依据：https://github.com/meituan/MT-Paotui-For-Client （本机固定版本05ead232ae2b94b9b55b2a1e126e039a1cb6db00）。
