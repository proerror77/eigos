# 淘宝和京东购物

Agent 通过 EIGOS Ontology MCP 查找淘宝、天猫及京东联盟的商品，可以保留搜索结果并将一个有来源的商品链接交给买家。用户在平台上选择规格、核对实时价格和库存、提交订单并确认付款。

| 业务 | Ontology 入口 | 供应商能力 |
| --- | --- | --- |
| 淘宝、天猫搜索 | `readTaobaoProducts` 或 `SearchTaobaoProducts` | 淘宝联盟导购物料搜索升级版 `taobao.tbk.dg.material.optional.upgrade` 的消费者比价场景 |
| 京东搜索 | `readJdProducts` 或 `SearchJdProducts` | 京东联盟 `jd.union.open.goods.query` 关键词商品查询 |
| 选中商品并交还买家 | `PrepareTaobaoPurchase`、`PrepareJdPurchase` → `readMarketplacePurchaseHandoff` | 按原商品观察回读通过检验的 HTTPS 商品链接，无外部写入 |

淘宝桌面版 MCP 配置因维护曾暂停。EIGOS 的连接使用两家联盟的公开开发接口。 [淘宝官方通知](https://jianghu.taobao.com/detail/47301_94927182)

两家搜索沿用 `ProductSearch`，以 `{ "query": "折叠雨伞", "country": "CN", "limit": 5 }` 为例。在 PA 中可选择两家的已授权 Action，再通过 `readServiceSearchPages` 对照两页 `MarketplaceProductOffer`。结果保留平台、商品原生 ID、可用的店铺信息、可核对的参考价格和观察时间。联盟只覆盖符合条件的商品，且每页有界。购买链接来自联盟响应，可能包含平台推广参数。库存和配送保持未知。淘宝条目没有 SKU 时不推定具体规格，JD SKU 保留原始整数精度。

购物交接使用搜索结果中当前的具体商品引用，例如 `{ "offer": { "type": "TaobaoProductOffer", "id": "<offer-id>" } }`。随后的读回使用 `{ "handoff": { "type": "MarketplacePurchaseHandoff", "id": "<handoff-id>" } }`。系统复核来源未过期、权限和连接仍有效、商品未被刷新或人工覆盖，并从原报价取商品网址。状态为 `awaiting_buyer`。价格是 CNY 参考价，优惠、地区库存、运费和实付由平台结算页确认。

## 申请与配置

- **淘宝**在淘宝联盟注册推广者，用有导购物料搜索及消费者比价场景权限的淘宝开放平台应用，取得 `AppKey`、`AppSecret` 和推广位 `adzoneId`。凭据 JSON 字段为 `appKey`、`appSecret`、`adzoneId`，均为字符串。使用 [淘宝联盟商品搜索 API](https://developer.alibaba.com/docs/api.htm?apiId=64759)。
- **京东**开通京东联盟开发者应用和关键词商品查询权限，取得 `AppKey`、`AppSecret`。凭据 JSON 字段为 `appKey`、`appSecret`，均为字符串。使用 [京东联盟接口说明](https://jos.jd.com/jdunion)及[关键词商品查询](https://union.jd.com/openplatform/api/v2?apiName=jd.union.open.goods.query)。

在现有 `EIGOS_SERVICE_CONNECTION_FILE` 的私有 JSON 数组中，每个 owner 分别添加一条 `provider: "Taobao"` 或 `provider: "JD"`。沿用 `owner`、`bindingId`、`active`、`expiresAt`、`credentialFile`、`credentialSha256`。凭据文件使用运行用户拥有的权限 `0600` 的绝对路径，指纹按去掉首尾空白后的文件内容计算。连接或凭据变更后，从新搜索页选择商品。

发布定义后按 owner 分配相应的 `Eigos/source/Taobao` 或 `Eigos/source/JD` 来源读取权限，以及所需数据源、商品与结果对象、Function、Action 权限。交接另外需要读 `MarketplacePurchaseHandoff` 以及对应的商品关系。两家权限各自生效。先用已开通的应用执行只读关键字查询，再验证搜索结果的回读、链接以及权限撤回。

设计参考 [Palantir External Functions](https://www.palantir.com/docs/foundry/data-connection/external-functions)、[Action Types](https://www.palantir.com/docs/foundry/action-types/overview) 和 [Ontology MCP](https://www.palantir.com/docs/foundry/ontology-mcp)。供应商读取对应 Function，保留证据页和创建买家交接记录使用现有事务 Action。已支持的外部交易步骤由买家在供应商页面完成。
