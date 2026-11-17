# 高德地图与天气

EIGOS 通过同一套 Ontology MCP 提供地图、路线和天气 Function。查询直接返回供应商结果。高德来源以 owner 授权，使用官方 Streamable HTTP MCP 和 Web 服务。参考 [Palantir Ontology MCP](https://www.palantir.com/docs/foundry/ontology-mcp)和[外部查询 Function](https://www.palantir.com/docs/foundry/data-connection/external-functions)。

| Ontology Function | 用途 |
| --- | --- |
| `geocodeAddress` 和 `reverseGeocode` | 用地址查高德坐标候选，或由坐标查所属行政区 |
| `searchMapPlaces` 和 `readMapPlace` | 查地标、门店和地点详情。关键词搜索只给地点 ID 时，继续查该地点详情 |
| `searchNearbyPlaces` | 查当前位置或指定地点周边。缺少地点时，由原 PA 在同一任务提供一次定位 |
| `estimateMapRoute` | 查步行与驾车路线的距离和预计用时。起终点可以是地址或坐标 |
| `readWeather` | 查城市、区县或实际地点的实况与日预报。实况用 `mode: "current"`，今日至未来三天的预报用 `mode: "forecast"` |

查「上海明天的天气」可在 EIGOS MCP 直接调用 `evaluate_ontology`，传入 `{"function":"readWeather","input":{"city":"上海","mode":"forecast"}}`。问「我这里现在多少度」则提交原 PA 任务，由 Agent 调用同一个天气 Function。PA 回传后，将设备坐标转换为高德坐标并识别所属区县。天气请求使用行政区编码。地点模糊且影响结果时，请用户确认城市或地址。实况的发布时间由高德提供。预报返回高德提供的日期与昼夜天气及温度。参考[高德 MCP 服务](https://lbs.amap.com/api/mcp-server/summary)和[天气 Web 服务](https://lbs.amap.com/api/webservice/guide/api-advanced/weatherinfo)。

设备定位通过工作台或 PA 共享，带上采集时间、精度和坐标系。指定或行程地点优先。高德地图和天气查询使用 `TaskLocation`，位置引用只在原任务和获授权用途内有效。两类坐标均保留来源。WGS84 转 GCJ-02 使用[高德官方坐标转换](https://lbs.amap.com/api/webservice/guide/api/convert)。具备该来源授权的美团外卖任务可以直接使用浏览器共享的位置，查配送费和预计送达复用同一个收餐地点。

叫车任务使用 `RideInquiryWithPlaceClues.estimate`。用户明确指定上车点时，Action 直接查询滴滴地点。省略上车点时，Action 在原任务向 PA 请求手机定位，要求两分钟内采集且精度为 50 米或更好。它通过高德将标明 WGS84 的设备定位转换为 GCJ-02，标明 GCJ-02 的定位直接反查地址。滴滴使用与地址对应的实时 POI 估价和计算车程。多个候选时，在原任务请用户确认。目的地缺失或定位不可用时，可在原任务补充地址。结果保留坐标转换状态。车程来源不可用时，车程显示未知。参考 [Palantir Actions](https://www.palantir.com/docs/foundry/action-types/overview)、[Palantir Functions](https://www.palantir.com/docs/foundry/functions/overview) 和 [滴滴 MCP 坐标约束](https://mcp.didichuxing.com/api)。

## 来源开通

从高德开放平台取得 Web 服务 Key。Gateway 和 Worker 的 `EIGOS_AMAP_CONNECTION_FILE` 指向运行用户拥有的 `0600` JSON 文件，结构为 `owner`、`active`、`expiresAt`、`keyFile` 和 `keySha256`。其中 `keyFile` 为私有绝对路径，`keySha256` 是去掉首尾空白后的 Key 的 SHA-256。按 owner 授予 `Amap` 来源读取权限和所需 Function 的执行权限。设备位置另使用同一 owner 的 `PALocation` 权限。参考[高德开发者开通说明](https://lbs.amap.com/api/mcp-server/create-project-and-key)。

指定地点的地图和天气查询不需要设备定位授权。地图和天气查询只使用已公开的查询操作。接入验收可先查公开地标和城市天气，再验证设备共享与坐标转换。测试替身通过不等于已取得高德账户权限。

## 滴滴地图与打车链接

`generateDidiRideAppLink` 从已确认起终点的询价生成 App、小程序及浏览器链接。用户指定车型时用该次询价中的对应报价。用户通过链接在滴滴完成下单。`complete_with_action` 可在询价 Action 完成后，将返回的 `RideRequest` 传入链接 Function。

`reverseGeocodeDidi`、`searchDidiNearbyPlaces` 和 `estimateDidiMapRoute` 读取逆地理编码、周边点位和步行、骑行、公交路线。输入需要明确的滴滴原生或 GCJ-02 坐标。公交同时需要完整城市名。路线查询保留供应商提供的距离、耗时及摘要。各结果带来源证据和回执摘要。供应商契约见 [滴滴 MCP 文档](https://mcp.didichuxing.com/api)。
