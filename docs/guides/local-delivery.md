# 即时配送服务

EIGOS 分别发布 [淘宝闪购](taobao-instant-delivery.md) 和 [盒马](hema.md)。两家使用各自的账号、配送地址、业务对象、交易 Action、付款入口和原单回查。闪购搜索中出现的盒马门店商品归属于闪购商品目录和订单。

## 安装本机 MCP

从 [dsh-waimai](https://github.com/vb2250158/dsh-waimai) 下载并固定提交 `006f3e06df22cb01b6baf6627f9ca09dd46a6777`（0.9.1）。源码目录运行 `npm install --ignore-scripts --no-audit --no-fund`。建议为两个服务各自启动一个回环实例，使用独立端口、私有状态目录和令牌文件。扫码、短信验证码、地址和支付凭据都在对应的私有页面完成。 [独立 MCP 说明](https://github.com/vb2250158/dsh-waimai/blob/006f3e06df22cb01b6baf6627f9ca09dd46a6777/docs/standalone-mcp.md)

- 在每个实例的 `/mcp` 用公开令牌调用 `list_connections`，取出对应平台的 `accountRef`。
- EIGOS Gateway 和 Worker 必须与相应的 dsh-waimai `/host` 处在同一网络命名空间。各自设置下列文件，文件权限为 `0600`，由运行进程的账号持有。每个文件只接受对应服务的记录。
- 发布定义后，向实际使用者分别授予服务来源、Action、Function、结果对象和关系可见权限。槽位未配置或失效时，对应服务返回授权错误。
- `tokenSha256` 对去掉首尾空白的私有 Host 令牌计算。绑定文件只保存令牌路径和指纹。绑定内容、账号、地址和收银台凭据保存在对应本机私有目录。

| 服务 | 独立配置 | 来源权限 |
| --- | --- | --- |
| 淘宝闪购 | `EIGOS_TAOBAO_INSTANT_DELIVERY_CONNECTION_FILE` | `Eigos/source/TaobaoInstantDelivery` |
| 盒马 | `EIGOS_HEMA_CONNECTION_FILE` | `Eigos/source/Hema` |

## 已确认结果和自动回查

每个服务的 Link 自其搜索结果串到该服务的购物车变更、结算与供应商原单。购物车变更或结算能带上原对象引用时，Action 会校验来源、商品或购物车版本后建立关联。来源已确认该次供应商订单后才建立原单对象。网络中断仅核对原单，未确认的状态继续保留。

各自的下单 Action 会在记录原派发的同一事务登记对应的只读回查。首次约一分钟后读取，正常每五分钟继续，暂时读不到则退避，默认最长四小时。已支付的订单仍会跟踪配送，明确送达、取消或关闭后结束。各服务可用自己的停止观察 Action。 [持续关注](continuous-observation.md)

通过 `complete_with_action` 的原 PA 任务执行购物车变更、下单与付款时，回传 `{ "decision": "approve", "termsDigest": "原请求摘要" }` 前需向用户展示并确认对应条款。每次交易授权分别取得、绑定原账号和原金额。取消、退款和独立运单轨迹在 dsh-waimai 0.9.1 中没有可调用接口。 [Function-backed Actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview) · [Link Types](https://www.palantir.com/docs/foundry/object-link-types/create-link-type) · [Machinery](https://www.palantir.com/docs/foundry/machinery/core-concepts) · [Automate](https://www.palantir.com/docs/foundry/automate/overview)
