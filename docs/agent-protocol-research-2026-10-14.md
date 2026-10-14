# EIGOS：Agent 通信、授权与支付协议研究

核验日期：2026-10-14。范围：官方规范与接入方向研究；未实施接口、开通支付、部署或验证任何客户平台兼容性。以下“建议”是设计判断，不代表已确认的产品能力。

## 核心结论

EIGOS 所需能力应拆成：Agent 通信、会员身份与授权、交易与支付、业务执行。A2A 能承载委托、补问与交付，但不会自动提供会员系统、支付账户或业务执行。支付协议也不能替代任务执行及本体架构。

建议保留既有方向：客户个人 Agent（PA）提交目标及必要资料，EIGOS 自己研究、规划和执行；内部本体与真实业务适配器完成工作。Job 表示执行任务，PurchaseOrder 表示购买交易，两者关联而不合并。一个 Job 可以没有购买，也可以关联多笔采购。

## ACP 必须写全名

| 名称 | 解决的问题 | 对 EIGOS 的判断 |
| --- | --- | --- |
| A2A / Agent2Agent | 独立 Agent 之间的发现、消息、任务、产物和进度 | 适合任务委托主通道 |
| ACP / Agent Communication Protocol | BeeAI 体系原有 Agent 通信协议 | 官方已并入 A2A；新项目优先评估 A2A，旧客户才考虑迁移兼容 |
| ACP / Agent Client Protocol | 编辑器、IDE 与 coding agent 之间通信 | 如果未来提供 IDE 内的执行 Agent 才评估；不是通用商业 Agent 网络的首选 |
| ACP / Agentic Commerce Protocol | 买家 Agent 与商家的结账和支付凭证交换 | 用于购买服务或商品，不能代替执行任务通道 |

来源：[A2A v1.0.0](https://a2a-protocol.org/v1.0.0/specification/)、[旧 ACP 官方合并公告](https://agentcommunicationprotocol.dev/introduction/welcome)、[Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction)、[Agentic Commerce Protocol](https://www.agenticcommerce.dev/docs)。Agent Client Protocol 当前文档同时覆盖本地及远程，不能笼统称为“只能本地”。

## A2A 可以怎样补问

核验到的 A2A 发布规范为 v1.0.0。Agent Card 描述能力和接入要求；Task 与 Message 保持同一任务的交流；Artifact 表示交付物。服务端可进入 `TASK_STATE_INPUT_REQUIRED`，客户发送携带原 taskId 的答复后继续；`TASK_STATE_AUTH_REQUIRED` 表示需要补充授权。可用查询、流式订阅及受支持的推送获取更新。[A2A 规范](https://a2a-protocol.org/v1.0.0/specification/)

所以“EIGOS 问客户 Agent 缺少什么资料”可以实现。客户端已知且获准分享就回答，否则问用户。推送仍需要客户端能接收并运行；协议不能唤醒任意关闭的消费级聊天应用。任务消息也不是默认可靠的持久账本；建议自行持久保存关键问题、答复、授权引用与交付证据。

## 会员登录和执行权限

A2A 可在 Agent Card 声明 OAuth、OIDC 等安全方案；凭证获取在协议消息之外完成，服务端按自身政策检查权限。因此“支持 A2A”不等于已经有用户注册、组织、套餐和用量计费。[A2A 安全与授权](https://a2a-protocol.org/v1.0.0/specification/#7-authentication-and-authorization)

建议流程：添加 EIGOS 连接 → 浏览器登录 → 选择组织和权限 → 客户端取得令牌 → 提交任务。后台关联用户／组织、Agent 客户端、授权范围、Job、额度及账单。密码和支付私钥不写入提示词；支付成功也不授予访问其他客户数据的权限。

MCP 与 A2A 可适配到同一个任务内核。接入哪种协议取决于实际客户端能力，不需要强制每个请求依次经过两个协议。Grok、Muse、Dots 的具体产品、版本与扩展入口仍需单独核验；本研究没有证明三者均能连接。

## 支付协议各管什么

### Agentic Commerce Protocol：交易结账

ACP 商务协议由 OpenAI 与 Stripe 开发，包含 Agentic Checkout 与 Delegate Payment。前者管理结账会话，后者约束支付凭证的额度、币种、有效期和商家；商家仍负责订单与履约。适合客户 Agent 购买 EIGOS 的服务包，或 EIGOS 在用户授权下向兼容商家采购。[官方架构](https://www.agenticcommerce.dev/docs/concepts/architecture)

官网当前 Checkout 参考示例使用 `2026-01-30` 版本。实施需固定并协商版本，不能把示例日期推断为所有客户端已支持。[Checkout 参考](https://www.agenticcommerce.dev/docs/reference/checkout)

### AP2：证明“用户授权买什么、付多少”

当前官方规范为 v0.2，采用 Checkout Mandate 与 Payment Mandate，各有 Open／Closed 阶段，支持用户当场批准或事先在限制内授权。规范要求校验由确定性代码完成；可信用户确认界面必须是非 Agent 角色。它是商务协议中的安全机制，目录、结账更新及各方通信 API 不在其核心范围。[AP2 v0.2](https://ap2-protocol.org/ap2/specification/)

一个重要限制：当前规范明确将 Shopping Agent 之间的 Mandate 再委托排除在范围外。因此不能声称接上 AP2 后“客户 Agent → EIGOS → 下游 Agent”的支付权限自然传递。建议按具体购买和采购角色分别设计授权链，保留关联证据。

### x402：HTTP 按次付费

x402 面向 API、内容等资源收费，可不创建传统账户而程序化付款；官方当前文档以加密原生支付为主。[介绍](https://docs.x402.org/introduction)

V2 利用 HTTP 402 与支付要求、签名和响应头完成支付协商；具体结算时间取决于 payment scheme，不能一概说“每次请求即时链上结算”。[HTTP 402 与 V2](https://docs.x402.org/core-concepts/http-402)

建议用途：独立的数据查询或小额工具调用。它不天然完成长期 Job 的验收、退款政策、会员权益或发票管理；这些仍是服务设计。

### MPP / Machine Payments Protocol：机器购买 API 和服务

MPP 由 Stripe 与 Tempo 共同编写，采用 HTTP 402 挑战、支付凭证重试、资源及收据响应，可不展示传统结账界面。[Stripe MPP 文档](https://docs.stripe.com/payments/machine/mpp)

Stripe 当前说明 MPP 可接受卡（通过 Shared Payment Tokens）与稳定币，x402 路径支持稳定币；具体支付方式、国家／地区、账户权限和最低金额有条件。因此不要把 x402 与 MPP 简化为同一协议，也不要将协议公开等同于 EIGOS 已有收款资格。[Stripe Machine payments](https://docs.stripe.com/payments/machine)

注意：AP2 角色表中的 MPP 还可能指 Merchant Payment Processor（商家支付处理方），不是这里的 Machine Payments Protocol。

## 国内支付与此前讨论的对应关系

此前“产品架构设计”讨论过支付宝 ACT、Machine Pay／A402、Agent Pay，以及 AHA，并曾使用 EIGHT 名称。以下是本轮主代理核验的一手资料汇总，未证明 EIGOS 已获产品资格。

- **ACT 2.1**：覆盖授权委托、商务、支付、信任四个领域；不取代支付网络、商家或身份基础设施。文档区分逐笔确认、指定委托和有边界的自主执行。[ACT 仓库](https://github.com/antgroup/ACT)、[架构概览](https://github.com/antgroup/ACT/blob/main/docs/specification/overview.md)
- **A402**：支付宝集成文档使用 HTTP 402、`Payment-Needed` 与 `Payment-Proof`，校验后履约。虽然同样利用 402，不等于与 x402 可直接互换。[A402 文档](https://github.com/antgroup/ACT/blob/main/integrations/alipay/a402.md)
- **Machine Pay**：面向 API、工具及资源的机器用量支付。[官方产品](https://aipay.alipay.com/products/machine-pay)
- **移动端 Agent Pay**：核验页面更新日期为 2026-10-09，明确当前是 APP 场景，预支付后通过 `agent.pay`、SDK 与异步通知完成；要求签约，页面注明该产品无沙箱。不能据此宣称任意网页聊天 Agent 都能接入，也不能把“无沙箱”泛化到支付宝全部产品。[移动端 Agent Pay](https://aipay.alipay.com/docs/agent-pay/mobile-agent-pay.html)

建议把资金流分为三类：客户支付 EIGOS 服务费；用户向第三方商家购买；EIGOS 自己采购工具／算力。三类资金的付款主体、授权和凭证分别记录，避免用户的一次任务授权成为无限采购授权。

## 建议的最小验证范围

1. 固定一个支持外部工具或 A2A 的真实客户端，验证 Agent Card／连接发现和会员 OAuth。
2. 做一次目标提交 → EIGOS 补问 → 客户 Agent 回答 → 原 Job 继续 → 返回产物的往返。
3. Job 与 PurchaseOrder 分离；费用先报价，记录用户批准的金额、用途及有效期。
4. 按目标市场选择一个可用支付路径，先验证测试付款、回执关联、重复请求不重复扣款和失败恢复；不同时接入所有协议。
5. 本体校验业务对象和动作，真实适配器执行；任务完成以交付物及系统证据判定，支付成功与业务成功分别记录。

这些是建议的验证步骤，不构成实施、发布、开通金融产品或真实扣款的授权。现有资料足以支持“协议上可以做”，尚不能支持“指定三款客户端已能一键接入并付款”。
