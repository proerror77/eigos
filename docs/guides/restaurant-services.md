# 餐厅搜索、空位与订座

从 `/mcp` 使用 `complete_with_action` 可以在一次调用中提交 Action 并读回结果。需要原 PA 执行供应商查询或确认订单时，用 `submit_task` 并在同一任务处理 `get_task` 返回的请求。

| 步骤 | Interface Action | 实现 | 读回 |
| --- | --- | --- | --- |
| 查餐厅 | `RestaurantDiscovery.search` | `RestaurantSearchResult` | `readRestaurantSearch`，绑定 `search` |
| 查指定门店、日期、人数 | `RestaurantVisitReview.review` | `RestaurantVisitOption` | `readRestaurantVisit`，绑定 `visit` |
| 选择 TableCheck 时段 | `RestaurantReservationOffer.prepare` | `TableCheckReservation` | `readTableCheckReservation`，绑定 `reservation` |
| 确认、取消、对账 | `NetTableReservation.confirm`、`cancel`、`reconcile` | 传原 `TableCheckReservation` 引用 | `readTableCheckReservation`，绑定 `reservation` |

搜索接受 `query`、`city`、可选的 `providers`、`center`（GCJ-02）、`radiusMeters` 和每个来源的 `limit`。默认查高德、点评、TableCheck 和美团企业版。每路返回状态，同名门店按各供应商的原始标识分别保留。用搜索结果里的门店引用提交 `review`，输入 `venue`、当地 `date`、`partySize` 和可选的 `channel`。读回中的 `handoff` 表示有可打开的订座页。只有状态为 `observed` 的 `availableTimes` 是指定日期和人数的空位观察。

## 供应商与授权

| 供应商 | 数据及连接 |
| --- | --- |
| 高德 | 复用已授权的地点搜索 Function 和 `EIGOS_AMAP_CONNECTION_FILE`。提供餐厅候选和地址。 |
| 大众点评 | 复用已授权的 POI 列表和详情，门店详情提供预订链接时可以交接。 [点评配置](dianping.md) |
| 美团企业版到餐 | `EIGOS_MEITUAN_DINING_CONNECTION_FILE` 指向私有配置，字段为 `owner`、`active`、`expiresAt`、`environment`、`entId`、`token`、`sign`、`aesKey` 和合作方指定的 `version`。API 需要明确的坐标。门店可以返回支持预订标记。买家侧可订库存和交易 API 需要另行取得合作方文档及授权。 [美团企业版到餐 API](https://h5.dianping.com/app/bep-docs/sky-doc/canyinopenapi/daocan_api.html) |
| TableCheck | `EIGOS_TABLECHECK_CONNECTION_FILE` 指向私有配置，字段为 `owner`、`active`、`expiresAt`、`keyFile`、`keySha256`。需要直接订座时另填 `distributionKeyFile`、`distributionKeySha256`、`noDepositShopIds`，它只收录已获准无订金交易的门店 ID。订金、预支付或其他担保通过返回的官方页面完成。 [API 申请](https://tablecheck.atlassian.net/wiki/spaces/API/pages/44729064/Request%2BAPI%2BAccess) · [Distribution v1](https://tablecheck.atlassian.net/wiki/spaces/API/pages/4637950094) |
| Resy | 在任务里显式指定 `Resy`，由已连接官方 Resy MCP 的原 PA 消费 `dining.resy.search` 或 `dining.resy.availability`，按同一请求返回的 schema 通过 `respond_to_task` 回传。保留 `pa_reported` 证据。用户在 Resy 的官方页面确认预订。 [官方连接器](https://claude.com/marketplace/connectors/resy) · [官方使用说明](https://www.americanexpress.com/content/dam/amex/en-us/credit-cards/benefits/resy/resy_mcp_app_claude.pdf) |
| 商家官网、微信小程序 | 用 `channel: "official_web"` 或 `"wechat"` 复用原只读试点。配置精确门店及已有来源权限。小程序需要被选门店的分店信息和已登录的原 PA。 [网页和小程序配置](../architecture/ontology.md#网页订位试点) |

私有配置和密钥均由运行进程的用户持有，使用绝对路径、权限 `0600`。SHA-256 针对去掉首尾空白后的密钥计算。生产 Gateway、Worker 和 Indexer 使用同一套已发布定义与连接。为调用账号开通所用对象、Interface、Link、Action、Function 和来源读取权限。供应商授权及产品凭据独立申请。

## TableCheck 订座

准备 Action 使用 `readRestaurantVisit` 中的绝对时间 `availableInstants`，把其中一个值原样传给 `startsAt`。展示门店、当地日期、时间、人数和条款摘要，然后让用户确认。确认 Action 接受同一订座对象引用、`approval`（`termsDigest`、`approvedAt`）和 `contact`（姓名及 E.164 电话）。通过任务执行会在同一任务再向原 PA 核对批准。取消请求需要原订座引用与用户确认过的原因。联系人传给供应商，订座对象及供应商回执只保留业务条款、确认号和证据。

确认过程中重新核对同一时段，记录外部操作再请求供应商锁位和创建。取消同样记录外部操作。只有独立读取原预订状态才写入回执。结果为 `unknown` 时，执行原对象的 `reconcile`。如需改期或更改人数，使用原单回执中供应商返回的 `manageUrl` 交接。开发验收使用合成供应商。

Interface 与具体 Action 的映射、门店 Link 和原单回查通过现有 Ontology 执行。 [Palantir Interface Action](https://www.palantir.com/docs/foundry/interfaces/interface-action-type-constraints) · [Palantir Link Types](https://www.palantir.com/docs/foundry/object-link-types/link-types-overview)
