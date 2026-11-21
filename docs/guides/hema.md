# 盒马

连接使用盒马账号及其中已选的配送地址。盒马商品 SKU、可售库存、配送窗口和原订单均从盒马直连读取。

## 连接配置

在 `EIGOS_HEMA_CONNECTION_FILE` 指向的私有绑定文件中为对应 owner 写一条记录。使用盒马本机实例的 `port`、`accountRef`、`tokenFile` 及 `tokenSha256`。记录的 `provider` 为 `Hema`，包含 `active` 和 ISO 时间 `expiresAt`。购物车变更和下单需要 `allowOrders: true`，默认关闭。付款在盒马官方 App 完成。 [本机安装和权限](local-delivery.md)

示例中的 owner、账号引用、有效期和令牌指纹需要换成该服务的实值。

```json
[
  {
    "owner": "replace-with-verified-eigos-owner",
    "provider": "Hema",
    "active": true,
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "accountRef": "e4da3d57-9284-4737-99e5-92299854ab37",
    "port": 43816,
    "tokenFile": "/private/hema/host.token",
    "tokenSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
]
```

## 商品和订单

| 能力 | EIGOS |
| --- | --- |
| 当前配送组内搜索商品 | `SearchHemaProducts` → `readHemaProductSearch` |
| 购物车、商品 SKU | `readHemaCart`、`readHemaItemOptions` |
| 指定 SKU 加购 | `ChangeHemaCart` → `readHemaCartChange` |
| 选定购物车项报价、配送窗口 | `PreviewHemaCheckout`、`SelectHemaDeliveryWindow` |
| 创建订单、官方 App 支付交接 | `SubmitHemaOrder`、`PrepareHemaPayment` |
| 原单和历史订单 | `RefreshHemaOrder`、`readHemaCheckout`、`readHemaRecentOrders` |
| 停止原单回查 | `StopHemaOrderObservation` |

搜索入口为 `GroceryDeliveryInquiry.search`，实现类型为 `HemaProductSearch`，输入 `query` 和可选 `limit`。标价以人民币分返回，SKU 数量来源于随后的独立规格读取。遇到人工验证，返回 `verification_required` 并保留已核验字段。

盒马 Action 使用盒马门店、商品和购物车项。加购传 `merchantId`、`itemId`、原 `query`、`variantRef`、`quantity` 和 `cartRevision`，可以附原盒马 `search` 引用。报价传选定的 `lineIds`、`cartRevision`、预算 `maxAmountMinor` 和可选的盒马 `cartChange` 引用。当前上游要求每个结算行数量为一。盒马若要求选择配送时段，用 `SelectHemaDeliveryWindow` 重报价。

在 PA 任务中用 `HemaCartEditing.change` 和 `HemaOrdering.submit`，分别取得 `hema.cart_approval`、`hema.order_approval`。付款交接返回盒马官方 App 的入口类型。后续回读保留原单给出的状态与配送证据。

对象链为 `HemaProductSearch` → `HemaCartChange` → `HemaCheckout` → `HemaOrder`。后两者各有自己的 Machinery 过程日志，后台只调用 `RefreshHemaOrder`。

在 EIGOS MCP 调用 `complete_with_action` 时可使用以下参数。

```json
{
  "requestId": "hema-eggs-1",
  "action": {
    "interface": {
      "type": "GroceryDeliveryInquiry",
      "implementation": "HemaProductSearch",
      "action": "search"
    },
    "input": {
      "query": "鸡蛋",
      "limit": 5
    }
  },
  "read": {
    "function": "readHemaProductSearch",
    "resultParameter": "search"
  }
}
```
