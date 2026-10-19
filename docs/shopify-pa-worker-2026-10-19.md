# Shopify 匿名商品查询：PA／Worker 接入

> 历史记录：本文对应 `commerce.catalog.query@1` 的预设查询流程及当时的真实往返。当前 @2 已移除该固定流程，改为 EIGOS Agent 选择和组合独立只读动作，见 [当前实现与验证状态](catalog-agent-actions-2026-10-19.md)。本文的原始任务、结果和证据不改写为新实现的验证。

`commerce.catalog.query@1` 通过现有 `eigos.delegate` 接收自然语言目标，返回最多 3 个已配置商家的代表商品变体。目标市场当前固定为 US，表示目录查询市场，不是已验证的配送目的地。显示单价、可售标记、库存数量和配送承诺分别表达；后两项保持 unknown。

该能力默认关闭，只面向显式配置的本机开发身份。匿名 HTTP 查询真实 Shopify 来源；没有购物车、结账、订单、付款、库存预留或配送执行入口。公开可售不等于有确定库存，更不授予商家合作或购买权限。

## 运行路径

1. PA 使用现有 A2A 客户端发现、提交目标，沿同一 task ID 等待终态并读取 artifact。
2. Worker 的真实模型将目标映射到配置商家和严格输入 `{merchantId, query, country:"US"}`，保留“不下单”等约束。
3. 适配器读取 Global Catalog：`search_catalog` 固定 Shop ID；对选中的变体调用 `get_product`，同时固定 ProductVariant ID 和商家过滤。返回结果仍要核对 Shop ID、canonical myshopify domain 和变体 ID。
4. 店铺 `/.well-known/ucp` 必须声明同版本、同域的 MCP endpoint。`lookup_catalog` 按精确变体回读，核对显示价格、币种和可售标记。
5. 当前有效 Worker 领取者把 prepared 快照投影为 `CatalogRead`，关联 `ProductOffer`、`ProductVariant`、`Provider`、`Channel`、`ServiceRequest` 和 `SourceReceipt`。模型实际读取该对象并调用 `catalogReadStatus`，计划固定读取回执与对象摘要。
6. 已持久化的 read Action 执行时重新发现店铺并再次 `lookup_catalog`。独立核验通过后才产生 accepted artifact 和 verified 本体快照，PA 再读回文件。

来源观察总有效期为 5 分钟，最终店铺读取不能延长初次观察的期限。价格、可售标记或 SKU 发生变化时，在原任务中有限重规划；取消、失去租约或过期读取不能发布迟到结果。空结果只表示这次有界查询没有返回条目。

三条商品的正常路径共 8 次请求：1 次搜索、3 次详情、2 次店铺发现和 2 次店铺精确查询。HTTP POST 仅承载这些只读 MCP 调用。任何返回的 checkout URL 均不访问，商品描述不作为模型指令。

## 本体与权限

业务模型由 `eigos.business@5` 升为 `@6`，增加 `CatalogRead`、3 种关系和 `catalogReadStatus`，共 66 个对象类型、24 个函数、10 个决策 Action。运行契约继续为 `ontology-execution-v7`。原类型定义保持，历史计划受模型摘要校验保护，不自动迁移或恢复。

`ProductOffer` 记录 `display_price`、`pricingCompleteness=partial`、`capacity=unknown`；USD 单价不能冒充含税运的订单总价。SourceReceipt 绑定对象内容与出向关系，变更后函数返回 unknown。Provider 的平台原生身份引用用于确定来源，不证明合作伙伴信任。`catalogReadStatus` 不授予执行权限。

Gateway 仅构造元数据，不运行模型或 HTTP 查询；Worker 才创建匿名 reader。已有 Shopify 账号凭据不会自动用于该能力。生产／JWT 身份、非 loopback 或非配置商家均拒绝。MCP 与 A2A 共用任务、owner、持久领取、取消和 artifact。

## 配置

在授权的本机环境先构建，再启用清单：

```sh
npm run build
EIGOS_SHOPIFY_CATALOG_MERCHANTS='[{"id":"purity-coffee","name":"Purity Coffee","shopId":"gid://shopify/Shop/40613871783","domain":"purity-coffee.myshopify.com"}]' npm run setup:pa
```

后续省略该变量会保留清单；显式 `[]` 关闭。最多 8 家，id／Shop ID／域名各自唯一。`setup:pa` 在停止旧服务前校验配置，保存私有恢复副本并使用不可变构建目录；原 PA profile、凭据和历史任务继续保留。原始 HTTP 响应和读取回执放在 `~/.local/share/eigos/grok-life/shopify-reads/`，文件权限 0600。自定义 `EIGOS_SHOPIFY_AUDIT_DIR` 必须是启用商家时的绝对私有目录。

当前仍使用 Shopify 官方示例 agent profile 协商协议；这不证明 EIGOS 已完成正式平台代理身份发布。账号令牌、生产吞吐、商业合作及任何真实交易另行验证。前期探针范围见 [匿名准入记录](shopify-readonly-admission-2026-10-18.md)。

## 实际验证

2026-10-19 首轮由 Grok Bot／Monk PA 在已连接 Mac 上提交。任务 `b33a7960-f808-4fb0-9e07-2eca81a83e95` 被拒绝，没有 artifact：第三个商品簇的详情只返回其他商家的 10 个变体，目标 Purity Coffee 变体不在其中。准确身份校验阻止了准备阶段，4 次 HTTP 读取及失败任务原样保留。

修复将详情请求从全局商品簇 ID 改为搜索得到的变体 ID，并加商家过滤，继续核对返回身份。该参数方式有 [Shopify Global Catalog 官方文档](https://shopify.dev/docs/agents/catalog/global-catalog#get_product) 支持。回归覆盖拥挤商品簇、默认关闭、owner／商家边界、缺少本体读取、价格变化重规划、空结果、两个取消时点、证据篡改及既有禁止写操作。

第二轮 `f2b3a553-d948-4bda-88c1-e10dac28d7dd` 在模型阶段失败，没有发出新的 Shopify 请求或产生 artifact。失败时正值本机高负载，耗时到达配置的 120 秒模型期限；持久回执只有通用模型失败原因，因此不把超时推断写成供应方错误。随后停止并发本地测试，并以串行完整执行取得 325 项通过。复核期间还修复了既有领域测试的唤醒条件：同时等待任务和供应方意图的持久调度时间。

第三轮由同一 Monk PA 重新提交原目标，任务 `1ec26262-7d40-405a-bf26-6e1ea9923ffc` 于 2026-10-19 10:11:53（Asia/Shanghai）完成且 accepted。4 次真实 Codex 模型调用完成解释和规划，8 次匿名 HTTP 读取完成搜索、准确变体详情与两次店铺核对。模型实际查询 `CatalogRead`、评估 `catalogReadStatus`，其 known 结果通过读取时刻的输出摘要复算；PA 于 10:12 读回 artifact 并报告结果。

| 商品 | Shopify ProductVariant ID | SKU | 当次显示单价 | 当次可售标记 |
| --- | --- | --- | --- | --- |
| FLOW Original Medium Roast | `36130238136487` | `PC12-R` | 29.00 USD | true |
| EASE Dark Roast | `36130229878951` | `PC12-DK` | 29.00 USD | true |
| PROTECT Light-Medium Roast | `42064997318825` | `PC12-PRO` | 29.00 USD | true |

完整 ID 的前缀为 `gid://shopify/ProductVariant/`。这是 10:11 的有时效观察，快照窗口到 10:16:05，不作为以后查询的最新价格。库存数量、配送承诺、结果完整性、商家合作信任继续保持未知／未验证。PA、MCP 和数据库 artifact 内容一致；文件重新序列化后的字节与内容摘要分别记录，不宣称原始文件字节相同。

[归档证据与校验清单](evidence/shopify-pa-2026-10-19/README.md) 包含成功回执、两个失败尝试、12 次累计读取、模型与本体证据、构建及源码摘要。原有 9 条历史任务和两次失败记录未改写，连接 profile／凭据／客户端保持一致。完整 325 项本地测试串行通过，类型检查、构建与差异检查通过。独立观察器只读取 PA 回执、MCP 任务、数据库、本体与已归档来源响应，不提交新任务、不运行模型、不调用 Shopify：

```sh
node --import tsx examples/verify-pa-shopify-e2e.ts --live --session-dir /absolute/private/session
```

它复算真实来源请求／响应摘要及商品身份、价格、币种、可售标记；按模型读取时刻复算 `catalogReadStatus` 输出摘要，区分工具成功与业务结果 known；比较 PA artifact、MCP artifact 和持久记录；保留首轮失败，并校验运行构建、代码冻结摘要、旧任务及连接凭据未变。
