原 taskId：`f6e28a73-c53a-4a98-b32a-16d25ce828eb`

最终再次读取状态：`completed`，独立验收通过。仅提交了一个任务，未授予任何外部写操作许可。以下为交付物 `deliverable.md` 的完整内容。

# Coffee Lab 两款咖啡候选比较

## 范围与结论

本文仅依据已提供的两份目录观测编写，未执行新的查询或业务操作。来源为 Coffee Lab 隔离测试商家，证据类型为 `fixture`（测试数据），不能据此认定真实商家的商品、库存或履约能力。

两款候选具有不同变体 ID，但属于同一产品 `gid://shopify/Product/9001`。因此，本文将“两款不同候选”理解为两个不同的咖啡变体。

## 候选比较

| 项目 | 浅烘焙候选 | 深烘焙候选 |
|---|---|---|
| 来源名称原文 | Synthetic coffee — Light roast | Synthetic coffee — Dark roast |
| 变体 ID | `gid://shopify/ProductVariant/9034` | `gid://shopify/ProductVariant/9036` |
| SKU | `FIXTURE-0` | `FIXTURE-2` |
| 观测时显示价格 | 10.00 | 30.00 |
| 币种 | USD（美元） | USD（美元） |
| 来源 | 观测 A，见下方来源记录 | 观测 B，见下方来源记录 |
| 来源报告可用 | 是（`availableReported: true`） | 是（`availableReported: true`） |
| 库存数量 | 未知，尚未核验 | 未知，尚未核验 |
| 配送承诺 | 未知，尚未核验 | 未知，尚未核验 |
| 商家合作状态 | 未核验（`partnerTrust: unverified`） | 未核验（`partnerTrust: unverified`） |
| 来源报告原生结账资格 | 否（`nativeCheckoutEligibleReported: false`） | 否（`nativeCheckoutEligibleReported: false`） |

价格换算采用 USD 每 100 个最小货币单位等于 1 美元：来源值 `1000` 和 `3000` 分别对应 10.00 USD 和 30.00 USD。深烘焙候选显示价格高出 20.00 USD，为浅烘焙候选的 3 倍；未提供规格、重量、税费或运费信息，无法比较单位价格或到手总价。

## 来源记录

两份观测均指向以下商家与接口：

- 商家：Coffee Lab（`coffee-lab`）
- Shop ID：`gid://shopify/Shop/9012`
- 域名：`eigos-coffee-fixture.myshopify.com`
- 接口：`https://eigos-coffee-fixture.myshopify.com/api/ucp/mcp`
- 动作：`ReadMerchantVariants`；接口操作：`lookup_catalog`
- 国家字段：US；证据类型：`fixture`
- 回执 HTTP 状态：200；认证方式：匿名

| 来源 | CatalogObservation ID | 观测时间（UTC） | 来源标注有效期截至（UTC） |
|---|---|---|---|
| A | `08f1ca56-a2a3-4fe4-8e09-7634e4427293` | 2026-10-22 14:20:12.253 | 2026-10-22 14:25:12.243 |
| B | `117f2887-e357-4c1f-9946-be11d979eeec` | 2026-10-22 14:21:08.381 | 2026-10-22 14:26:08.377 |

上述有效期依据均为 `local_refresh_limit`。本文所称显示价格仅指各自观测时点的返回值，未重新核验生成文档时的实时价格，也未确认来源有效期是否仍覆盖使用时点。

## 证据限制

- 两份目录结果均标记为 `partial_or_unknown`，只能确认这两个已返回候选，不能认定目录完整或没有其他候选。
- “来源报告可用”不等于已核实库存数量、可下单或可配送；两款的原生结账资格均被来源报告为否。
- 库存数量、配送承诺及商家合作状态均未核验，不能据此承诺供货、送达时间或合作关系。
- 名称包含浅烘焙与深烘焙描述，但没有风味、产地、包装规格等证据，无法进一步判断口味或性价比。
- 两份来源均记录 `noBusinessWrites: true`。本文仅整理已提供数据，未创建购物车、预订、下单或付款。
