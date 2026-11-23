# 高德出行观察

每次查询通过已发布的 Interface Action，返回一个可读回的观察对象。高德只接收查询请求。EIGOS 保存实际输入、观察时间和结果摘要，并用 Link 连接起终点、区域与结果。

| Interface Action | 实现 | 关联 |
| --- | --- | --- |
| `MapAddressResolution.geocode` | `ResolveAmapAddress` | 观察记录关联高德返回的候选坐标 |
| `MapRoutePlanning.plan` | `PlanAmapRoute` | 观察记录关联起点、终点和各条路线方案 |
| `MapDistanceMeasurement.measure` | `MeasureAmapDistances` | 观察记录关联共同终点和各条测距结果，每条结果关联其原始起点 |
| `MapTrafficInspection.inspect` | `InspectAmapTraffic` | 观察记录关联矩形查询区域 |

调用后用 `readAmapObservation` 读回同一引用。`complete_with_action` 可把 Action 返回值绑定到 `observation`。有多个地址候选时先由用户选择一个。规划和测距可直接引用这个 `AmapQueryPoint`，或使用用户确认的 GCJ-02 坐标。公交路线要求两端行政区代码，可来自已解析的地点，也可以随点指定。

地址解析、步行和驾车沿用高德 MCP。骑行和公交地铁走高德路径规划 2.0，测距支持直线、驾车和步行，路况是对角线在 10 公里内的矩形区域。读回保留米、秒、观察时间和来源摘要。[高德 MCP](https://lbs.amap.com/api/mcp-server/summary) · [路径规划 2.0](https://lbs.amap.com/api/webservice/guide/api/newroute) · [测距](https://lbs.amap.com/api/webservice/guide/api/direction/#distance) · [交通态势](https://lbs.amap.com/api/webservice/guide/api-advanced/traffic-situation-inquiry)

受邀账号需要独立的地图业务授权。激活包含这四个 Action 的 Ontology 后，可由管理角色运行 `npm run account -- grant-amap-observations` 明确开通。共享高德连接使用已有有效期和账号验证。底层建模沿用 [Function-backed Actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview)、[Interface Link](https://www.palantir.com/docs/foundry/interfaces/interface-link-types-overview) 和 [Link Types](https://www.palantir.com/docs/foundry/object-link-types/create-link-type)。
