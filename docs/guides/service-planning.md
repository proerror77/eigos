# 服务接口与定时出行

本体负责服务身份、对象关系、业务条件和授权范围；Worker 负责持久化到时执行。活动报名、行程合并、叫车授权、订单创建和独立回查分别保留状态，不以“任务完成”代替供应商履约。

餐厅搜索、门店详情和点评预订入口见[大众点评连接](dianping.md)。

## 自驾用餐计划

用同一个 PA Task 提交目的地、想吃的菜和已知的出发点。Agent 可调用 `searchRestaurantNotes` 发现小红书候选，使用 `readWeather` 查高德短期预报，用 `readWeatherHistory` 向原 PA 请求历史天气。历史回传区分站点观测与再分析，并报告日期覆盖是否完整。通过高德查询去程和返程，用既有 `PrepareSchedulePlan` 请求原 PA 的授权日历忙闲并校验整个行程。

小红书笔记用于发现候选。针对选中的餐厅、菜品和用餐时段，`readDiningAvailability` 向原 PA 请求带来源与有效期的店方供应信息。只有原任务的当前回执可以用于 `StageDiningActivity`。用 Scenario 提案保存去程、用餐和返程。PA 审阅后提交原有 `CommitSchedulePlan`，提交事务复核餐厅回执与日历条件，再通过 `readSchedulePlan` 读回内部安排。过期回执会阻止保存。该链路的外部调用均是查询。

### Worker 来源连接

配置 `EIGOS_XIAOHONGSHU_CONNECTION_FILE` 时，Gateway 和 Worker 使用运行身份拥有的私有 JSON 文件。给目标 owner 授予 `Xiaohongshu`、`PAWeatherHistory` 和 `PADiningAvailability` 所需的来源和 Function 权限。连接绑定同一 owner、启用状态和过期时间。非 loopback 连接必须使用 HTTPS 和私有 `tokenFile`。小红书 MCP 连接仅调用 `search_feeds`，输出公开笔记标题及规范链接。同一 Task 续接 PA 回传时复用查询结果，并重新检查连接权限。

```json
{"owner":"VERIFIED_OWNER","active":true,"expiresAt":"FUTURE_ISO_TIMESTAMP","endpoint":"http://127.0.0.1:18060/mcp"}
```

未配置 Worker 直连接口时，通过原 Task 的 `xiaohongshu.notes.search` 请求已授权 PA 执行同样的只读搜索。连接器在 Grok 或 Cursor 中显示为本机专用时，需要 Worker 可达的受控端点或由具备该能力的 PA 回传。该路径复用既有的 PA 请求和 Scenario 审阅。[外部查询 Function](https://www.palantir.com/docs/foundry/data-connection/external-functions) · [Ontology Scenario](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario)

## 已实现的接口

Interface 按业务语义命名，供应商名称放在具体 Object Type、来源和实现 Action 上。新增供应商实现同一业务契约，并提供自己的连接器、Link 映射与执行条件；不能只因协议同为 MCP 就假定语义、授权或副作用相同。

酒店通过 `HotelSearch` / `HotelOffer` 选择 RollingGo 或飞猪。机票通过 `FlightSearch` / `FlightOffer` 查询飞猪航班。两个业务域均可独立查询，结果按供应商保留。

| Interface / Object | Action 或 Function | 来源与范围 |
| --- | --- | --- |
| `EventSearch` / `LumaEventSearch` | `search` → `SearchLumaEvents` | 默认向原 PA 请求其已连接的 Luma MCP；也支持显式配置的 Luma API |
| `HotelSearch` / `RollingGoHotelSearch` | `search` → `SearchRollingGoHotels` | RollingGo 酒店搜索，参考价，供应商有效期未知 |
| `HotelSearch` / `FliggyHotelSearch` | `readFliggyHotels` 或 `search` → `SearchFliggyHotels` | 飞猪指定地点及日期的酒店候选，展示价和跳转链接 |
| `FlightSearch` / `FliggyFlightSearch` | `readFliggyFlights` 或 `search` → `SearchFliggyFlights` | 飞猪单程、往返及直达航班候选，保留航段、当地时间和展示价 |
| `TravelOfferInquiry` / `TravelOfferSearch` | `search` → `SearchTravelOffers`，`readTravelOfferSearch` | 并行查询两家酒店与飞猪机票，保留每路状态及已成功的搜索页 |
| `ProductSearch` / `ShopifyProductSearch` | `search` → `SearchShopifyProducts` | Shopify Global Catalog 的精确商家与变体身份 |
| `ServiceOffering` | `readServiceOffering`、`evaluateServiceOffering` | 共享来源、有效期和可用性检查；未知值保持未知 |
| `ServiceSearchResult` | `readServiceSearch`、`readServiceSearchPages` | 读取单个或多个查询页，保留每个来源的身份、时效与完整性 |
| `HotelOffer`、`FlightOffer`、`ProductOffer` | `select` → `AttachPlanService` | 按 Interface 的 Link 映射挂到 `SchedulePlan` |
| `AttendableEvent` / `LumaEvent` | `register` → `PrepareEventRegistration` | 准备指定票种的参与者报名，返回 `proposed` |
| `EventRegistration` | `AuthorizeEventRegistration`、`ExecuteEventRegistration` | PA 明确授权后，经原 PA 的 Luma 账号执行零费用报名及独立回查 |
| `EventRegistration` | `RefreshEventRegistration` | 只读回查原报名，允许候补或待审批状态更新；不创建新的报名尝试 |
| `DrivingEstimate` / `DidiDrivingEstimate` | `observe` → `ObserveDidiDrivingTime`、`readDrivingEstimate` | 滴滴 `maps_direction_driving` 返回的时长和距离 |
| `EventTrip` | `PlanEventTrip`、`AuthorizeEventTrip`、`ExecuteEventTrip` | 将活动、日历、路线、报名和定时叫车关联 |
| `RideOrder` / `DidiRideOrder` | `readEventTrip`、`RefreshDidiRideOrder` | 保留原订单 ID；创建回执与独立状态回查分开 |
| `EventTrip` | `CancelEventTrip` | 停止后续定时执行；已经发出的供应商订单仍须单独处理 |

`readServiceSearch` 返回 `complete`、`cursor` 和证据类型。RollingGo 的 top-N 搜索、Shopify 的有界结果都不能证明“其他结果不存在”。酒店住宿不会自动占用用户整段日历；商品没有交付时间时不能被算作按时到货。选入行程只保存内部计划。预订与付款使用单独授权的飞猪交易 Action。

活动、酒店方案和商品变体按供应商、账号绑定、原生身份及必要的报价条件确定对象身份；刷新不会为同一活动另造一个身份。旧版本或同一时间的冲突事实被拒绝。原结果页的成员关系保留；若对象已有更新来源，读取旧页会明确提示已被替代，不会返回空数组或把新价格当成原页价格。

来源字段还会与运行层保留的 `source_values` 基线核对。人工备注等非来源字段可以保留；人工改动的活动时间、地点或价格不会因一次刷新就被认证成供应商事实。

### 飞猪机票与酒店

单独查询可经 `evaluate_ontology` 调用 `readFliggyFlights` 或 `readFliggyHotels`。机票传 `origin`、`destination`、`departureDate`，按需加 `returnDate`、`directOnly`。酒店沿用 `place`、`checkIn`、`nights`、`adults` 和 CNY。两者默认返回最多 5 项，可用 `limit` 请求最多 10 项。搜索页是有界样本。

查机酒或比较酒店时，用 `TravelOfferInquiry.search`（实现类型 `TravelOfferSearch`）提交 `hotel`、`flight` 或两者。传入 `hotel` 会并行调用 RollingGo 与飞猪酒店搜索，传入 `flight` 会在同一批启动飞猪机票搜索。用 `complete_with_action` 可直接返回 `readTravelOfferSearch` 的结果。要排程时先完成查询，再用结果页中的候选引用创建 Scenario 或关联计划。已持有单独 Action 返回的页引用时，仍可用 `readServiceSearchPages` 读取。

每个来源独立校验原用户的 Action、Function、来源权限和连接。结果区分已查询（可能为空）、需授权、供应商不可用以及飞猪酒店不支持的币种。一路供应商查询失败时仍保存其他已成功的结果。保留来源身份、访问模式、时效和展示价。飞猪酒店保留 `occupancyVerified=false`，`amount` 为未知，`priceDisplay` 保留起价或脱敏价。航班保留当地时间和展示票价，实际库存、税费、乘客总价和退改条件由飞猪确认。

连接方式参考 [FlyAI 官方 CLI](https://flyai.open.fliggy.com/docs/quickstart)。来源及只读 Function 的建模参考 [Palantir External Functions](https://www.palantir.com/docs/foundry/data-connection/external-functions)。保留结果的 Action 只编辑 EIGOS 的结果页和候选对象，按 [Ontology MCP](https://www.palantir.com/docs/foundry/ontology-mcp) 公开。飞猪跳转链接供用户自行核价、选择和确认。

已有滴滴原订单后的状态轮询、按需司机位置和接驾提醒见 [滴滴原订单追踪](didi-ride-followup.md)。

## 飞猪合作方机酒交易

机酒搜索继续使用 FlyAI 和 RollingGo 并行查询。进入交易时使用飞猪 TOP 的可交易库存标识。FlyAI 展示价、酒店卡片 ID、航班号和跳转链接无法代替分销商品、政策 ID 或京杭报价 `itemId`。

| 业务 | Ontology 操作 | 供应商能力 |
| --- | --- | --- |
| 酒店 | `readFliggyHotelRates` → `PrepareFliggyHotelBooking` → `CreateFliggyHotelBooking` → `ConfirmFliggyHotelPayment` | 酒店通用分销验价、建单、已收买家款后的支付确认 |
| 酒店 | `RefreshFliggyHotelBooking`、`CancelFliggyHotelBooking` | 按原分销订单号查单及无罚金取消 |
| 国内机票 | `readFliggyFlightQuotes` → `PrepareFliggyFlightBooking` → `CreateFliggyFlightBooking` → `PayFliggyFlightBooking` | 京杭询价、生单、支付，当前支持一位成人的国内单程直飞标准产品 |
| 国内机票 | `RefreshFliggyFlightBooking`、`CloseFliggyFlightBooking` | 原订单详情、独立核对付款和票号证据、未支付关单 |

用 `readFliggyHotelBooking` 或 `readFliggyFlightBooking` 呈现已记录的预览与原订单状态。确认由已认证且有对应 Action 权限的 PA 直接调用，提交预览的 `approvalDigest` 和 `amountMinor`。建单前重新验证原标的、日期、金额及条款。供应商响应丢失后通过 `Refresh…` 按原外部订单号回查。已确认的供应商操作沿用原回执。此处支持国内机票未支付关单和通用分销无罚金退订。已出票退改签、国际机票、国际酒店分销、酒店促销及罚金退订需要单独适配各自合同。

配置部署用户拥有的绝对路径 `0600` JSON 文件。两份文件都需要 `owner`、`account`、`appKey`、`appSecret`、`enabled` 和 `expiresAt`。Gateway 与 Worker 用同一连接，为目标 owner 独立授予 `FliggyHotelDistribution` 或 `FliggyFlightJinghang` 的源权限和对应的对象、Function、Action 权限。

- `EIGOS_FLIGGY_HOTEL_CONNECTION_FILE` 另需 `distributor` 和 `hotelProfilesFile`。入住人文件为数组，每条包含 `id`、`expiresAt`、`contact: {name,phone,email?}` 和按房分组的成人姓名数组 `rooms`。用标准酒店 ID 查询合作方房型报价，再提交 `standardHotelId`、`itemId`、`ratePlanId`，配合实际入住离店日期、到店离店时间和人数创建预览。酒店支付确认需要由已核对买家入账的分销商写入 `hotelPaymentsFile`，记录 `orderId`、`outOrderId`、`receiptId`、`amountMinor`、`currency`、`receivedAt`。
- `EIGOS_FLIGGY_FLIGHT_CONNECTION_FILE` 另需 `session`、`channelName` 和 `flightProfilesFile`。乘机人文件为数组，每条包含 `id`、`expiresAt`、`contact` 和一位成人 `passenger`，两者包含 `name`、`mobile_phone_number`、`mobile_country_code`。乘机人还包含 `birthday`、`credential_type: 0` 和 `credential_no`。京杭交易方还需满足飞猪的聚石塔调用条件。

联系人、证件、建单密钥和票号留在供应商请求边界。Action 只写入业务标的、订单标识和经过核对的状态。测试走签名与 PostgreSQL Action 记录，供应商传输由隔离夹具提供，证据为 `synthetic`。正式供应商履约须独立验证。

建模依据见 [Palantir Actions](https://www.palantir.com/docs/foundry/action-types/overview)、[External Functions](https://www.palantir.com/docs/foundry/data-connection/external-functions)、[飞猪酒店验价](https://open.alitrip.com/docs/api.htm?apiId=65064)、[酒店建单](https://open.alitrip.com/docs/api.htm?apiId=65071)、[酒店支付确认](https://open.alitrip.com/docs/doc.htm?articleId=121390&docType=1&treeId=817)和[国内机票京杭](https://open.alitrip.com/docs/api_list.htm?cid=20764)。

## 一条活动出行计划

```mermaid
flowchart LR
  E[LumaEvent] --> R[EventRegistration]
  E --> T[EventTrip]
  R --> T
  P[SchedulePlan + PA CalendarAvailability] --> T
  D[DrivingEstimate + Place endpoints] --> T
  T --> A[ScheduledActivity: travel and attendance]
  T --> Q[Authorized scheduled Action]
  Q --> C[Refresh event, participation, route, calendar]
  C --> O[Original RideOrder]
  O --> V[Independent order query]
```

Agent 先取得来源对象与驾驶时长，再在 Scenario 中调用 `PlanEventTrip`。它按以下关系计算时间，并创建出行和参加活动两个占用区间：

```text
arriveAt = event.start - entryMinutes
departAt = arriveAt - drivingDuration
callAt   = departAt - waitMinutes
```

候选冲突保留在 Scenario 中供比较。PA 使用 `CommitSchedulePlan` 合并确切修订，再用 `AuthorizeEventTrip` 授权已确认报名的行程。授权包含车型、币种与估价上限、最早/最晚叫车时间、准确地点确认和对最终车费可能变化的明确接受。当前滴滴实现支持 CNY，不能把其他币种直接混算。供应商没有提供硬性最终车费上限，因此本系统不会把估价预算说成最终费用保证。

Worker 默认在原叫车时间前十分钟开始核查，最多每分钟重新检查一次，并在计算出的叫车时间执行。活动时间或路况改变时，在授权窗口内重算时间，同时复核整个计划的 PA 日历与内部资源占用。地点、账号、来源授权改变，报名未确认、活动取消/状态未知、超预算或无法按计划到达时停止执行。`readEventTrip` 返回具体执行状态与原因。

已发单或已取消的行程作为历史记录保留，其活动仍参与资源冲突校验，但旧的来源有效期不再阻塞同一计划的后续排程。候补或待审批报名可通过 `RefreshEventRegistration` 在新的只读 PA 任务中刷新原记录，无须重新报名或再次授权报名。

已在外部日历中的同一活动可以由 PA 从忙碌区间中排除，但必须返回带 `calendarEventId` 和 `identityVerified: true` 的 `exclusions`，且只能排除请求中指明的 Luma 活动。内部参加活动的 `ScheduledActivity` 仍保留其时间占用。无明确排除授权的普通日历请求拒绝排除项。

## Grok PA 续接

Luma 账号和日历凭据留在 Grok。EIGOS 通过原任务的 `pa-request` 请求以下能力：

| capability | PA 工作 |
| --- | --- |
| `luma.events.read` | 使用已连接的 Luma MCP 查询；返回原生活动 ID、准确/模糊地点、时间、活动状态和分页信息 |
| `luma.participant.register` | 仅在本次确切票种、零费用和截止时间的授权内报名；独立读取原报名结果 |
| `luma.participant.status` | 读取原报名、原参与者的最新状态；不得重新报名 |
| `calendar.freebusy` | 返回完整范围、时间区、来源版本、有效期、空闲及忙碌区间 |

Grok 使用返回的 `responseSchema` 构造回传，并调用：

```text
list_pa_requests({limit: 20, cursor?: ...})
respond_to_task({taskId, requestId, response})
```

HTTP 对应 `GET /pa/requests` 和 `POST /tasks/:id/pa-response`；已有 A2A 原任务续接继续有效。源查询和 PA 等待都恢复原任务。未来定时执行有独立的执行任务，同时记录 `sourceTaskId`、`scheduleId` 与原业务对象。PA 直接准备报名或行程时可传 `sourceTaskId`，它必须属于同一 owner；模型执行不能冒用另一个原任务。

Grok 必须持续处理这个待办入口，或由其现有常驻 PA 服务轮询。仅在聊天中连接 Luma MCP，不会自动使一个离线的聊天会话在未来醒来。无人回传时，EIGOS 保留等待状态，到授权截止时间终止；不会臆造日历或报名结果。直接批准合并与执行的 PA 入口需要 `ontology:write` scope 和对应 Action 授权；任务与待办入口使用 `tasks:read` / `tasks:write`。

PA 返回的 Luma 结果标记为 `pa_reported`，包括稳定账号引用与证据摘要。它不等于 EIGOS 直接取得的供应商回执。报名只支持本次授权的零费用参与者操作；如果 Grok 中的 MCP 不支持该操作，应回传 `unsupported`。主办方的添加宾客或审批宾客接口不能冒充参与者报名，也不能将待审批、候补或未知结果报告为已确认。

## 供应商连接

`EIGOS_SERVICE_CONNECTION_FILE` 指向运行用户拥有的 `0600` JSON 数组，按 owner 和供应商绑定。每个绑定必须唯一，且有显式截止时间。

```json
[
  {
    "owner": "VERIFIED_OWNER",
    "provider": "RollingGo",
    "bindingId": "account-specific-id",
    "active": true,
    "expiresAt": "FUTURE_ISO_TIMESTAMP",
    "credentialFile": "/absolute/private/rollinggo-key",
    "credentialSha256": "SHA256_OF_TRIMMED_FILE_CONTENT"
  }
]
```

RollingGo 凭据是原 API Key 文件。Shopify 凭据文件是 `{ "clientId": "...", "clientSecret": "..." }`，只在 Shopify 的固定端点交换短期 token；既支持字符串也支持数组形式的 scope 元数据。可选 Luma API 凭据是 API Key，只做事件/日历读取；它没有本版所需的完整参与者操作。未配置 Luma API 时自动走 PA。显式禁用、过期或有冲突的 API 配置会报错，不绕过撤权切换账号。

飞猪用同一连接数组新增一条 `provider: "Fliggy"` 绑定。运营方可显式选择 `mode: "trial"` 体验查询，保留 `owner`、`bindingId`、`active`、`expiresAt`，省略凭据字段。正式 `mode: "key"` 使用 FlyAI API Key，并设置 `credentialFile`、`credentialSha256`。连接文件由 Gateway 和 Worker 共同读取。为符合资格的 owner 授予对应的 Function、Action 和 `Eigos/source/Fliggy` 访问权限。并行查询另需授予 `SearchTravelOffers`、`searchTravelOffers`、`readTravelOfferSearch` 和结果对象权限。结果页记录访问模式，连接配置改变后旧结果需要刷新。交易 API 使用独立的 TOP 合作方连接，见「飞猪合作方机酒交易」。

滴滴原连接文件新增可选 `ordersEnabled`，默认 `false`。启用连接器不等于用户授权；具体行程仍必须通过 `AuthorizeEventTrip`。查询连接器与订单连接器分开，订单 trace ID 由服务端在发单前新估价取得，不接受模型或 PA 提供的 trace ID。账号/凭据授权摘要改变后旧行程不能继续发单。

## 持久化、权限和恢复

`scheduled_actions` 保存时间、截止期、Action 契约、原任务关系和执行任务；未来尚未启动的计划不锁住旧发布。到时按当前发布检查同一 Action 契约和权限后创建执行任务。PA 续接和周期性检查沿用这个任务，Worker 重启后从 PostgreSQL 恢复。已开始的任务沿用已有发布规则。

`external_operations` 在真正发单前保存原操作标记。供应商成功但后续业务提交失败时保留回执，可回查原订单；网络结果不明或进程在发单后退出时标记未知，禁止自动重新创建。没有假设滴滴支持调用者提供的幂等键，也不宣称分布式 exactly-once。`CancelEventTrip` 停止后续执行，返回记录仍能显示已发出或未知的外部操作。

主线的 `action_effects` 继续负责已声明副作用的投递。`external_operations` 是供应商原操作的去重与回执记录，不是第二个执行队列；恢复回执会重新验证原数据权限，状态读取不直接暴露私有回执。定时业务仍进入同一套 Tasks/Worker。

升级仍在原 PostgreSQL schema 执行 `db:upgrade`。常驻角色新增以下表权限，定义/授权表继续只读：

| 表 | 权限 |
| --- | --- |
| `scheduled_actions`、`external_operations` | SELECT、INSERT、UPDATE |
| `tasks`、`source_calls`、`pa_requests` | 沿用 SELECT、INSERT、UPDATE |

对象和关系编辑依旧经过 Action。PA 待办和任务结果在读取时重新检查数据权限，不能通过待办绕过来源或对象撤权。真实业务开通、发布和验收分别进行；工程测试不会开启生产下单或付款。

## 当前验证与限度

回归覆盖源对象入库、Interface 映射、原 PA 续接、Scenario 合并、最新报名状态、日历冲突、账号变更、授权撤回、超预算、截止时间、重启恢复、重复竞争和丢失订单响应。测试参与者与订单均为 synthetic。

2026-11-13 的只读现场检查确认：滴滴 MCP 暴露驾驶路线、创建订单、原订单查询等工具，驾驶路线读取成功；Shopify 当前 Global Catalog 暴露三个读取工具；RollingGo 当前 API Key 暴露四个酒店读取工具。Shopify 和 RollingGo 均通过本版 Action → 来源投影 → Interface 结果读取，在隔离 PostgreSQL 中取得 `live_readonly` 结果，没有真实报名、下单或付款。

真实 Grok Luma 账户的参与者操作，以及真实叫车后的接驾、到达和最终履约仍须独立验收。查询响应、工具目录、合成订单或绿色 CI 都不代替这项验收。
