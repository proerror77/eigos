# RollingGo 国内端点机票查询

`flight.search.query` 为 MCP 与 A2A 共用的只读能力，默认不注册。它使用国内服务地址 `https://mcp.rollinggo.cn/mcp/flight`，支持机场代码查询，以及按城市代码搜索单程／往返航班。它不支持预订、付款、锁座、出票或订单管理。

## 接入状态

官方 [README](https://github.com/RollingGo-AI/rollinggo-hotel-mcp) 公开了 `searchAirports` 和 `searchFlights`。但 2026-11-02 使用现有私有 Key 实测：国内酒店 `/mcp` 握手成功，`/mcp/flight` 返回 404，提示路由不存在；官方 CLI `rollinggo-flight@0.1.5` 使用的 `/mcp/airportsearch`、`/mcp/flightsearch` 也返回 404。本实现没有切换到另一来源、模拟航班或把失败当成空结果。

因此当前是**代码接入及合成验证完成，真实供应商联调未通过**。输入依据官方 [机票工作流](https://github.com/RollingGo-AI/RollingGoResource/blob/main/assets/skills/rollinggo-searchflight-1/package/1778665993866-68afd658d6/rollinggo-searchflight-cn/references/flight-workflows.md) 与 CLI 0.1.5；输出只接受明确成功标志及已审查字段的保守旧版格式。上游恢复后须读取实际 `tools/list`、核对参数与响应格式，并分别验收机场、单程、往返及无结果查询，才能启用生产配置。国内端点不代表航线只覆盖中国；当前航线覆盖范围尚未验证。

## 配置

Gateway 与 Worker 使用一致配置，机票配置与现有国际酒店配置分开，不能由酒店 Key 的存在自动启用：

- `EIGOS_ROLLINGGO_FLIGHT_KEY_FILE`：绝对路径、进程用户拥有、权限不超过 `0600` 的私有普通文件。
- `EIGOS_ROLLINGGO_FLIGHT_KEY_SHA256`：去掉首尾空白后的 Key 的 SHA-256；轮换需同步指纹并重启进程。
- `EIGOS_PERSONAL_SOURCE_OWNER`：来源账户的准确 owner 分区；仍需当前来源、任务、字段和模型通道权限。

Key 不进入模型输入、工具参数或结果。连接器固定 HTTPS 端点，禁止重定向，限制响应大小、请求次数和超时；每次只允许一个准确只读工具调用，结束前重新验证 Key。

## 输入与结果

```json
{"kind":"airports","keyword":"Hangzhou"}
```

机场查询完成后，可使用已确认的 `cityCode` 创建航班查询；不会把 `airportCode` 自动替换成城市代码，也不会在原任务里自动放宽日期或舱位。当前版本只支持城市代码查询，精确机场过滤尚未接入。

```json
{"kind":"flights","fromCity":"SHA","toCity":"BJS","fromDate":"2099-01-01","tripType":"ONE_WAY","adultNumber":1,"childNumber":0,"cabinGrade":"ECONOMY"}
```

往返使用 `tripType: "ROUND_TRIP"`，并增加不早于去程的 `retDate`。日期、人数和舱位必须明确；不接受过去的出发日期，单次总人数上限为 9。日期按 `Asia/Shanghai` 检查，航段时间保留来源字符串，不推断时区或中转可行性。

独立定义文件 `packages/ontology/definitions/rollinggo-flight-readonly.json` 绑定三个只读动作：`SearchRollingGoAirports`、`SearchRollingGoOneWayFlights`、`SearchRollingGoRoundTripFlights`。每个任务只能执行与已固定输入匹配的动作。

结果映射到 `Airport`、`FlightSegment` 和本次搜索的 `FlightFare`；来源观察与请求、范围和 `SourceReceipt` 关联。`rollingGoFlightSearchStatus` 验证请求版本、来源、五分钟本地时效和范围。任务必须读取并评估自己的已接受观察才能完成。原始执行绑定仅供内部完整性检查，获准的模型／PA 只读取固定业务视图。

`totalAdultPrice` 保留为来源字段，不计算成人加儿童的总价。金额单位、计价口径及费用完整性尚未验证，均标为 `unknown`，不进入可比较的 `MonetaryFact`；币种只使用来源返回值。参考价、搜索成功、已预订和已出票是不同结果。

## 既有业务库

新增本体是 v27，准确 v26 及更早版本仍保留。启动不会自动激活新本体或增加权限。部署前应停止 Gateway／Worker，备份私有数据库，并先完成到准确 v26 的既有升级。Foundation 策略先使用 `scripts/upgrade-rollinggo-flight-policy.mjs`，以准确旧策略 digest/revision 预览，再按需 `--apply`；它保留原有来源授权、动作／函数列表及到期时间，不授予机票权限。

然后通过 `scripts/install-rollinggo-flight-readonly.mjs --database /absolute/private/tasks.sqlite` 预览，以返回的 digest/generation 加 `--expected-digest`、`--expected-generation` 和 `--apply` 激活。正式权威需同时加载既有 `EIGOS_AUTHORITY_FILE`。只接受准确 v26 前身，拒绝未知修改或并发代次变化，重复安装幂等。Gateway、Worker 和任务均使用共享库中的准确发布；不得创建第二个正式业务库。本次代码交付没有迁移、重启或启用正式实例。
