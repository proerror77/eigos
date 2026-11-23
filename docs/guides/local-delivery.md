# 即时配送服务

EIGOS 分别发布 [淘宝闪购](taobao-instant-delivery.md) 和 [盒马](hema.md)。两家使用各自的账号、配送地址、业务对象、交易 Action、付款入口和原单回查。闪购搜索中出现的盒马门店商品归属于闪购商品目录和订单。

## 安装本机 MCP

从 [dsh-waimai](https://github.com/vb2250158/dsh-waimai) 下载并固定提交 `006f3e06df22cb01b6baf6627f9ca09dd46a6777`（0.9.1）。源码目录运行 `npm install --ignore-scripts --no-audit --no-fund`。建议为两个服务各自启动一个回环实例，使用独立端口、私有状态目录和令牌文件。扫码、短信验证码、地址和支付凭据都在对应的私有页面完成。 [独立 MCP 说明](https://github.com/vb2250158/dsh-waimai/blob/006f3e06df22cb01b6baf6627f9ca09dd46a6777/docs/standalone-mcp.md)

- 在每个实例的 `/mcp` 用公开令牌调用 `list_connections`，取出对应平台的 `accountRef`。
- EIGOS Gateway 和 Worker 必须与相应的 dsh-waimai `/host` 处在同一网络命名空间。各自设置下列文件，文件权限为 `0600`，由运行进程的账号持有。每个文件只接受对应服务的记录。
- 发布定义后，向实际使用者分别授予服务来源、Action、Function、结果对象和关系可见权限。槽位未配置或失效时，对应服务返回授权错误。
- `tokenSha256` 对去掉首尾空白的私有 Host 令牌计算。绑定文件只保存令牌路径和指纹。绑定内容、供应商账号、通讯录联系人和收银台凭据保存在对应本机私有目录。

| 服务 | 独立配置 | 来源权限 |
| --- | --- | --- |
| 淘宝闪购 | `EIGOS_TAOBAO_INSTANT_DELIVERY_CONNECTION_FILE` | `Eigos/source/TaobaoInstantDelivery` |
| 盒马 | `EIGOS_HEMA_CONNECTION_FILE` | `Eigos/source/Hema` |

## 常用地点与实际收货地址

在用户明确要求记住地址时，调用 `SavePersonalPlace` 保存用户确认的「家」或「公司」。从 Ontology 查询 `PersonalPlace` 可取得该地点的引用和当前版本。首次保存传 `expectedRevision: 0`，更换地址传当前版本。地址保存在不可变的 `PersonalPlaceVersion`。更换地址时切换 `currentVersion`，旧版本和旧绑定留作历史。新版本需要重新确认对应的供应商地址。个人地点按 owner 隔离。Agent 可读取角色和引用来做配送查询。详细地址、供应商地址列表和保存或绑定操作需要符合[模型数据出境](model-egress.md)的机密数据权限，也可由已授权 PA 直接调用。更换地址沿个人地点与版本的关系执行。

`listTaobaoInstantDeliveryAddresses` 和 `listHemaDeliveryAddresses` 读取已授权账号的地址、标签和当前选择。用户核对后，使用 `BindTaobaoInstantDeliveryAddress` 或 `BindHemaDeliveryAddress`，传地点引用、当前版本及所选 `addressKey`。Action 将当时的常用地点版本与供应商地址快照建立 Link。绑定不会修改供应商账号里的默认地址。

闪购用 `InstantDeliveryInquiry.searchAt`，盒马用 `GroceryDeliveryInquiry.searchAt`。送到家或公司时传 `destination: { source: "personal", place: <地点引用> }`。用户要用平台当前收货地址时传 `destination: { source: "selected" }`。搜索前后校验当前供应商地址。使用个人地点时，当前选择必须匹配已确认的 Link。用 `readTaobaoInstantDeliveryAddressedSearch` 或 `readHemaAddressedSearch` 读取查询结果和 `deliveryAddress`。搜索同时记录实际使用的供应商地址和对应的常用地点版本。结算独立记录 `deliveryAddress`。沿原搜索结算时也记录 `personalPlaceVersion`。原单沿 `checkout` 回查这两个 Link。直接结算同样保留实际使用的供应商地址。地址变化时重新查询。

「我附近」由原 PA 提供任务内定位，「家附近」使用 `searchNearbyPersonalPlace`。若想配送到当前位置，先在对应平台确认实际收货地址。现有 `search` 调用继续使用供应商当前地址，旧查询记录可按原契约读回。 [地图与天气](maps-and-weather.md) · [Interface Action 约束](https://www.palantir.com/docs/foundry/interfaces/interface-action-type-constraints)

## 已确认结果和自动回查

每个服务的 Link 自其搜索结果串到该服务的购物车变更、结算与供应商原单。购物车变更或结算能带上原对象引用时，Action 会校验来源、商品或购物车版本后建立关联。来源已确认该次供应商订单后才建立原单对象。网络中断仅核对原单，未确认的状态继续保留。

各自的下单 Action 会在记录原派发的同一事务登记对应的只读回查。首次约一分钟后读取，正常每五分钟继续，暂时读不到则退避，默认最长四小时。已支付的订单仍会跟踪配送，明确送达、取消或关闭后结束。各服务可用自己的停止观察 Action。 [持续关注](continuous-observation.md)

通过 `complete_with_action` 的原 PA 任务执行购物车变更、下单与付款时，回传 `{ "decision": "approve", "termsDigest": "原请求摘要" }` 前需向用户展示并确认对应条款。每次交易授权分别取得、绑定原账号和原金额。取消、退款和独立运单轨迹在 dsh-waimai 0.9.1 中没有可调用接口。 [Function-backed Actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview) · [Link Types](https://www.palantir.com/docs/foundry/object-link-types/create-link-type) · [Machinery](https://www.palantir.com/docs/foundry/machinery/core-concepts) · [Automate](https://www.palantir.com/docs/foundry/automate/overview)
