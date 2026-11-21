# 淘宝闪购

连接使用淘宝闪购账号及其中已选的收货地址。闪购商超结果中的盒马门店仍按闪购商品和订单处理。

## 连接配置

在 `EIGOS_TAOBAO_INSTANT_DELIVERY_CONNECTION_FILE` 指向的私有绑定文件中为对应 owner 写一条记录。使用对应本机实例的 `port`、`accountRef`、`tokenFile` 及 `tokenSha256`。记录的 `provider` 为 `TaobaoInstantDelivery`，包含 `active` 和 ISO 时间 `expiresAt`。购物车变更和下单需要 `allowOrders: true`。闪购付款需另设 `allowPayment: true`，并在该实例的私有页面完成支付配置。两个权限开关默认关闭。 [本机安装和权限](local-delivery.md)

示例中的 owner、账号引用、有效期和令牌指纹需要换成该服务的实值。

```json
[
  {
    "owner": "replace-with-verified-eigos-owner",
    "provider": "TaobaoInstantDelivery",
    "active": true,
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "accountRef": "4ee50433-6d87-4adb-9775-9cda669c00d1",
    "port": 43815,
    "tokenFile": "/private/taobao-instant-delivery/host.token",
    "tokenSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
]
```

## 商品和订单

| 能力 | EIGOS |
| --- | --- |
| 菜品、附近店铺、指定门店菜单 | `SearchTaobaoInstantDelivery` → `readTaobaoInstantDeliverySearch` |
| 购物车、规格 | `readTaobaoInstantDeliveryCart`、`readTaobaoInstantDeliveryItemOptions` |
| 购物车变更 | `ChangeTaobaoInstantDeliveryCart` → `readTaobaoInstantDeliveryCartChange` |
| 报价、下单 | `PreviewTaobaoInstantDeliveryCheckout`、`SubmitTaobaoInstantDeliveryOrder` |
| 支付准备、付款 | `PrepareTaobaoInstantDeliveryPayment`、`PayTaobaoInstantDeliveryOrder` |
| 订单和付款回读 | `RefreshTaobaoInstantDeliveryOrder`、`readTaobaoInstantDeliveryCheckout`、`readTaobaoInstantDeliveryRecentOrders` |
| 停止原单回查 | `StopTaobaoInstantDeliveryOrderObservation` |

搜索入口为 `InstantDeliveryInquiry.search`，实现类型 `TaobaoInstantDeliverySearch`。默认按 `query` 搜商品，`mode: "stores"` 查一页附近推荐，`mode: "menu"` 与 `merchantId` 组合查门店菜单。搜索或菜单的 `listedPriceMinor` 是人民币分标价。只在供应商证实同门店、同商品且为单规格时使用该库存数量。人工验证时返回 `verification_required`。

对于购物车、规格和报价，使用 `taobao_meal` 或 `taobao_retail` 区分闪购内部路径，并传 `merchantId`。餐饮支持新增和从当前行减一件。商超支持单规格加购，规格查询和加购还需要原商品搜索词。变更传 `cartRevision` 和可选的闪购 `search` 引用。报价传原 `cartRevision`、预算 `maxAmountMinor`，以及可选的闪购 `cartChange` 引用。

在 PA 任务中用 `TaobaoInstantDeliveryCartEditing.change`、`TaobaoInstantDeliveryOrdering.submit`、`TaobaoInstantDeliveryOrdering.pay`，分别取得 `taobao_instant_delivery.cart_approval`、`taobao_instant_delivery.order_approval` 和 `taobao_instant_delivery.payment_approval`。用相同服务的读回 Function 读结果。付款提交后以独立原单回读判断是否已支付。

对象链为 `TaobaoInstantDeliverySearch` → `TaobaoInstantDeliveryCartChange` → `TaobaoInstantDeliveryCheckout` → `TaobaoInstantDeliveryOrder`。后两者各有自己的 Machinery 过程日志。后台始终调用 `RefreshTaobaoInstantDeliveryOrder`。

在 EIGOS MCP 调用 `complete_with_action` 时可使用以下参数。

```json
{
  "requestId": "taobao-burger-1",
  "action": {
    "interface": {
      "type": "InstantDeliveryInquiry",
      "implementation": "TaobaoInstantDeliverySearch",
      "action": "search"
    },
    "input": {
      "query": "汉堡",
      "limit": 5
    }
  },
  "read": {
    "function": "readTaobaoInstantDeliverySearch",
    "resultParameter": "search"
  }
}
```
