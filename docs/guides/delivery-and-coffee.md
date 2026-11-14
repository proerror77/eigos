# 配送查询与瑞幸到店自取

Agent 从已发布的 EIGOS Ontology 发现可用 Function 和 Action。已授权的跑腿和外卖查询可以通过 MCP 调用 Function，也可以由 Worker 在任务中用 `complete_with_function` 直接返回。瑞幸读取需要原 PA 的供应商会话，沿既有 `pa-request` 续接。确认下单涉及供应商状态变化，以同一任务中的两项 Action 保存预览和原订单。设计参考 [Palantir Ontology MCP](https://www.palantir.com/docs/foundry/ontology-mcp) 和 [External Functions](https://www.palantir.com/docs/foundry/data-connection/external-functions)。

## 本次查询的位置

瑞幸门店和美团外卖共用 Ontology 的 `TaskLocation`。已知地点由调用方直接给坐标，或在同一任务中请求 PA 解析。用户指定地址用 `location.source = specified`，行程已经选定的地点用 `planned`，附近查询直接调用供应商 Function 并省略地点。需要位置时，原任务会等待 `location.resolve`，通过现有 `respond_to_task` 回传，随即继续供应商查询。

PA 可以用操作系统定位权限，或在 EIGOS 工作台的待处理任务里点「共享本机当前位置」。请用随身设备打开工作台。当前工作台按需读取一次浏览器 WGS84 坐标，使用采集时间和精度。瑞幸当前门店查询支持这一路径。外卖需要高德 GCJ-02 坐标，由有对应地图能力的 PA 提供，或在工作台输入已确认的收餐地点和高德坐标。坐标系错误、定位过期或精度不足时，提示指定地址。参考 [W3C 设备定位规范](https://www.w3.org/TR/geolocation/)和[高德坐标转换](https://lbs.amap.com/api/webservice/guide/api/convert)。

位置回传只供同一任务、owner 和已授权的服务使用。设备位置最多使用 2 分钟，瑞幸要求误差不超过 300 米，外卖不超过 100 米。指定和计划地点的回复在该位置请求发出后 5 分钟内可用于查询。员工或会员需要 `PALocation` 来源读取和 `resolveTaskLocation` Function 权限。坐标保留在原 PA 请求与来源调用参数中供该任务重试和检查，Ontology 给 Agent 的位置引用只返回来源、时间与精度等元数据。验收环境没有配置外卖真实账号或手机地图来源。

## 美团跑腿

`listMeituanPaotuiAddresses` 返回当前授权账号的地址 ID 与地点标签。选定同城两端、物品、重量和配送方式后，`quoteMeituanPaotui` 返回当前配送费、原价、预计时效和各字段的观察时间。金额以分计。官方 CLI 仅用于地址列表、报价所需联系方式和配送预览，电话号码及预览订单令牌留在连接器进程内。参考[美团跑腿官方工具](https://github.com/meituan/MT-Paotui-For-Client)。

Gateway 和 Worker 的 `EIGOS_PAOTUI_CONNECTION_FILE` 可以指向一个专用于该运行账号的私有文件。只在能使用本人已授权 `pt-passport` 会话的机器启用。文件权限为 `0600`，按实际 EIGOS owner 配置 `owner`、`active`、`skillDirectory` 和 `passportExecutable`。后两项为同机已安装官方组件的绝对路径。分配 `MeituanPaotui` 来源读取权限和两项 Function 权限。独立机器上的生产部署需要该执行节点自己的合法来源连接。

## 美团外卖

`findMeituanWaimaiShops` 接受明确的高德坐标及可选菜品或商家关键词，读取商家是否可配送、列表运费、起送额和平均配送分钟数。对选中商家，`readMeituanWaimaiArrival` 用同一个地点引用或别处已确认的同一坐标读取官方送达时段。供应商给的时间戳为零时保留其文字和空时间，不从平均时长推算一个送达承诺。商家列表费用为预估，结算页可以不同。参考[美团企业版外卖 API](https://h5.dianping.com/app/bep-docs/sky-doc/canyinopenapi/waimai_api.html)和[美团外卖配送费说明](https://rules-center.meituan.com/m/detail/guize/222?activeRule=1)。

使用美团发放的企业渠道测试账号。Gateway 和 Worker 的 `EIGOS_WAIMAI_CONNECTION_FILE` 指向对应执行用户所有的 `0600` 文件，字段为 `owner`、`active`、`environment`、`token`、`sign`、`aesKey` 和供应商分配的 `version`。生产与测试结果分别标记。授予 `MeituanWaimai` 来源读取权限和对应的两个 Function 权限。当前只用商家列表、预计送达查询接口。

## 瑞幸咖啡

原 PA 登录瑞幸开放平台并把官方 MCP Token 保存在 PA 本机。通过现有 EIGOS 入口提交任务，读回待办后，PA 执行清单中对应的已发布读取或确认操作。门店使用用户给出的准确位置，商品和规格以所选门店当次返回的 SKU 为准。参考[瑞幸官方 MCP](https://open.lkcoffee.com/mcp)和[官方 Skill](https://open.lkcoffee.com/skill)。

| Ontology 入口 | 瑞幸操作 |
| --- | --- |
| `findLuckinShops` | 查附近到店自取门店 |
| `searchLuckinProducts`、`readLuckinProduct`、`selectLuckinProductOption` | 查选定门店的商品、规格和参考价格 |
| `PreviewLuckinPickup` | 取得官方预览，核对店铺、SKU、数量以后保存预览 |
| `SubmitLuckinPickup` | 原 PA 展示预览并获取本人确认。PA 复核原条款，提交一次，回传原订单 ID 和金额 |
| `readLuckinPickup`、`readLuckinPickupStatus` | 读取原预览和订单 ID。付款后通过瑞幸回查当次订单状态和可用取餐码 |

PA 使用 `LuckinPA` 加入现有待办消费流程。它从 EIGOS 读取等待中的 task，用原 request ID 回传；其本地 `LuckinMcp` 连接瑞幸，供应商凭据不进入 EIGOS。已有 PA 客户端也可使用相同 `pa-request` 和 `respond_to_task`，按返回的 schema 答复。发布端需要授予 `Luckin` 的来源、相关 Function 和 Action 以及 `LuckinPickupOrder` 读取权限。

在 PA 的终端上，构建后可用 `node dist/scripts/luckin-pa.js TASK_ID` 处理一次当前读取或预览待办，下一次待办出现后继续处理同一个 task。环境由 PA 本地安全加载：

| 变量 | 取值 |
| --- | --- |
| `EIGOS_PA_URL`、`EIGOS_PA_TOKEN` | PA 已配置的 EIGOS HTTPS 地址及原 owner 登录 |
| `LUCKIN_MCP_TOKEN` | 原 PA 的瑞幸官方 MCP Token |
| `EIGOS_LUCKIN_PA_CONNECTION` | 本次 PA 安装的稳定随机 64 位十六进制 ID |
| `EIGOS_LUCKIN_PA_DIRECTORY` | 由原 PA 用户持有的私有绝对目录 |

实际创建订单时，PA 操作员在同一命令加 `--confirm-order`，交互显示店铺、商品和价格，输入「确认下单」才继续。前次预览与确认后的预览条款变化、账号变更或查询已过期时需要重新确认。已发送但回执丢失时查原订单，付款由用户通过 PA 收到的瑞幸二维码完成。确认后再次预览，创建订单时将官方返回的优惠券字段原样传回瑞幸。完整支付地址和优惠券凭证留在 PA，本体保存原订单 ID、金额及状态。

## 运单查询供应商

优先验证多承运商的**快递鸟即时查询**。官方 `8002` 返回轨迹及状态，主流承运商可自动识别。外部顺丰运单需要收寄人手机号后四位，京东运单需要对应商家编码。正式接入需要查询产品权限和商户账号。试用覆盖和 `8002` 正式权限向供应商确认。参考[快递鸟即时查询文档](https://www.kdniao.com/api-trackexpress)。

备选**快递100实时查询**，使用其官方 API 的承运商编码及运单号，按所查承运商要求补充电话校验。仅服务顺丰时可评估**顺丰丰桥路由查询**，需确认账号权限及运单归属。参考[快递100实时查询](https://api.kuaidi100.com/document/5f0ffb5ebc8da837cbd8aefc.html)及[顺丰开放平台](https://www.sf-express.com/chn/sc/support-more/qiao)。

接入验收使用用户有权查询的已存在运单，只返回承运商状态和带时间的轨迹。查询可继续沿用同一 MCP Function，供应商接入任选对应的既有 PA 或服务来源授权。此阶段快递属于供应商选型。
