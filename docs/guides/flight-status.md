# 航班动态与跟踪

Agent 通过 EIGOS 的 Ontology MCP 调用 `evaluate_ontology` 与 `readFlightStatus`。输入航班号和出发地当地日期，可用出发与到达机场 IATA 码缩小范围。同一航班号可能对应多段，结果逐段返回。计划、预计和实际时间分别保留，缺失的登机口或时间为 `null`。

**查询示例**

```json
{"function":"readFlightStatus","input":{"flightNumber":"MU5102","departureDate":"2026-11-15","origin":"PEK","destination":"SHA"}}
```

飞常准 Aviation MCP 是受授权的外部数据来源，`EIGOS_VARIFLIGHT_CONNECTION_FILE` 指向私有连接文件。结构与高德连接相同，为 `owner`、`active`、`expiresAt`、`keyFile` 和 `keySha256`。Gateway 与 Worker 使用同一发布版本和来源授权。来源密钥留在服务器凭据文件。参考 [飞常准 Aviation MCP](https://ai.variflight.com/zh/docs/aviation) 与 [Palantir External Functions](https://www.palantir.com/docs/foundry/data-connection/external-functions)。

单次查询直接返回结果。用户明确要求跟踪时，`StartFlightWatch` 为指定机场对和当地出发日期建立一条 `FlightWatch`。现有 `ScheduledActions` 定期调用同一查询 Function，使用 `readFlightWatch` 读状态和最新提醒版本，`CancelFlightWatch` 停止跟踪并撤回待处理的提醒。提醒变化包含航班状态、预计时间变化至少 5 分钟、已有登机口或出发航站楼改变。首次读到一条已延误或已取消的航班也可产生提醒。过程状态走现有 `ProcessLog`。参考 [Ontology MCP](https://www.palantir.com/docs/foundry/ontology-mcp/getting-started) 和 [Automate](https://www.palantir.com/docs/foundry/automate/overview)。

飞常准按次计费。跟踪每约 15 分钟复查，默认最多 8 次（按公示单价最多 ¥4），也可显式选 2 至 24 次。到达、取消、返航、备降、授权窗口结束或检查额度用尽后停止。原 PA 使用跟踪引用和 `alertVersion` 识别变更并去重，由 PA 的通知渠道确认送达。停止跟踪后，`alert: null` 表示撤回待投递提醒。飞常准提供的预计时间可能再次变化。参见 [PA 投递提醒](calendar-journey.md#pa-投递提醒)。

## 飞机实时位置

`readLiveFlightPosition` 通过 Flightradar24 官方 MCP 查询已被跟踪的飞机。输入商业航班号，可用起降机场缩小范围。返回 WGS84 坐标、位置时间、高度、地速及供应商提供的到达预估。查询结果缺少匹配飞机时返回空列表。起飞前计划、延误、取消和登机口提醒继续使用飞常准。参考 [Flightradar24 MCP](https://fr24api.flightradar24.com/docs/mcp-server) 和 [API FAQ](https://fr24api.flightradar24.com/docs/faq)。

在运行环境离线预装 `@flightradar24/fr24api-mcp@1.0.2`，用 `EIGOS_FR24_MCP_ENTRYPOINT` 指定官方包的 `build/index.js` 绝对路径。`EIGOS_FR24_CONNECTION_FILE` 使用与飞常准相同的私有连接文件字段，Key 由 Flightradar24 提供并绑定该用户。生产数据需要有效订阅。通过原 Ontology 来源权限独立授权 `Flightradar24` 和 `readLiveFlightPosition`。
