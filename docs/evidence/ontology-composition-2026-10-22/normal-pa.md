原 taskId：`2cd077c7-97f3-4da2-8046-19480152f771`

最终再次读取状态：`completed`，独立验收通过（`accepted: true`）。仅提交一个任务，未授予订单、付款或外部写操作许可。以下为交付物 `deliverable.md` 完整正文。

# Coffee Lab 咖啡候选比较

## 依据与范围

本文仅整理已提供的两条 `InspectCatalogVariant` 观测，未执行新的查询。来源属于 Coffee Lab 隔离测试数据（`evidenceKind: fixture`），不代表真实商家的实时销售情况。

两款候选属于同一商品 `gid://shopify/Product/9001` 的不同变体；本文按两个不同变体进行比较，不将其视为两个独立商品。目录完整性为 `partial_or_unknown`，因此不能据此认定它们是全部候选。

## 候选比较

| 项目 | 候选一 | 候选二 |
|---|---|---|
| 来源名称（保留原文） | Synthetic coffee — Light roast | Synthetic coffee — Medium roast |
| 名称中文释义 | 合成咖啡 — 浅烘焙 | 合成咖啡 — 中烘焙 |
| 变体 ID | `gid://shopify/ProductVariant/9034` | `gid://shopify/ProductVariant/9035` |
| SKU | `FIXTURE-0` | `FIXTURE-1` |
| 观测时显示价格 | 10.00 | 20.00 |
| 币种 | USD（美元） | USD（美元） |
| 来源 | Coffee Lab，详见来源 [1] | Coffee Lab，详见来源 [2] |
| 来源报告可用 | 是（`availableReported: true`） | 是（`availableReported: true`） |
| 库存数量 | 未知，尚未核验 | 未知，尚未核验 |
| 配送承诺 | 未知，尚未核验 | 未知，尚未核验 |
| 商家合作状态 | 未核验（`partnerTrust: unverified`） | 未核验（`partnerTrust: unverified`） |
| 来源报告原生结账资格 | 否（`nativeCheckoutEligibleReported: false`） | 否（`nativeCheckoutEligibleReported: false`） |

价格换算采用 USD 的标准单位：100 美分 = 1 美元。原始价格分别为 `minor: "1000"` 和 `minor: "2000"`。

浅烘焙变体的显示价格比中烘焙变体低 **10.00 USD**；中烘焙变体价格为浅烘焙变体的 **2 倍**。来源未提供重量、包装规格、产地或风味信息，无法比较单位价格或判断哪款更适合具体口味。

## 来源与时效

共同来源身份：

- 商家：Coffee Lab（`coffee-lab`）
- 商店 ID：`gid://shopify/Shop/9012`
- 域名：`eigos-coffee-fixture.myshopify.com`
- 国家上下文：US
- 接口：`https://catalog.shopify.com/api/ucp/mcp`
- 操作：`get_product`；认证方式：匿名；两条回执 HTTP 状态均为 200。

| 来源 | 观测 ID / 回执 ID | 观测时间（UTC） | 本地刷新期限（UTC） |
|---|---|---|---|
| [1] 浅烘焙变体 | `f878657c-06bb-4ad2-9278-c96abf29575e` | 2026-10-22 14:22:12.650 | 2026-10-22 14:27:12.439 |
| [2] 中烘焙变体 | `171462cf-e678-4f37-99ad-18166b45fc58` | 2026-10-22 14:22:12.651 | 2026-10-22 14:27:12.634 |

上述价格是观测时显示值。刷新期限依据为 `local_refresh_limit`，不构成商家锁价或库存保证；本文未重新查询，无法确认交付时是否仍有效。

## 证据限制

- “来源报告可用”不能证明具体库存数量，也不能形成配送或履约承诺。
- 商家名称、域名及成功接口回执不能证明商家合作关系已核验。
- 两条来源均记录 `noBusinessWrites: true`。本次仅生成文档，未创建购物车、预订、下单或付款。
