# Stripe Link 手动付款沙箱

Stripe 沙箱商户创建一笔固定金额 USD 1.00 的测试订单。EIGOS 把原订单关联到 PA 的待付款请求，用户在 Stripe 收银台使用自己的 **Link 沙箱钱包**完成付款。EIGOS 按原 Checkout Session 回查并核对实际付款方式。

| Interface | 动作 | Stripe 实现 |
| --- | --- | --- |
| `PayableOrder` | `prepare` | `PrepareStripeLinkPayment` |
| `ManualPayment` | `handoff` | `HandoffStripeLinkPayment` |
| `ManualPayment` | `refresh` | `RefreshStripeLinkPayment` |

`StripeSandboxOrder` 实现 `PayableOrder`，通过一对一关系连接实现 `ManualPayment` 的 `StripeLinkPaymentRequest`。沙箱商户的 `CreateStripeSandboxOrder` 由已授权 PA 显式调用。它按 `orderKey` 去重，创建一个未付款的 Stripe Checkout Session。订单记录保存同一商户订单引用和 Session ID。

## 测试连接

在隔离的 EIGOS 实例中发布本体，为测试 PA 授予相应对象读取、函数执行、Action 和 `Eigos/source/StripeSandbox` 读取权限。Gateway 和 Worker 读取同一个 `EIGOS_STRIPE_SANDBOX_CONNECTION_FILE`。该私有 JSON 文件包含 `owner`、`accountId`、`merchant`、`expiresAt`、`credentialFile` 和 `credentialSha256`。配置和密钥均为绝对路径、本机用户独有的私有文件。凭据文件只存 Stripe 测试密钥。指纹使用去掉首尾空白后的密钥计算。

1. 用 `CreateStripeSandboxOrder` 创建订单，传入本次业务订单专用的 UUID `orderKey`。
2. 对原订单调用 `PayableOrder.prepare`，得到待付款对象。
3. 在原 PA 任务中调用 `ManualPayment.handoff`。PA 从 `list_pa_requests` 或 `GET /pa/requests` 领取 `payments.manual_checkout`。Checkout URL 只通过已认证待办交给该 owner，PA 展示给用户。
4. 用户在 Stripe Checkout 中使用 [Link 测试数据](https://docs.stripe.com/payments/link/checkout-link#test-the-integration)亲自付款。完成后 PA 回复 `{ "decision": "check_status" }`，原任务恢复并重新查询同一个 Session。用户可以选择 `leave_unpaid`，之后也可独立调用 `ManualPayment.refresh`。

Stripe 返回的收款账号、原订单引用、Session、金额、币种和付款方式需要一致。仅用普通测试卡支付时状态为 `paid_other_method`。会话打开、页面跳转或 PA 回答均不能将订单标为已付款。外部创建请求结果不明时保留原操作。PA 核实商户后台的原 Checkout Session 后可用 `RecoverStripeSandboxOrder` 回查并登记该笔原订单。此试点按现有 PA owner 隔离，使用独立测试身份。沙箱 API 证据标记 `provider_sandbox`，测试夹具标记 `synthetic`。
