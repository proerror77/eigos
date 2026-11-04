# 淘宝购物演练与 PA 侧支付宝 Agent Pay

支付能力属于用户的 Personal Agent（PA）。本次接入提供独立 PA MCP、命令行准备工具和可重复的模拟联调，**不创建真实淘宝订单，不调用真实 `submit-payment` 或 `402-buyer-pay`**。EIGOS Gateway、Worker、Relay 不加载 PA 支付组件，也不接收钱包凭据。

## 当前可验证的流程

```text
EIGOS 淘宝只读任务 → 原商品观察 → PA 购物草稿（等待正式订单材料）
                                       ↓ 仅在隔离演练中补入模拟材料
                         PA 核对商品、SKU、数量、含运费总价、收款方与授权
                                       ↓
                         准备官方 Agent Pay 参数，不执行真实命令
                                       ↓
                         模拟提交 → 分别读取模拟付款与原订单
```

淘宝客返回的价格是参考价，不能当作含运费结算价、库存、SKU 或付款授权。真实商品观察只能生成 `awaiting_order_material` 草稿。演练订单须显式标注 `synthetic`，使用 `sim-` 订单号及保留域名 `cashier.alipay.invalid`；实际支付宝收银台链接会被本版本拒绝。

授权固定原任务、商品、数量、预算、币种、收款方和有效期，并要求 `mode=rehearsal_only`、`allowRealOrders=false`、`allowRealPayments=false`。它是 PA 本地演练合同，**不是支付宝或淘宝官方 API 字段**，也不是用户的真实消费授权。确认状态始终带 `evidenceLevel=synthetic`、`businessCompleted=false`、`officialPaymentVerified=false`。

## PA 工具

构建后，在 PA 所在设备运行；不要把 PA token 放到正式 EIGOS 配置里：

```sh
node dist/apps/pa-payments/main.js --token-file /absolute/private/pa-tools-token
```

token 为 PA 单独生成的 32 字节随机值的十六进制文本，文件须由 PA 用户持有、权限 `0600`。服务固定监听 `127.0.0.1` 的随机端口，输出 MCP 地址。通过宿主私有配置传入 Bearer token；不要将 token 写入聊天、Git 或分享链接。三个工具如下：

| 工具 | 结果 |
| --- | --- |
| `get_payment_policy` | 当前禁止真实下单／付款、钱包属于 PA 的策略 |
| `prepare_taobao_shopping` | 从原 `providerRead` 观察准备草稿，列出缺失的正式订单材料 |
| `prepare_alipay_rehearsal` | 校验模拟订单并准备官方命令参数合同；仅返回摘要，不返回链接或命令 |

工具不接受支付凭据，没有付款或淘宝创建订单工具。它是 PA 的本地工具服务，不是 EIGOS 的新业务 Action，也不扩展现有 v2/v3 付款协议。演练付款核验在 PA 本地完成；尚未新增真实淘宝订单的 EIGOS 独立回读。

不用 MCP 时也可在 PA 上准备：

```sh
node dist/examples/pa-alipay-agent-pay.js prepare --input /absolute/private/pa-shopping-input.json
```

输入必须是 `0600` 的私有普通文件，包含 `catalogRead`（原 EIGOS `result.providerRead`）及 `authority`。仅演练订单材料齐全时追加 `order` 和来自 PA 宿主的 UUID `sessionId`；真实调用不得编造会话身份。输入应来自当前授权任务的可信读取，手工 JSON 或 `evidenceKind` 字段本身不证明来源。

## 官方支付工具位于 PA

通过[支付宝官方钱包／付款技能仓库](https://github.com/alipay/payment-skills)安装 `alipay-authenticate-wallet` 和 `alipay-payment-skill`。按该技能的安装说明校验固定版 `@alipay/agent-payment@1.0.12` 的完整性后安装官方 CLI。安装、钱包绑定和付款是分别核验的状态；工具安装不能证明钱包绑定或真实支付通过。

本地钱包状态检查只运行固定 `check-wallet`，使用已核验官方可执行文件的绝对路径和 SHA-256：

```sh
node dist/examples/pa-alipay-agent-pay.js wallet-status --executable /absolute/private/alipay-bot --sha256 <actual-sha256>
```

输出为本次官方工具的原始输出；错误时只报告状态不可确认，不暴露诊断中的授权材料。该检查不会自动开通、绑定或付款。需要绑定时由用户在支付宝官方页面核身；支付密码、钱包令牌及官方本地身份文件留在 PA。

官方 `submit-payment` 的参数合同为 `--session-id`、`--payment-link`、`--intent-summary`。本模块只在内存为模拟订单准备这些参数，摘要只含商品、最终金额和收款方。没有虚构 `--dry-run` 或服务端幂等参数。见[官方收银台流程](https://github.com/alipay/payment-skills/blob/main/alipay-payment-skill/references/cashier-payment.md)。

## 验证与恢复

```sh
npm run check
npm run build
node dist/examples/verify-pa-taobao-rehearsal.js
```

验证器通过实际 EIGOS 任务、Worker／本体执行及 PA MCP 连接完成流程，模型决策和供应商均为合成夹具；不是一次真实 PA 模型决策验收、官方支付宝沙箱或真实淘宝联调。输出分别标明真实订单与付款计数为零、真实渠道验证为 false。

模拟付款的本地 SQLite 账本先记录派发，再调用隔离 transport。响应丢失、重启和并发只回读原操作，不再次提交；改订单、金额或会话会被拒绝。授权到期后仍可调用 `reconcile` 查询已记录的原操作，不续期也不重新提交。模拟付款记录及模拟订单记录必须分别匹配原操作、订单、收款方和金额，才标记模拟确认。账本不保存收银台链接、钱包凭据或完整命令；持久账本由 PA 放在自己的私有目录。

接入真实淘宝下单、官方付款提交及 EIGOS 真实订单／付款核验，需要下一阶段明确授权、正式供应商能力和对应验收，本版本无法通过开关启用。
