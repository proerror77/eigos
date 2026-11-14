# 航班动态与跟踪

Agent 通过 EIGOS 的 Ontology MCP 调用 `evaluate_ontology` 与 `readFlightStatus`。输入航班号和出发地当地日期，可用出发与到达机场 IATA 码缩小范围。同一航班号可能对应多段，结果逐段返回。计划、预计和实际时间分别保留，缺失的登机口或时间为 `null`。

**查询示例**

```json
{"function":"readFlightStatus","input":{"flightNumber":"MU5102","departureDate":"2026-11-15","origin":"PEK","destination":"SHA"}}
```

飞常准 Aviation MCP 是受授权的外部数据来源，`EIGOS_VARIFLIGHT_CONNECTION_FILE` 指向私有连接文件。结构与高德连接相同，为 `owner`、`active`、`expiresAt`、`keyFile` 和 `keySha256`。Gateway 与 Worker 使用同一发布版本和来源授权。来源密钥留在服务器凭据文件。参考 [飞常准 Aviation MCP](https://ai.variflight.com/zh/docs/aviation) 与 [Palantir External Functions](https://www.palantir.com/docs/foundry/data-connection/external-functions)。

单次查询直接返回结果。用户明确要求跟踪时，`StartFlightWatch` 为指定机场对和当地出发日期建立一条 `FlightWatch`。填写 `sources: ["VariFlight", "Flightradar24"]` 同时使用两家，也可只选其中一家。省略 `sources` 时使用飞常准。每家来源单独校验连接、来源读取权限和查询 Function 权限。变更来源时，先取消现有跟踪，再按新的来源授权启动。

`ScheduledActions` 约每 15 分钟复查一次，默认最多 8 轮，可选 2 至 24 轮。两家按各自的查询计费规则使用额度。在 `readFlightWatch` 查看飞常准的 `status` 和 Flightradar24 的 `liveTracking`。一家查询失败或授权失效时，另一家可在原窗口和额度内继续。到达、取消、返航或备降由飞常准确认后结束跟踪。所有来源授权失效、截止时间到达或额度用尽也会结束。

提醒来自飞常准的状态、至少 5 分钟的预计时间变化、已有登机口或出发航站楼的变化。首次读到延误或取消也可产生提醒。PA 根据跟踪引用及 `alertVersion` 去重和投递。使用 `CancelFlightWatch` 停止跟踪并撤回待处理提醒。参见 [PA 投递提醒](calendar-journey.md#pa-投递提醒)。

## 飞机实时位置

`readLiveFlightPosition` 通过 Flightradar24 官方 MCP 查询已被跟踪的飞机。输入商业航班号，可用起降机场缩小范围。返回 WGS84 坐标、位置时间、高度、地速及供应商提供的到达预估。例行复查只保存匹配状态和检查时间，坐标与到达预估通过该 Function 即时读取。匹配按航班号和机场对，Flightradar24 的实时位置接口没有计划出发日期。无匹配或多个匹配都会如实记录。仅选择 Flightradar24 时，可查询匹配状态，跟踪持续到取消、授权失效、截止或额度用尽。参考 [Flightradar24 MCP](https://fr24api.flightradar24.com/docs/mcp-server)、[API FAQ](https://fr24api.flightradar24.com/docs/faq) 和 [数据保留规则](https://fr24api.flightradar24.com/docs/storage-rules)。

在运行环境离线预装 `@flightradar24/fr24api-mcp@1.0.2`，用 `EIGOS_FR24_MCP_ENTRYPOINT` 指定官方包的 `build/index.js` 绝对路径。`EIGOS_FR24_CONNECTION_FILE` 使用与飞常准相同的私有连接文件字段，Key 由 Flightradar24 提供并绑定该用户。生产数据需要有效订阅。通过原 Ontology 来源权限独立授权 `Flightradar24` 和 `readLiveFlightPosition`。

使用 Flightradar24 跟踪的调用者还需具备 `RefreshFlightWatch` Action 的应用权限和 `refreshFlightWatch` Function 的执行权限。它与飞常准单源跟踪的 `CheckFlightWatch` 共用 Worker 和 `FlightWatch`，按各自已发布的契约调度。两家数据继续通过各自的只读 Function 获取，Action 提交业务状态，过程状态记录在 `ProcessLog`。参考 [Palantir External Functions](https://www.palantir.com/docs/foundry/data-connection/external-functions)、[Actions](https://www.palantir.com/docs/foundry/action-types/overview) 和 [Automate](https://www.palantir.com/docs/foundry/automate/overview)。
