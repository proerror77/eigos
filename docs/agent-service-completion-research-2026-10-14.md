# Agent 商业网络：执行与服务完成研究

阅读日期：2026-10-14。本文回应用户的边界：专注服务有没有完成，复用现有支付安排，不建设新的结算／清算层。是资料研究与产品判断，不是实现方案已批准、生产验证或商业承诺。

## 结论与上一轮修正

已有可调用服务的目录、提供方执行程序、任务生命周期和验收角色。不能由资料不足推出“市场没有真实执行网络”。更准确的判断是：所读资料没有证明存在适用于任意业务、能可靠验证最终结果并承担后续处理的通用网络。

现有网页、API、SaaS、商户、服务团队本来就能执行工作。Agent 可以通过这些渠道操作，不必等待所有供应商成为另一个 Agent。网络的价值需要体现在具体任务能否被接住、执行到位、验收和补救，而不只在协议接入或服务上架数量。

上一轮材料偏向支付；需要纠正两点：UCP／购物 ACP 已涉及交付生命周期，Virtuals ACP 已包含验收动作。真正需要调查的缺口是这些动作背后的业务判断和证据，而非再发明 `completed` 字段。

## 上一轮列出资料的阅读台账

“全文”指所列文章、文档页面或论文正文，不表示读完整个网站／代码仓库。GitHub Discussions 是持续变化的目录，本次读其可见列表，并展开四个相关主题及公开可见回复；没有声称穷尽历史讨论。Skyfire 是唯一未取得实时原页的条目。

| 原资料 | 阅读范围 | 与服务完成的关系 |
| --- | --- | --- |
| [Virtuals ACP Overview](https://os.virtuals.io/acp/overview) | 页面全文；另读执行与验收文档 | 已有执行与验收角色；具体能力仍需逐提供方核验。 |
| [Nevermined Pay](https://nevermined.ai/blog/nevermined-pay-give-your-ai-agent-a-credit-card-with-guardrails) | 文章全文 | 授权与消费控制，不能据此推导结果已验收。 |
| [Nevermined Payments](https://github.com/nevermined-io/payments) | README 全文，未审计整个仓库 | 发现、调用、计量与收费；计量不是任务完成证明。 |
| [Skyfire Payment Features](https://docs.skyfire.xyz/docs/features) | 完整搜索缓存；原页读取失败，缓存较旧 | 展示付费服务访问与支出规则；产品当前状态未实时验证。 |
| [x402 Foundation 正式运营公告](https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications) | 公告全文，2026-07-14 | 开放支付标准治理，不是业务验收标准。 |
| [Google UCP 发布](https://blog.google/products/ads-commerce/agentic-commerce-ai-tools-protocol-retailers-platforms/) | 文章全文，2026-01-11 | 接通现有零售商与购物流程；商家继续承担销售主体角色。 |
| [AP2 捐赠 FIDO](https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/) | 文章全文，2026-04-28 | 授权意图与付款证明；不能推导商品或服务符合约定。 |
| [Visa expanded payments economy](https://corporate.visa.com/en/sites/visa-perspectives/innovation/agentic-commerce-expanded-payments-economy.html) | 文章全文，2026-03-17 | 支付机构对交易增长、安全及身份的观点。 |
| [BIS 收录 Waller 演讲](https://www.bis.org/speeches/20261005-payments-age-ai-agents) | 演讲全文 | 强调早期阶段、B2B、授权、责任及开放／封闭生态；没有证明通用执行网络成熟。页面日期 10-05，正文演讲日期 09-29，保留差异。 |
| [购物 ACP 仓库](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol) | README 全文；补读 Orders RFC | 包含订单与交付状态；这些是商家提供的商业记录。 |
| [How Agentic Is Agentic Commerce?](https://arxiv.org/html/2607.12575v1) | 论文正文、方法与局限，详见论文笔记 | 链上交易笔数不足以证明独立需求，更不足以证明服务完成。 |
| [TessPay](https://arxiv.org/html/2602.00213v1) | 论文正文、验证与局限，详见论文笔记 | 借鉴条件与证据的绑定；不因此采用其支付／托管架构。 |
| [RAILS](https://arxiv.org/html/2606.08790v1) | 论文正文、验证与局限，详见论文笔记 | 借鉴可检查条件；不因此建设清算与信用机制。 |
| [Will the networks win Agentic Commerce?](https://paymentsinfull.substack.com/p/will-the-networks-win-agentic-commerce) | 文章全文及可见评论；折叠回复未穷尽 | 作者认为支付可能不再控制整个商业过程；是行业观点，市场份额等未单独核验。 |
| [ACP Discussions](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/discussions) | 可见目录＋下列四篇完整主题和公开回复 | 体现社区问题，不能将提案当作已采纳规范。 |
| [Reddit：Agent 之间会交易什么](https://www.reddit.com/r/startups/comments/1t4b3bi/what_might_commerce_between_ai_agents_look_like_i/) | 帖子和可见两条回复 | 围绕付费 API、现有 SaaS、信任与网络形态；小范围且含推广，不代表市场采用。 |

## 更接近问题的原文证据

### 1. 服务采购已经有实现，整体完成仍会失败

[Nevermined 2026-10-07 的 Catalog 演示](https://nevermined.ai/blog/what-one-prompt-bought-building-with-the-nevermined-catalog)展示采购并组合多种数字服务，也披露付费结果无法验证、需求遗漏和超过任务时限。它支持“有服务聚合”，也说明不能用采购成功替代整体验收。该演示是厂商自述，本次没有复现。

### 2. 有批准按钮，仍需有人定义批准依据

[Virtuals Client Workflow](https://os.virtuals.io/acp/cli/client-workflow)要求检查交付物后批准或拒绝；[ACP Serve](https://os.virtuals.io/acp/cli/acp-serve)由提供方实现业务处理函数。这个分工已存在。可做的工作是接入真实执行能力、定义检查办法和处理失败，而不是假定再加一个评估 Agent 就解决了所有业务判断。

### 3. 商家签名证明来源，不自动证明现实质量

补读 [UCP Order Capability](https://ucp.dev/specification/shopping/order/) 全文。其订单区分预期、履约事件与调整，支持查询和商家签名 Webhook。验证签名可核对消息来源、完整性和订单归属；现实中的商品是否正确、服务是否合格，仍取决于业务证据。此句是对规范职责的分析，不是声称 UCP 有安全缺陷。

补读 [ACP Orders RFC](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/rfcs/rfc.orders.md) 全文。该文件标注 Draft，定义运输、自提、数字交付及退款等状态。订单创建、商品发出、买方收到是不同节点；履约记录是验收输入。不能把 RFC 全部字段默认当成每家商户已实现。

### 4. 社区也在区分“决定”和“实际执行”

- [#179](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/discussions/179)：提问 Agent 生成的金额如何与真实用户意图对应；回复提出授权绑定模式，非维护者确认的规范结论。
- [#265](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/discussions/265)：讨论最终提交时的授权新鲜度、对象和范围；主要是事前权限问题。
- [#304](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/discussions/304)：提出交易后争议处理扩展并寻求支持；属于提案。
- [#298](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/discussions/298)：明确将外部处理决定与补救实际执行分开。作者的示例是合成测试，并明确不证明真实商家或生产信任。对本项目有用的通则是：认定应该退款与退款已到账必须分别记录。

## 围绕服务完成的产品判断（本次分析）

可以把一次服务围绕五个问题组织起来：

1. 事先约定完成什么：对象、数量、质量、截止时间，以及谁可以验收。区分可承诺的交付与更远的商业效果。
2. 谁执行：现有网页、API、专业 Agent、商家或人工团队。能点击是有效执行渠道；覆盖和可靠性仍需验证。
3. 结果在哪里：取得实际交付物、目标系统读回、服务商业务回执或接受方确认。执行日志可辅助，但单独不足以证明目标完成。
4. 是否达到条件：按业务检查；主观部分交给约定的接受方。证据不足保留“待核验”，不强判成功或失败。
5. 没完成怎么办：跟进、补交、重试或换执行者，在既有授权内推进；新承诺和新增支出另行处理。

| 服务目标（示例） | 可验收的证据 | 仅这些还不够 |
| --- | --- | --- |
| 订妥一张指定机票 | 出票记录可读回，旅客／航班／日期匹配，有效票据 | 点击支付、订单受理 |
| 发布一篇指定文章 | 正确账号和版本，目标受众可访问，发布状态可读回 | 点击发布、上传成功 |
| 开通某项 SaaS 服务 | 目标账户权限生效并通过约定功能检查 | 扣款、开通申请受理 |
| 交付一份研究报告 | 文件可访问，约定覆盖项和来源检查通过，需要时由客户确认质量 | 生成了文件、调用返回成功 |
| 商品交付符合约定 | 订单对应的物流、收货及约定质量检查 | 时间过去 15 天 |

“收货后 15 天付款”可以是买卖双方已约定的付款安排；服务验收可以独立于付款安排。时间到期只说明到了某一日期，不能单独证明服务合格，也不能据此假定所有商家接受这一账期。

初期可选一个有明确外部事实的服务种类，人工配合也可。用真实任务检验“服务方声称完成但验收未通过”是否被识别，是否能补救，以及客户是否因此节省了核查与跟进工作。衡量实际验收完成率、错误宣布完成的比例、完成耗时和人工介入，不用付款量代替完成量。

如果只接收证据并给判定，它更接近验收服务；如果还接单、选执行渠道、跟进补救，它才承担执行网络的职责。二者都可专注服务完成，具体承担哪段责任需要在后续产品范围中明确。

## 本项目当前状态

本次只新增研究材料。根据本地 README 和接入指南，当前 `brief.prepare` 生成任务说明，实际执行为 `not_started`。MCP／A2A 接入不等于上述业务已经实现。本次没有采购、外部发送、部署或修改应用代码。

## 详细笔记

- [供应网络与执行资料](research/agent-service-completion-provider-notes-2026-10-14.md)
- [三篇论文的验证方法与局限](research/agent-service-completion-paper-notes-2026-10-14.md)
