# 淘宝闪购和盒马

| 服务 | Action | 结果 Function |
| --- | --- | --- |
| 淘宝闪购 | `SearchTaobaoInstantDelivery` | `readTaobaoInstantDeliverySearch` |
| 盒马 | `SearchHemaProducts` | `readHemaProductSearch` |

两项服务使用 dsh-waimai 中对应账号已选的配送地址。闪购可以按菜品或商品名称查当前配送范围的搜索结果，也可以读取附近推荐店铺或指定店铺菜单。盒马按已分配的配送组查商品，并读取样本商品的 SKU 数量。Action 将查询快照提交到调用者自己的 Ontology，供应商调用只读取数据。

## 在同一台机器上配置来源

1. 从 [dsh-waimai 仓库](https://github.com/vb2250158/dsh-waimai) 下载并固定分支提交 `006f3e06df22cb01b6baf6627f9ca09dd46a6777`（0.9.1）。在其源码目录运行 `npm install --ignore-scripts --no-audit --no-fund`，按 [独立 MCP 说明](https://github.com/vb2250158/dsh-waimai/blob/master/docs/standalone-mcp.md) 创建私有状态目录及两个独立令牌文件，然后运行 `npm run start:mcp`。保留回环监听。登录、账号选择和地址选择在 dsh-waimai 页面完成。
2. 在本机 `/mcp` 用 dsh-waimai 的公开令牌调用 `list_connections`，记下对应平台的 `accountRef`。将每个 EIGOS owner 和平台绑定到其自己的已选账号。运行 EIGOS 的账号必须能安全读取绑定文件与私有 Host 令牌文件。以下为绑定文件示例，两条记录可独立启用。文件权限为 `0600`，`tokenSha256` 对去掉首尾空白的令牌计算。
3. 给 Gateway 和 Worker 设置 `EIGOS_DSH_WAIMAI_CONNECTION_FILE=/绝对路径/本机绑定.json`，发布候选定义，并为对应 owner 分配 Action、执行 Function、结果对象和各自来源（`Eigos/source/TaobaoInstantDelivery` 或 `Eigos/source/Hema`）权限。dsh-waimai 的 `/host` 必须与执行进程处于同一网络命名空间。远端 Gateway 的回环端口无法访问本机 dsh-waimai。

```json
[
  {
    "owner": "local-developer",
    "provider": "TaobaoInstantDelivery",
    "active": true,
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "accountRef": "4ee50433-6d87-4adb-9775-9cda669c00d1",
    "port": 3815,
    "tokenFile": "/private/dsh-waimai/host.token",
    "tokenSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  {
    "owner": "local-developer",
    "provider": "Hema",
    "active": true,
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "accountRef": "e4da3d57-9284-4737-99e5-92299854ab37",
    "port": 3815,
    "tokenFile": "/private/dsh-waimai/host.token",
    "tokenSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
]
```

## 用 EIGOS MCP 搜索

在 EIGOS 的 `complete_with_action` 中传入：

```json
{
  "requestId": "instant-milk-1",
  "action": {
    "interface": {
      "type": "InstantDeliveryInquiry",
      "implementation": "TaobaoInstantDeliverySearch",
      "action": "search"
    },
    "input": { "mode": "products", "query": "牛奶", "limit": 5 }
  },
  "read": { "function": "readTaobaoInstantDeliverySearch", "resultParameter": "search" }
}
```

`mode: "stores"` 读取一页附近推荐，`query` 可按店名筛选当前页。拿到 `merchantId` 后，使用 `mode: "menu"` 和 `merchantId` 读取该店菜单，`query` 可选。查盒马时改用 `GroceryDeliveryInquiry`、`HemaProductSearch`、`readHemaProductSearch`，输入 `{ "query": "鸡蛋", "limit": 5 }`。

- `listedPriceMinor` 是人民币分。它是搜索或菜单标价。结算价、运费和优惠没有查询。
- `stockEvidence: "verified"` 表示只读的独立库存调用返回了数量。闪购只有能匹配同一门店、同一商品且为单规格的结果才使用库存总数。盒马多规格逐项保留数量。每次最多核验三个商品。未取得数量时 `stockQuantity` 为 `null`，人工验证时返回 `verification_required`。
- `complete: false` 表示查询受分页、数量上限、配送组或来源失败限制。结果按观察时间保存，五分钟内可通过返回的 `search` 引用读回。绑定被撤销、改换或过期时需恢复对应授权并发起新查询。
- 闪购搜索里的盒马门店是闪购渠道的观察。只有 `Hema` Action 代表盒马直连。闪购和盒马可能分别要求人工验证，请在官方渠道处理。

接入沿用 [External Functions](https://www.palantir.com/docs/foundry/data-connection/external-functions)、[Function-backed Actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview) 和 [Ontology MCP](https://www.palantir.com/docs/foundry/ontology-mcp)。本机 Host 令牌只由连接器使用，连接器只接受固定查询工具与回环端点。结果对象保留经校验的商品事实和状态，不包含地址、账号引用、会话或供应商原文。
