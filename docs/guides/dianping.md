# 大众点评餐厅查询

## 申请权限

向美团点评 POI 开放平台申请合作应用的 **AppKey、AppSecret**，并确认目标城市及以下接口各自的 **Session 授权码**。

| 申请的接口 | 功能 |
| --- | --- |
| `POST /router/poisearch/search` | 关键词、城市或 GCJ-02 周边搜索。申请返回门店地址、距离和类别的权限。 |
| `POST /router/poi/getsinglepoi` | 按 `openshopid` 查详情。确认星级、评论数与标签、人均、推荐菜、营业时间、支持预订状态和 H5 预订链接的字段权限。 |

平台可能为两个接口发放不同 Session。正式联调时核对平台发放的签名说明。 [POI 搜索](https://poiopen.dianping.com/instructions/doc/poisearch.html) · [POI 详情](https://poiopen.dianping.com/instructions/doc/poi.html)

## 配置 EIGOS

Gateway 和 Worker 的 `EIGOS_DIANPING_CONNECTION_FILE` 指向运行用户拥有的私有绝对路径，文件权限为 `0600`。在该文件填写：

```json
{
  "owner": "VERIFIED_EIGOS_OWNER",
  "active": true,
  "expiresAt": "FUTURE_UTC_ISO_TIMESTAMP",
  "appKey": "PLATFORM_APP_KEY",
  "appSecret": "PLATFORM_APP_SECRET",
  "sessions": {
    "search": "POI_SEARCH_SESSION",
    "detail": "POI_DETAILS_SESSION"
  }
}
```

只填写已开通接口的 Session。发布定义后，给符合条件的 owner 授予 `Eigos/source/Dianping` 的来源读取权限，以及相应 Function 的查看与执行权限。连接凭据由运行进程读取，查询和 PA 任务接收规范化结果。

## 从 PA 或 MCP 使用

- `searchDianpingRestaurants` 接受城市和可选关键词，或已确认的 `center`（`latitude`、`longitude` 和 `coordinateSystem: "gcj02"`）。指定地标可先用高德查坐标。半径默认 1 公里，最大 5 公里。
- `readDianpingRestaurant` 接受搜索返回的 `shopId`。响应带查询时间和平台授权返回的字段。供应商未给出币种的价格保留为原始数值，详情坐标保留为坐标系未知。
- 如果来源返回官方 H5 预订链接，PA 可展示给用户核对时段、人数和确认订位。查询时段的可用性仍沿用原 PA 的供给核实。

接入使用来源受控的只读 Function，通过既有 Ontology MCP 和任务执行。 [Palantir External Functions](https://www.palantir.com/docs/foundry/data-connection/external-functions) · [Ontology MCP](https://www.palantir.com/docs/foundry/ontology-mcp)
