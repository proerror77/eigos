# Agent 商业市场与供给研究：EIGOS 的位置

研究日期：2026-10-18。范围：官方产品、接口文档、源码和运营方披露；未注册、申请权限、下单或付款。以下能力均为公开资料证据，不代表 EIGOS 已获访问权或已验证生产执行。

## 结论

“Only for agents”可作为交易接口的设计原则，但不是足够强的市场定位。需要先区分两种需求：

| 市场 | 实际买方与需求 | 商品单元 | 核心困难 |
| --- | --- | --- | --- |
| Agent 代表人购买现实商品和服务 | 人或企业委托，Agent 操作 | 实物 SKU、可履约服务、预约 | 商户准入、实时库存/档期、下单授权、履约及售后责任 |
| Agent 为完成任务购买其他 Agent/数字服务 | 开发者或业务预算承担成本 | 搜索、推理、数据、生成、可验收任务 | 机器可发现、计量、质量验证、预算与微额支付 |

两者共享身份、授权、报价、订单和证据，却不能用一套供给策略解决。EIGOS 若继续生活服务方向，最有价值的初始商品是“在指定地区和时间、以明确条件交付的服务”，不是一个 Agent 名字或模糊能力标签。数字服务市场可用来验证机制，但不能把它的 API 调用成功率等同于现实服务履约能力。

## 1. Shopify：通用商品接入正在成为基础设施

2026-10-13 官方发布 Shop MCP，宣布可搜索逾十亿商品；搜索不需 API key，支持购物车、结账及登录后的订单查询。登录 Shop 的用户确认总价和支付方式后，Agent 可调用 `complete_checkout`。发布时没有 webhook，需查询结账状态。属于“官方上线与接口能力”证据，尚非本研究的购买实测。[Shopify 开发者公告](https://shopify.dev/changelog/posts/add-shopping-and-shop-pay-checkout-to-any-agent-with-shop-mcp)

官方文档列出 17 个工具，并明确一个 checkout 只属于一家商户；三家店需要三个 checkout。只有 `completed` 且含 `order` 才证明购买成功。匿名搜索/购物车与授权支付是不同权限层。[Shop MCP 文档](https://shop.dev/docs)

当前商户帮助中心同时写明：ChatGPT 的 Agentic Storefronts 渠道是商品发现与引流，用户在商户结账页完成购买；Google、Copilot、Meta 在启用 direct checkout 时可直接结账。**渠道集成的现实状态与新发布的通用 Shop MCP 能力应分别描述**，不能用前者否定后者，也不能假定所有渠道都已采用新接口。商户保留客户关系和售后责任。[渠道帮助中心](https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts)

Catalog 维护结构化产品、价格和库存；当前 Agentic Storefronts 仅支持 D2C，B2B 专用产品被排除。机器可发现并不等于任何 Agent 都获准使用所有价格或供给。[Catalog 资格与数据](https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/products)

Shopify 自报 Q1 2026 AI 流量同比 8 倍、AI 搜索带来订单近 13 倍。它证明该渠道增长，**不证明自动下单占比、绝对 GMV、无人值守成交量或盈利**。[Shopify 2026-06-18 文章](https://www.shopify.com/blog/how-agentic-commerce-works)

**战略推论：**重新做一个泛商品索引或 MCP 包装层，差异化会快速被压缩。可争取的价值是用户特定约束、多商户组合、可验证完成率、异常处理和有授权的服务覆盖；也必须验证 Agent 为什么不直接调用 Shop MCP。

## 2. Amazon：供给方参与意愿不能用用户授权替代

Amazon 2025-11-04 官方声明要求第三方购物应用公开身份并尊重服务商是否参与的决定，并要求 Perplexity 将 Amazon 移出 Comet 体验。这是 Amazon 的公开立场，**不是本报告对诉讼结果、法律权利或当前技术封锁状态的判断**。[Amazon 声明](https://www.aboutamazon.com/news/company-news/amazon-perplexity-comet-statement)

**战略推论：**供给侧协议应单独记录“可读、可报价、可下单、可取消、可退款”的权限。用户委托凭证、平台访问资格、商户销售承诺是三件事。浏览器能够操作页面，不能成为 EIGOS 的长期供给承诺。

## 3. 现实服务网络：接口开放存在层级

### Instacart

普通 Developer Platform 的 MCP 教程明确仅列出 `create-recipe` 和 `create-shopping-list`，给出开发/生产服务地址并要求 API key。它能生成可购物页面，不能据此宣布外部 Agent 具有完整支付与售后权限。[公开 MCP 教程](https://docs.instacart.com/developer_platform_api/guide/tutorials/mcp)

另一个官方 MCP 页面描述查可服务门店、查原料和增删订单商品；这是另一路产品能力说明，需要分别核实权限。[MCP Servers](https://docs.instacart.com/mcp_servers) Connect APIs 面向 retailer partners，包含履约和 post-checkout；不应把零售商合作伙伴接口与普通应用开发者权限合并。[Connect APIs](https://docs.instacart.com/connect) 官方入门页称从申请到 demo 审核、生产 key 平均约 30–40 天；这只是官方典型周期，不保证 EIGOS 获批。[入门流程](https://docs.instacart.com/developer_platform_api/get_started/overview/)

### Uber

官方 3P Demand Rides 文档列出服务端 API、嵌入页面、deeplink、Agentic MCP 四种方式，并描述发现、预订、管理出行与 sandbox/production 环境。本研究未拿到 partner 凭证，不能由文档推出无条件自助开放。[Uber 官方文档](https://developer.uber.com/docs/third-party-rides-demand-v1/introduction)

### Duffel

Duffel 官方提供机票与住宿搜索、预订及管理文档；官网列出客户案例和改签、取消等能力。可作为行业供给聚合参考，不能把第三方 MCP 目录中的连接器视作 Duffel 官方授权或 EIGOS 可用权限。[官方文档](https://duffel.com/docs)、[产品与客户案例](https://duffel.com/)

**战略推论：**平台应让供给连接器返回明确的能力等级：`discoverable / quotable / orderable / trackable / cancellable / refundable`，并附地区、账户、合同、时效约束。深链跳转和外部人工补位可以是交付方式，但须向调用 Agent 显示实际模式。

## 4. Agent 购买数字服务：已经存在可借鉴市场

### Virtuals ACP

Virtuals 官方将 ACP 定义为 Agent 雇佣 Agent 的市场，包含服务发现、协商、执行、结算；官网静态提取中的多项统计为零，应视为未成功取得动态指标，不能解释为真实零业务。[官网](https://www.virtuals.io/)

官方 Node SDK v2 有买方、卖方、任务会话、预算、提交和搜索等实现，说明不只是概念。[官方 SDK](https://github.com/Virtual-Protocol/acp-node-v2) Google Cloud 客户案例描述 1,300 多个可选 Agent；搜索索引使用服务说明、SLA、成功率、评价和独立买方数；评价阶段比较原始请求、协商条件和交付结果。该案例来自供应商与客户，证明部署路径的可信度高于单纯发布稿，但不是独立财务审计或跨业务验收准确率。[Google Cloud 案例](https://cloud.google.com/customers/virtualsprotocol)

注意：Virtuals 的 Agent Commerce Protocol 与其他同样缩写 ACP 的协议不是同一事物，比较时须写全名。

### Olas Mech Marketplace

Olas 2026-10-18 00:40 UTC 的官方页面披露：约 1,210 万累计 task requests、1,022 万 deliveries、12 个日活 Mech 的七日均值、累计 task payments $110,057.04；约 1,180 万请求来自 Predict 经济体。claimed payments 与 realised earnings 是同一数值，不能相加；marketplace fee 也不是额外 GMV。[Olas Mech 指标](https://olas.network/agent-economies/mech)

2025-08 的官方市场发布稿也区分注册 Agent、已雇佣 Agent、Mech 供应方和交易次数。[市场发布稿](https://olas.network/blog/mech-marketplace-now-has-a-marketplace-app)

**证据解读：**上述为平台自报、未独立链上复核。它至少说明“很多机器动作”与“很大的商业市场”不是同义词；需求还可能集中于单一用例及同一生态。不要把任务请求、交付、交易、买方钱包、真实付费主体混成一个增长指标。

### Nevermined

Nevermined 当前定位是 Agent 支付、计量、权限与结算基础设施，支持调用/结果/订阅计费，并描述预算、单次上限、过期与撤销授权。首页把一组 requests/revenue 数据明确标为 example，不可用作实际营收证据。[Nevermined 官网](https://nevermined.ai/)

它展示的主要启发是把机器服务定价与支出权限结合；支付集成不自动提供足够需求、质量判断或售后解决。这里未把旧推广稿中的部署时间缩短数字当真实成交证明。

## 5. 对 EIGOS 商业设计的建议（分析与假设，非已验证事实）

1. **Agent-first，保留人类控制面。** 交易面提供机器接口；商户配置、用户授权、例外审批、客服申诉仍需要人可以理解和操作的界面。“不需要人浏览货架”比“排除人类界面”更准确。
2. **市场卖可验收的 offer。** 最小对象含供应商责任主体、输入、地区/时间范围、总价及费用构成、报价过期、交付物、验收条件、取消退款规则、依赖与证据要求。Agent 是接入方式或执行者，不能替代责任主体。
3. **先过滤资格，再排序。** 权限、服务地区、档期、预算、数据披露限制为硬约束；再用匹配程度、时效、总成本、近期已验证履约表现排序。广告/返佣须独立标识，避免平台收益影响买方 Agent 的受托选择。
4. **信誉来自真实订单事件。** 区分请求接受、支付成功、供应商声称交付、证据验证、用户验收；按服务类目统计期限内完成率、补救率、争议率与退款耗时，展示样本数和近期变化。LLM 评审可辅助，不能独自证明实物已送达或服务已完成。
5. **先找到重复买方。** 选一个垂直场景和数个真实需求侧 Agent 集成方，检查他们已有的替代方案。供给量不是冷启动的第一指标；有效请求能否被授权供给接住才是。
6. **先用现成支付与垂直供给。** 自建钱包、清算、全网购物索引或新协议只有在证明现有渠道不能满足关键需求后才有理由。对外部接口增加价值必须体现在结果、可靠性或节省的集成成本上。

## 6. 需要验证的经济模型

建议把单位贡献定义为：平台实收服务费/佣金 − 模型与检索成本 − 上游接口费 − 支付成本 − 人工异常处理 − 由平台承担的补救损失。GMV 和 Agent 调用量都不能替代这个指标。

现实商品常有既有商户与支付关系，初期更适合证明渠道增量或可靠执行服务的付费价值；数字 API 小额交易更适合预付额度/聚合计量。具体费率应来自实际成本与买卖双方验证，不应照抄公开平台费率。

首轮试点应报告：真实独立买方数、重复需求、覆盖率、准确可用报价率、获授权后的完成率、总完成时间、人工介入率、争议与退款闭环、每完成任务净贡献。按自动完成、人工协助、外部跳转、仅模拟分组；单列补贴、内部测试和生态自交易。

**关键未决问题：**哪个需求侧 Agent 愿意持续接入；首个地区和服务类目；供应方是否允许转售/代办；谁承担客服与补救；什么证据足以验收。以上不能仅靠公开资料解决，需要下一阶段获得明确授权后的访谈或受控试点。
