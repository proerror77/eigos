# 滴滴原订单追踪与接驾提醒

依据滴滴的 [MCP 开发者文档](https://mcp.didichuxing.com/api)。已用生产绑定只读获取工具目录，确认订单侧包含估价、发单、取消、原单状态、司机坐标和 App 跳转链接，地图侧包含地点、周边、逆地理编码和四种路线。目录没有到车推送、支付、账单或退款查询。工具目录证明工具可发现，真实订单权限和履约仍需独立验收。

| 乘客需要知道什么 | EIGOS 依据与行为 |
| --- | --- |
| 叫车发出后是否有人接 | 按原订单号查状态。匹配和接单阶段每 30 秒查一次；读回车型、车牌和供应商 ETA。 |
| 车现在在哪 | 用户需要时按原订单号查一次司机坐标，保留供应商坐标系未声明的事实。不在状态轮询里采集位置。 |
| 什么时候上车 | 原订单返回正式到车状态时创建一次接驾提醒。提醒随下一状态撤回，超出有效期的提醒不再发送。 |
| 是否上车、什么时候到 | 到车和行程中每 60 秒读一次，显示供应商提供的 ETA 和距离，来源太久未更新时隐藏数值。 |
| 行程是否结束 | 完程时停止追踪。未识别的终止码保留原值并停止，不能作为成功、取消或退款证明。 |
| 订单状态暂时读不到 | 保留最新已知进度，按 60、120 秒退避。第三次失败或超出期限时终止，注明来源不可用。 |
| 最终费用、支付、退款和发票 | 行程完成只验证运输状态，结算继续标为未核验。这些后续服务需要独立、可授权的账单来源。 |

## 即时叫车

用户明确要求现在叫车时，Agent 使用 `ImmediateRideBooking.bookWithEndpoints`（`BookDidiRideWithEndpoints`）。旧客户端可继续调用 `ImmediateRideBooking.book`。只查车费时使用 `RideInquiryWithPlaceClues.estimateWithEndpoints`，再用 `readInteractiveRideEstimate` 读回结果。

「从家出发」或「回家」分别传 `originPersonalPlace` 或 `destinationPersonalPlace`，每个参数包括 `PersonalPlace` 引用与用户确认的 `revision`。使用手机当前位置作上车点时，省略上车点，沿用原 PA 的 `location.resolve`。滴滴地点返回多个匹配时，由用户在原任务确认。使用常用地点的路线及叫车记录沿用[机密数据权限](model-egress.md)。

PA 在原任务的 `ride.confirm_immediate_order` 请求中展示已解析的起终点、可确认的车型、人民币预估价和有效期。价格区间或无法核对的报价不进入可发单清单。

只有用户明确选择车型并确认对应预估价后，原 PA 才通过 `respond_to_task` 回传该请求的 `quoteDigest`、`category`、`amountMinor`、`currency` 和 `acceptVariableFinalFare: true`。实际车费可能随行程变化。用户也可以通过 `decision: cancel` 拒绝报价。

Action 发单前复核起终点及常用地点版本，并按原起终点和所选车型向滴滴重新估价。常用地点地址更新后，需要按新版本重新确认。价格变化或报价过期时结束本次确认，重新报价后才能发单。每个原任务最多发出一次下单操作。回包丢失时保留 `unknown`，先核对滴滴原单。收到订单号但暂时无法独立回查时保留 `submitted`，已回查原单才报告 `ordered`。结果附原单引用，可用既有的跟单和取消 Action。发单仍检查滴滴绑定和 `ordersEnabled`。

原单通过 `immediateRides` 关联 `DidiImmediateRide`。新版叫车记录的 `route` Link 指向实际路线，路线指向滴滴的起终点 POI 和实际使用的不可变 `PersonalPlaceVersion`。搬家后，历史路线仍指向原版本。由常用地点解析的滴滴 POI 保留机密分级以及独立的对象身份。使用手机定位的路线保留坐标系转换证据。该 Action 复用原 Task、PA 请求、来源读回和外部操作回执。即时叫车不需要创建定时行程。[Palantir Function-backed Actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview) · [Interface Action 约束](https://www.palantir.com/docs/foundry/interfaces/interface-action-type-constraints) · [滴滴 MCP](https://mcp.didichuxing.com/api)

## 取消已发订单

`CancelableRideOrder.cancel` 映射到 `CancelDidiRideOrder`。PA 在用户确认确切订单后提交 Action，传入原 `DidiRideOrder` 引用、`confirmCancellation: true`，可选取消原因。Action 沿 `TripOrder` 核对订单、所属用户和原滴滴绑定。连接的 `cancellationsEnabled` 可以单独开放取消，省略时沿用 `ordersEnabled`。滴滴根据当时的订单状态决定能否取消。

EIGOS 先保存原单取消尝试，再调用 `taxi_cancel_order`。收到明确成功回执后独立回查原单，并用 `readDidiRideOrder` 读回结果。响应丢失时，同一 Action 回查原单，只在滴滴明确报告取消后确认。重复请求沿用原取消尝试。已确认取消的订单会结束跟单并撤回接驾提醒。待发车计划使用 `CancelEventTrip` 停止。

依据 [Palantir Function-backed Actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview) 和 [Interface](https://www.palantir.com/docs/foundry/interfaces/interface-overview)，取消入口沿用已有 Action 授权、对象检查和外部操作日志。验证使用合成订单及滴滴 MCP 的调试环境。

## 进入和退出

- `StartDidiRideWatch` 只接受用户已有的、可沿 Link 回查原 `EventTrip` 的 `DidiRideOrder`。调用者授权一分钟至四小时的观察期限，选择是否向已配置且同 owner 的 PA 递送到车提醒。创建订单权限仍由原出行 Action 处理。
- Worker 按现有 `ScheduledActions` 运行 `CheckDidiRideWatch`，绑定原账户、订单与同一有界排程。每一步在同一个 Action 事务更新状态并写入下一次时间。使用来源回执摘要，拒绝把别的订单、账号或无结构的状态当作本订单到车。
- `readDidiRideWatch` 读回当前进度与可用提醒，`readDidiDriverPosition` 按需读取司机位置。`StopDidiRideWatch` 停止观察，已发出的供应商订单保持原状态。
- [Machinery](https://www.palantir.com/docs/foundry/machinery/core-concepts/) 沿 `stateLogs` 观察可枚举状态的已提交转换。现有可选通知队列按观察版本发送和撤回，发送前重新复核原对象、归属和许可。Webhook 接收确认表示通知进入 PA 通道，用户端已读需要独立证据。

开发测试使用合成订单、文档状态和替代的通知接收方。生产下单开关保持关闭。本能力未通过真实订单或用户端通知的验收。

## 原 PA 的滴滴连接

受邀账号可以通过通用 `apply_ontology_action` 或 `complete_with_action` 发起已授权的滴滴 Action。调用先返回任务 ID。Worker 发现缺少授权时在同一任务返回 `didi.authorize`，包含请求 ID 和响应结构。原 PA 引导用户在[滴滴开发者控制台](https://mcp.didichuxing.com/)开通官方 MCP，将 Key 保存在 PA 的私有凭据存储。滴滴 MCP 的交易可用性取决于 Key 的供应商权限。 [滴滴 MCP API](https://mcp.didichuxing.com/api)

PA 主机将 `createDidiPARelay` 挂到固定的 HTTPS 入口。经过 EIGOS 身份验证的原 PA 为这次请求登记一个随机 UUID，把它绑定到已验证的 owner、任务 ID、PA 请求 ID、PA 用户批准的访问范围和过期时间。登记的最大期限为 30 分钟。PA 通过 `respond_to_task` 回传 `{status:"authorized",connectionRef,expiresAt,access:"read"}` 或 `{status:"unavailable"}`。支持叫车的连接经用户批准后可以回传 `access:"ride"`。OAuth 凭据和滴滴 Key 留在原 PA，业务任务只保存绑定引用。中转逐次验证身份、任务、请求和有效期，再把限定的 MCP 操作送到滴滴。

Gateway 和 Worker 设置 `EIGOS_DIDI_PA_RELAY_URL` 与 `EIGOS_DIDI_PA_RELAY_TOKEN_FILE`。文件保存 EIGOS 与受信任 PA 主机之间的中转凭据，至少 32 字符，权限为 `0600`。用管理角色运行 `npm run account -- grant-didi-pa` 明确加入询价与即时叫车的试点授权。未启用 `EIGOS_DIDI_PA_ORDERS_ENABLED=true` 时，中转接入只用于真实查询。开启实际叫车还需要 PA 的 `ride` 连接权限和用户在同一任务内对确切车型、起终点和报价的单独确认。订单发送后沿用现有原单回查和防重复发单机制。

验收先检查新账号提交 Action 后出现授权请求，再用原 PA 的短期引用在同一任务读到真实报价。叫车流程使用合成供应商验证第二次批准、单次发送和原单回查。
