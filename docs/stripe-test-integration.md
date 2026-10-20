# Stripe 测试支付与 Agent 接入

2026-10-20。代码契约：`ontology-execution-v12` / `eigos.business@11`。

本次完成 Stripe 测试 API、Ontology 动作、Worker 执行、现有 MCP/A2A 授权和回读的代码接入。当前没有 Stripe 账户或测试凭据，验证使用隔离 API 响应与模型决策夹具；没有调用真实 Stripe、申请账户、部署运行实例或付款。正式账户联调仍待完成。

## 范围与证据

新增可选能力 `commerce.journey.stripe-test@1`，支持 `target=quote/cart/checkout/order/payment`。商品、报价、运输与订单来自已有交易沙箱。Stripe 付款必须引用该任务独立读到的、标记 `paymentProvider=stripe_test` 的未付款订单。

| 来源 | 证据层级 | 可以证明 |
| --- | --- | --- |
| 商家与订单沙箱 | `synthetic` | 固定模拟订单、价格、地址、运输和政策检查 |
| 注入的 Stripe HTTP 测试夹具 | `synthetic` | 请求契约、权限、状态与恢复行为 |
| 官方 Stripe API + 测试密钥，未来联调时 | `provider_test` | Stripe 测试对象的实际状态与捕获证据 |

`test_paid` 表示独立读取的原 PaymentIntent 为 `succeeded`，金额、币种、账户、订单绑定、Charge 的 `paid/captured` 全部匹配，且没有退款或争议。它不表示银行结算、真实购买或物流完成。Stripe 程序不提供 `commerce.payment_settled`，也不支持 `target=delivery`。

Shopify 公共商品查询仍然只读，不能据此向真实 Shopify 商家创建订单或把商家的付款路由到本项目账户。商家 ID 到 Stripe 测试账户的映射是本机测试配置，不是商家合作或收款授权。

## Agent 可发现的动作

| 动作 | 效果与授权 | 结果 |
| --- | --- | --- |
| `SubmitCommerceUnpaidOrder` | `order`，支付金额为 0；保留原商品、报价、运输和海关硬检查 | 未付款模拟订单 |
| `ReadCommerceOrder` | 只读 | 独立验证原订单 |
| `PrepareStripePayment` | `change`，金额为 0，准确计划授权 | 创建一个未确认 PaymentIntent |
| `PayStripePayment` | `payment`，准确订单金额、币种和配置账户授权 | SPT 测试令牌确认原 PaymentIntent |
| `ReadStripePayment` | 只读 | GET 原 PaymentIntent 与展开的 Charge |

模型通过已有 Ontology 工具选择动作；适配器不提供第二个业务调度器。付款前必须实际评估当前订单的 `commerceObservationStatus` 和准备对象的 `stripePaymentStatus`。完成前必须在同一决策中评估独立付款回读。模型声明“已付款”、订单成立和确认请求返回都不能单独关闭付款任务。

`StripePaymentObservation` 关联所属 `ServiceRequest`、`CommerceTask`、原订单与 `SourceReceipt`，固定 request revision、配置摘要、模型计划、Intent、Attempt、操作键和 Stripe Request-Id。订单和付款使用独立授权，避免沿用旧模拟流程在下单时预先认定已付款。

## API 契约

固定使用 `https://api.stripe.com`，禁用重定向，不接受任务或环境变量提供替代 API 地址。版本固定为 `2026-09-30.preview`，不自动跟随预览版本升级。

1. `GET /v1/account`：验证密钥对应配置的确切账户。
2. `POST /v1/payment_intents`：用固定订单的金额、币种创建未确认卡付款；只允许自动确认、自动捕获，不接受转账收款方、代收账户、应用费或未来扣款设置。
3. `POST /v1/test_helpers/shared_payment/granted_tokens`：使用 `pm_card_visa` 创建测试 SPT，约束金额、币种、五分钟有效期。
4. `GET /v1/shared_payment/granted_tokens/{token}`：验证限额、币种、期限和未停用状态。
5. `POST /v1/payment_intents/{id}/confirm`：把私有 SPT 交给 Stripe 确认原付款；使用稳定幂等键。
6. `GET /v1/payment_intents/{id}?expand[0]=latest_charge`：独立确认捕获和退款状态。

SPT 来源明确为 `stripe_test_helper`。这验证商家侧测试接入，不等于外部买家 Agent 已从用户钱包签发令牌。用户钱包、Agent 侧 `issued_tokens`、Stripe profile 的实际开通和 preview 权限均待账户侧接入，代码不会自动使用 Link 或创建真实付款凭据。

SPT、密钥、`client_secret`、卡数据和原始错误正文不进入模型、任务、Ontology 或 A2A/MCP 返回。回执保存允许公开的状态、请求 ID、时间和响应散列。测试输送函数只可在受信代码中注入，任何注入都强制标记 `synthetic`。

## 配置与后续账户联调

默认关闭；没有凭据也可以构建和运行全部隔离测试。日后取得账户后，保留已有本机交易沙箱配置，另外设置：

```dotenv
EIGOS_STRIPE_TEST_ENABLED=true
EIGOS_STRIPE_TEST_SECRET_KEY_FILE=/absolute/private/path/stripe-test-key
EIGOS_STRIPE_TEST_ACCOUNT_ID=acct_YOUR_TEST_ACCOUNT
EIGOS_STRIPE_TEST_MERCHANT_ID=cedar-ca
```

密钥文件须为当前用户可读的私有普通文件，权限 `0600`。只接受测试 secret/restricted key；`sk_live_`、`rk_live_` 和 publishable key 均会在网络请求前被拒绝。密钥首次调用时读入 Worker，轮换后需重启 Worker。Gateway 构造能力目录时不读取密钥、不启动支付执行。

先执行 `npm run verify:stripe-test`。此命令只读账户，不创建令牌或付款；成功只证明账户对应关系和读权限，不能当作付款验证。正式联调还要核验共享令牌 preview 权限、实际创建/确认请求兼容性、Stripe 控制台中的原 PaymentIntent 和独立 GET 回执。本轮未完成这些账户侧验证。

开启或升级常驻实例按现有 Gateway/Worker 版本隔离流程操作；本次代码交付没有自动更新在运行的 v11 实例。新旧 Worker 不得混跑同一数据库。

## PA / Agent to Agent 使用

继续使用同一 `eigos.delegate` 服务和已认证的 PA 客户端，不新增旁路付款端点。任务示例：

```json
{
  "service": "eigos.delegate",
  "goal": "查询沙箱咖啡商家与保存地址，在总预算内形成未付款订单，并用 Stripe 测试支付完成独立捕获回读。",
  "executionEnvironment": "sandbox",
  "requirements": [
    { "id": "budget", "kind": "budget", "role": "service_total", "strength": "hard", "expected": { "minor": "50000", "currency": "CNY" } },
    { "id": "paid", "kind": "condition", "strength": "hard", "expected": { "predicate": "commerce.payment_confirmed" } }
  ]
}
```

PA 通过现有 A2A `submit` / `poll` / `get` 读取任务，通过 `authorize` 提交返回的 `planDigest`、`effects`、`maxAmount` 和 `payeeIds`。付款的 payee 为 `stripe-test:<accountId>:<merchantId>`，授权环境必须为 `sandbox`。每个业务动作单独授权；信息回复不是付款授权。MCP 的 `get_task`、`query_ontology` 和 `evaluate_ontology` 回读相同任务与付款对象。

## 失败与恢复

- 准备响应丢失：按原准备键散列搜索 PaymentIntent，再 GET 原对象。Stripe 搜索是最终一致的；搜索不到时保留原操作，绝不再创建一笔。
- 付款响应丢失：只 GET 已持久记录的 PaymentIntent，不重新生成 SPT 或确认付款。
- 明确拒付：记录拒绝并释放未消费的预算占用；不自动换卡或重付。
- `requires_action`、`processing`、无法确认的响应：保留预算和原操作身份，按现有有界恢复策略读取；仍无法确认时转 `needs_review` / `input-required`。当前没有 3DS 用户界面或外部认证后自动恢复流程。
- 用户取消、授权撤销/过期或租约被替换：在每次实际写请求前重新核对。已派发付款的迟到结果可用于原操作查证，不能把已取消任务改成已完成。
- 独立回读发现未捕获、退款、争议、账户/金额/币种/订单不匹配：不能关闭付款任务。

目前采用主动查询，不依赖 Webhook；没有新增公开 Webhook 接收端点。退款发起、自动结算、用户钱包授权、真实商家订单和实际运输均不在此版本执行范围。

## 验证与依据

隔离测试包括准确授权、禁用与密钥边界、SPT 约束、捕获回读、秘密数据隔离、错误账户与条款、拒付/认证等待、响应丢失、取消、撤销和租约失效。协议测试用现有 Python PA 客户端走 A2A，MCP 再读同一结果；模型决策和 Stripe 响应都明确使用夹具。

本轮本地验证：`npm run check`、429 项 `npm test`、`npm run build`、7 项进程级 E2E 和 `git diff --check` 均通过。其中 30 项新增测试覆盖 Stripe 支付及 A2A/MCP 共用回读。这些结果不包含真实 Stripe 账户验证。

官方参考（2026-10-20 查阅）：[Shared payment tokens](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens?agent-seller=seller)、[确认 PaymentIntent](https://docs.stripe.com/api/payment_intents/confirm?api-version=2026-09-30.preview)、[PaymentIntent 搜索一致性](https://docs.stripe.com/api/payment_intents/search)。预览 API 仍须在实际测试账户上验证。
