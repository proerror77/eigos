# Agent 电商协议与执行边界研究

研究日期：2026-10-18。范围：公开官方规范、官方产品公告及官方仓库；未使用实际交易测试。本记录区分规范能力、厂商报告的上线/交易、未来计划与设计推论。动态文档按本次读取内容描述，不把抓取日期当成发布日期，也不把平台可接入理解为 EIGOS 已经获得权限。

## 1. 结论

**这些协议不是互相替代的六个电商平台，而是在回答不同的问题：如何描述商品与订单、谁有权下单、怎样识别 agent、怎样安全地支付。** 可以组合使用，但组合仍需要商业接入、版本适配、持久执行和售后责任。

对 EIGOS 的设计推论：不要把“统一 JSON + 支付入口”当作平台护城河。更值得验证的是：能否为 agent 提供可信、可比较、可执行的供给，并把授权约束、订单进度、交付证据和失败补救维持到任务结束。也不能笼统宣称已有协议不管售后：UCP 和 ACP 已包含部分售后数据，差异在于谁实际操作、验证及承担责任。

## 2. 各协议负责什么

| 协议/产品 | 直接负责的边界 | 不能从它自动推导出的能力 |
| --- | --- | --- |
| UCP | 商家与平台的 capability discovery/negotiation、商品目录、购物车、结账、订单等商业语义；可经不同 transport 暴露 | 任意商家已经入网、库存真实可用、服务达标、自动解决争议 |
| ACP | agent 与 seller 的 checkout 生命周期；agent 与 PSP 的受限付款凭证委托 | 接入 ChatGPT 的资格、完整履约执行、跨平台身份与商业协议自动互认 |
| AP2 | 用户批准内容到具体动作的可验证授权链、checkout/payment mandates、receipts | 用户要求已正确理解、商家已经履约、授权管理 UI 与撤销链路自动实现 |
| Visa TAP | 通过 HTTP message signatures 识别和验证 agent 请求，关联用户识别/支付上下文 | 一次合法请求必然符合全部用户意图；具备商家执行 API |
| Visa Intelligent Commerce / Mastercard Agent Pay | 支付网络中的 agent 身份、凭证/tokenization、交易识别与支付网络控制 | 商品匹配、复杂任务编排、交付质量评估 |
| x402 / MPP | 资源请求与程序化付款；适合 API、工具、用量服务等机器消费 | 长周期服务验收、退款争议治理、法律责任分配 |

本表是对下列官方来源的综合归纳，并非某一协议的认证声明。

## 3. UCP：已明显超出“统一结账 API”

当前官方总规范样例采用 `2026-08-25` 版本，并定义业务 profile、版本选择、能力协商及 REST/MCP/A2A/embedded 等 transport。域名绑定证明声明出处，并不证明声明者可信。**这为 EIGOS 的 adapter 层提供可复用结构，但不替代商家审核。** [UCP 官方总规范](https://ucp.dev/specification/overview/)

Google 2026-03-19 官方更新加入可选 Cart、Catalog 和 Identity Linking；并说明商家选择自己支持的能力。实时目录查询和账号权益连接都已进入标准化范围，不能把这些描述为无人做过的空白。[Google UCP 更新](https://blog.google/products-and-platforms/products/shopping/ucp-updates/)

Order capability 区分 buyer-facing expectations、append-only fulfillment events 与 adjustments；后者能记录 refund、return、credit、dispute、cancellation。**记录“发生退款/争议”与提供退款操作、裁决流程、独立验收是不同层次。** 该规范以商家的订单记录为事实来源；EIGOS 若增加验收判断，应保留证据来源和冲突，而不能直接覆盖商家事实。[UCP Order](https://ucp.dev/specification/shopping/order/)

采用证据有两个层次：

- Shopify 2026-06-17 官方称 UCP 与 Catalog API 已向开发者 self-serve 开放，UCP 可注册 agent profile 后使用公共 MCP endpoint，Catalog 使用 API key。这是供应接入机会的重要证据，仍需在具体账号、地区、商家、商品上验证。[Shopify Spring ’26 开发者公告](https://www.shopify.com/news/spring-26-edition-dev)
- Google 2026-05-20 描述 Universal Cart、多商家体验、保留 merchant of record，并以 “soon/in the coming months” 描述部分商家、国家和酒店/餐饮扩展。此公告中的未来语态不能单独证明 10 月时已全面开放。[Google UCP 功能公告](https://blog.google/products-and-platforms/products/shopping/shopping-updates-google-marketing-live/)

### 2026-10-13 新 Shop MCP 与旧 UCP client 权限不能混为一谈

Shopify 2026-10-13 推出托管于 `mcp.shop.com` 的 Shop MCP：搜索不需 API key，支持构建购物车，登录 Shop 的买方可在确认总价与支付方式后使用 Shop Pay；发布时没有 webhook，checkout 状态需轮询。[Shop MCP 发布记录](https://shopify.dev/changelog/posts/add-shopping-and-shop-pay-checkout-to-any-agent-with-shop-mcp)

当前 Shop MCP 总览称其使用 UCP `2026-08-25`，一个 checkout 只属于一家商家，多商家必须拆单；可使用 `continue_url`，已登录用户也可确认后 `complete_checkout`。**这比单纯目录开放更接近可验证的供给入口，但仍是公开产品文档，不是 EIGOS 账户的测试结果。** [Shop MCP 总览](https://shop.dev/docs)

直接调用商家 UCP endpoint 的旧接入路径仍有不同限制：当前教程要求 agent eligible 才能直接完成订单；订单 webhook 配置不是自助。[Shopify Checkout MCP 教程](https://shopify.dev/docs/agents/get-started/checkout)；[订单监控教程](https://shopify.dev/docs/agents/get-started/monitor-orders)

官方社区工作人员 2026-09-02 解释旧路径的两道门：client token 的 completion permission、商家启用相应 agent channel；`ready_for_complete` 只表明数据完整，并不等于获准成交。该答复早于 10 月新入口，不能用它否定新 Shop MCP，也不能用新入口推断旧 client 已自动解锁。[官方社区权限答复](https://community.shopify.dev/t/how-can-a-token-tier-ucp-client-obtain-permission-to-call-complete-checkout/36590)

新 Shop MCP checkout 文档提供了很具体的执行边界：买方确认当前条款和支付方式；只有 `completed` 加 `order` 才确认下单；结果未知时不要重复 complete（即使同一个幂等键），先读取 checkout，必要时交回买方。**接入时必须遵循具体 provider 的重试契约，不能把“全局自动重试”套在所有付款操作上。** [Shop MCP checkout](https://shop.dev/docs/checkout)

Shop 的非 Shopify 购物 approval 工具另有 client permission，登录成功不代表可使用。`complete_approval` 只是接收 agent 的结果报告，不是支付证明；`cancel_approval` 不会取消或退款已有订单，也不撤销已签发的卡。它是授权/凭证路径，不是通用跨站履约兜底。[Shop approvals](https://shop.dev/docs/approvals)

## 4. ACP 与 OpenAI：协议与产品路线必须分开

ACP 官方架构分为 Agentic Checkout 和 Delegate Payment：前者管理 session，后者将支付凭证限制于金额、币种、到期时间和商家等 allowance。seller 保持 merchant of record，处理价格、库存、收款和履约。[ACP Architecture](https://www.agenticcommerce.dev/docs/concepts/architecture)

ACP 2026-01-30 更新增加 capability negotiation、payment handler framework 和扩展机制，支付 handler 是 breaking change。不能只按 2025 初版的简单 token 字段设计永久接口。[ACP Changelog](https://www.agenticcommerce.dev/docs/changelog)

售后也不是完全缺席：官方 webhook 包含订单创建/更新、人工审核、确认、取消、发货、履约状态以及退款列表。它说明 agent 可以接收商家的后续状态，不能证明通用取消/退款申请与纠纷裁决已经完成。[ACP Webhooks](https://www.agenticcommerce.dev/docs/reference/webhooks)

更值得注意的是产品反例：2026-03-24 OpenAI 承认初版 Instant Checkout 灵活性不足，转向强化商品发现，并支持商家自己的结账体验及 merchant apps。[OpenAI 产品更新](https://openai.com/index/powering-product-discovery-in-chatgpt/)

截至本次读取，商家页面明确说逐步离开 standalone Instant Checkout，购买在商家网站或 app 完成；与此同时技术 key-concepts 页面仍保留 “approved partners” 的 Instant Checkout 描述。这是官方页面之间的产品时序差异，应优先以更新的产品入口描述产品现状，技术规范仅用于说明可实现的接口。[当前商家 FAQ](https://chatgpt.com/merchants/)；[开发者 Key concepts](https://developers.openai.com/commerce/guides/key-concepts)

设计推论：保留原生调用、嵌入商家结账和人工接管三种完成路径，比假设所有交易必须全自动停留在同一个聊天窗口更稳妥。

## 5. AP2：授权必须是可执行约束，不只是对话截图

2025-09-16 发布公告使用 Intent Mandate、Cart Mandate 解释 human-present 与 human-not-present 的委托支付，并列出 60 多个协作组织。**这属于标准发布和生态参与证据，不能当作 60 多家都已开放生产支付。** [AP2 发布公告](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)

当前规范应以新的模型理解：Checkout Mandate 与 Payment Mandate，open mandate 表示允许范围，closed mandate 绑定具体交易。用户在 trusted surface 批准；verifier 检查签名与约束，未知约束必须按验证失败处理。Agent Provider 的签名密钥必须隔离于 agent。该模型明确不要求先相信 agent 每次推理都正确。[AP2 Agent Authorization](https://ap2-protocol.org/ap2/agent_authorization/)

实施要求把商家、支付处理者、shopping agent、credential provider、trusted surface 分开：商家生成 checkout 签名及 receipt，支付处理者验证 Payment Mandate 并返回 payment receipt；agent 的确定性签名环节需要避免重叠授权使用。规范建议管理长期授权及通知，但外部 trusted surface 的授权管理仍在范围之外。[AP2 Implementation Considerations](https://ap2-protocol.org/ap2/implementation_considerations/)

官方仓库包含 SDK 与 Python/Go/Android 示例，README 明确定位为 samples and demos。样例可运行不等于银行、收单方、商家和用户授权端已在生产互认。[AP2 官方仓库](https://github.com/google-agentic-commerce/AP2)

设计推论：EIGOS 的 durable intent/authorization 应保存预算、商品或服务要求、可接受替代、地理和时间范围、到期与撤销状态；每次外部副作用先经过确定性 policy check，再持久记录 receipt。AP2 adapter 可在有实际对手方支持时接入，内部不能只留一个 `user_approved=true`。

## 6. 支付网络：识别 agent 是必要条件，不能包办交付

Visa TAP 官方规格使用 RFC 9421 message signatures、创建/到期时间、nonce、key identifier 及请求标签，并提供关联用户识别对象的方式。其核心是请求来源及上下文验证；一个可信来源仍可能做出错误选择。[Visa TAP Specifications](https://developer.visa.com/docs/trusted-agent-protocol/trusted-agent-protocol-specifications)

Mastercard 2026-01-28 官方报告两笔具体交易：CBA 借记卡购买 Event Cinemas 电影票，以及 Westpac 信用卡预订 Thredbo 住宿，经过 IPSI 和 Maincode Matilda。可称“官方报告有实际交易/早期受控试验”，不能扩展成通用 agent、任意地区的广泛生产能力。[Mastercard 澳洲交易公告](https://www.mastercard.com/news/ap/en/newsroom/press-releases/en/2026/mastercard-accelerates-ai-powered-commerce-with-australia-s-first-authenticated-agentic-transactions-using-agent-pay/)

Stripe 2026-03-03 称 SPT 已由 Etsy、URBN 等采用，并正在处理受支持 AI agent 的 network-token 交易；同一 SPT 抽象可连接 Visa/Mastercard agentic tokens 与 BNPL。结论是凭证层存在可组合路径，而非必须自己建支付网络；地区、账户、支付产品权限仍应逐项验证。[Stripe SPT 支付方式更新](https://stripe.com/blog/supporting-additional-payment-methods-for-agentic-commerce)

Visa 2026-06-10 与 OpenAI 的官方公告采用 strategic collaboration、will provide 等措辞。它证明合作方向与基础设施承诺，不足以证明 EIGOS 可调用该能力，也不能替代具体上线范围核查。[Visa/OpenAI 官方公告](https://visa.gcs-web.com/news-releases/news-release-details/visa-partners-openai-power-next-generation-ai-commerce)

## 7. x402 和 MPP：如果卖的是工具/数据，可优先观察

x402 基于 HTTP 402，让资源服务给出支付要求，客户端提交 payload，服务验证与结算后返回资源。当前文档也列出 discovery、idempotency、signed offers/receipts 扩展。适合机器购买 API/内容；不能因此把“收到了 HTTP 成功响应”解释成复杂服务满足用户目标。[x402 官方文档](https://docs.x402.org/introduction)

2026-03-18 Stripe 与 Tempo 发布 MPP，覆盖程序化微支付、周期付款等，Stripe 接入同时支持 stablecoins、cards/BNPL 的 SPT。公告列举 Browserbase 按浏览器 session、Parallel 按 API 调用、PostalForm 实体邮件等应用；这些是厂商报告的采用案例，本文没有独立交易验证。[Stripe MPP 公告](https://stripe.com/blog/machine-payments-protocol)

设计推论：工具/数据是 agent 自己消费的商品，标准化结果容易验收；生活服务是 agent 代人购买，受时间、地点、取消、替代和供应方行为影响。两类订单可共享身份与支付 adapter，但应有不同交付契约。

## 8. 对 EIGOS 的协议取舍建议（推论，待产品方向选择）

1. **内部领域模型优先，协议放在边缘。** 商品/服务 Offer、Quote、Authorization、Order、Execution、Evidence、Remediation 分离；协议版本由 adapter 映射，避免业务状态直接依赖某版 JSON。
2. **让能力成为真实的可协商声明。** 发现、询价、预留、下单、支付、取消、退款、验收分别标注支持度、权限、地区和最近验证时间；不把 search-only 商家放进可自主成交集合。
3. **复用 UCP/ACP 供给与 checkout。** 某条真实供给已有标准就优先用；没有标准的直接商家 API 也可适配到内部契约，不要求商家先换协议。
4. **授权和支付独立。** 支付 token 预算约束解决不了服务替代、时间窗口等业务约束；需要业务 policy 与支付凭证双重检查。
5. **持久执行与对账独立。** 超时结果未知时先查订单/付款状态，再判断重试；组合订单必须有部分成功和补偿路径，而不是一个跨商家“全部成功”布尔值。
6. **证据分层。** 商家报告 delivered、支付 receipt、买方验收分别保留。声誉计算应基于实际订单与证据，并区分未验证、执行失败、未达标和争议中。
7. **先测试一个可验收闭环。** 对首个垂类验证“能找到适用供给→报价不过期→权限可表达→订单状态可读回→失败可撤销/补救”，再扩展供应数量；本研究不授权真实下单或付款。

## 9. 仍需实证的问题

- Shopify 自助接入在拟用主体、地区、商品上的实际准入和费率；Catalog 可发现范围与 checkout 可执行范围是否一致。
- 目标商家的最新 UCP/ACP/AP2 支持版本、sandbox、幂等约定、超时与 webhook 重放语义。
- 跨供应商取消/退款究竟能程序化完成，还是必须走商家客服；争议处理由谁承担合同责任。
- 第一条服务链上，用户愿意授权的自主程度、替代选择范围和验收标准。
- 本次没有取得跨协议统一交易量、争议率、长期无人值守成功率，因此不能据此宣称市场或通用自主交易已经成熟。
