# 商家侧 Stripe 测试适配（历史验证路径）

2026-10-20，原实现提交 `23b0c2e`。该组件验证商家侧 Stripe 测试 API、准确授权、独立付款回读和未知结果恢复。原本地验证为 429 项测试与 7 项进程级 E2E；Stripe 响应和模型均使用隔离夹具，没有连接真实 Stripe 账户。

自 `ontology-execution-v13` 起，EIGOS 的预约付款主链路采用 **预约准备 → PA 自有支付 → 服务商付款及预约独立回读**，详见 [PA 预约付款流程](pa-booking-payment-flow.md)。EIGOS 不替 PA 开收款账户，不使用用户的 Stripe/Link 密钥，也不自行生成付款凭证。

## 当前代码边界

- `packages/capabilities/stripe/` 保留商家端测试适配与既有回归用例，便于将来服务商适配研究。
- `createExecutionCatalog` 的旧 Stripe 测试注入仅接受显式测试 transport；注入响应始终标记 `synthetic`。
- Gateway/Worker 不再自动注册商家侧 Stripe 执行器；启用旧 `EIGOS_STRIPE_TEST_*` 配置会被拒绝并提示迁移。
- 已移除旧的账户预检命令；新预约路径无需 EIGOS Stripe 测试密钥。
- 普通商品交易沙箱的历史模拟付款不构成 PA 自有钱包支付或真实履约证据。

## 可复用的测试契约

历史适配固定 Stripe 预览 API `2026-09-30.preview`，测试 PaymentIntent 准备、使用测试助手生成的限额 SPT 确认，以及独立 GET 捕获回读。它保留原操作身份、测试密钥边界、支付凭据隔离、错配拒绝、拒付、认证等待、取消和租约保护。

这些测试证明的是商家侧适配行为，不证明 PA 已连接用户钱包，也不证明真实商家授权、付款或预约确认。PA 的实际钱包授权属于 PA 方；EIGOS 只接受不含凭据的状态通知，再向已配置的服务商查证。

官方参考：[Shared Payment Tokens](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens?agent-seller=seller)、[PaymentIntent 确认](https://docs.stripe.com/api/payment_intents/confirm?api-version=2026-09-30.preview)、[服务预约与支付](https://docs.stripe.com/agentic-commerce/sellers/use-cases/booking)。
