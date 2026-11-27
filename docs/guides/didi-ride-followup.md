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

用户明确要求现在叫车时，Agent 使用 `ImmediateRideBooking.book`（`BookDidiImmediateRide`），按原任务补全城市、上车点和目的地。PA 在原任务的 `ride.confirm_immediate_order` 请求中展示已解析的起终点、可确认的车型、人民币预估价和有效期。价格区间或无法核对的报价不进入可发单清单。

只有用户明确选择车型并确认对应预估价后，原 PA 才通过 `respond_to_task` 回传该请求的 `quoteDigest`、`category`、`amountMinor`、`currency` 和 `acceptVariableFinalFare: true`。实际车费可能随行程变化。用户也可以通过 `decision: cancel` 拒绝报价。

Action 发单前按原起终点和所选车型向滴滴重新估价。价格变化或报价过期时结束本次确认，重新报价后才能发单。每个原任务最多发出一次下单操作。回包丢失时保留 `unknown`，先核对滴滴原单。收到订单号但暂时无法独立回查时保留 `submitted`，已回查原单才报告 `ordered`。结果附原单引用，可用既有的跟单和取消 Action。发单仍检查滴滴绑定和 `ordersEnabled`。

从 `DidiImmediateRide` 可以沿 `route`、`order` 和 `approval` 回查路线、原单和 PA 输入审批。Machinery 可从即时叫车日志下钻到审批和原单，再沿 `watches` 查看跟单过程。

### 原单核对

通过 `DidiImmediateRide.state` 分别查看供应商已受理待核验的 `submitted`、结果未知的 `unknown` 和已独立回查的 `ordered`。原 Task 的终态记录执行任务的结果。司机到达与行程完成继续看 `DidiRideOrder.watches`。已接受补参或观察回复时，`ActionConfirmation` 的 `confirmed` 记录本轮输入已接收。确认叫车使用独立的 `authorization` 请求，批准摘要和有效期显示在 `approvedQuote`。

`ReconcileDidiImmediateRide` 接受原叫车对象 `{ ride }` 或原任务 `{ originalTaskId }`。平台连接在实际派发前登记有截止时间的回查排程。Worker 读已保存的原回执，按其订单号回查并更新同一对象及其 Machinery 历史。后续回查沿用原任务关联和当前权限。暂时缺少可关联的订单号时，操作保持未知。

个人 PA 可通过同一 Action 核对原任务，使用 `DidiPA.answer` 响应 `didi.reconcile_order`。SDK 读取同一私有目录保存的原回执，或使用原 PA 已经传回的受理凭据，再按确切编号查询。缺少受理凭据时，请在原滴滴账号人工核实。PA 核对只需要原连接上的订单查询权限。

该 Action 复用原 Task、PA 请求、来源读回和外部操作回执。即时叫车使用现有 Action 和回查排程。[Palantir Function-backed Actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview) · [Interface Action 约束](https://www.palantir.com/docs/foundry/interfaces/interface-action-type-constraints) · [滴滴 MCP](https://mcp.didichuxing.com/api)

## 取消已发订单

`CancelableRideOrder.cancel` 映射到 `CancelDidiRideOrder`。PA 在用户确认确切订单后提交 Action，传入原 `DidiRideOrder` 引用、`confirmCancellation: true`，可选取消原因。Action 沿 `TripOrder` 核对订单、所属用户和原滴滴绑定。连接的 `cancellationsEnabled` 可以单独开放取消，省略时沿用 `ordersEnabled`。滴滴根据当时的订单状态决定能否取消。

EIGOS 先保存原单取消尝试，再调用 `taxi_cancel_order`。收到明确成功回执后独立回查原单，并用 `readDidiRideOrder` 读回结果。响应丢失时，同一 Action 回查原单，只在滴滴明确报告取消后确认。重复请求沿用原取消尝试。已确认取消的订单会结束跟单并撤回接驾提醒。待发车计划使用 `CancelEventTrip` 停止。

依据 [Palantir Function-backed Actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview) 和 [Interface](https://www.palantir.com/docs/foundry/interfaces/interface-overview)，取消入口沿用已有 Action 授权、对象检查和外部操作日志。验证使用合成订单及滴滴 MCP 的调试环境。

## 进入和退出

- `StartDidiRideWatch` 只接受同一 owner 已有且有已验证供应商绑定的 `DidiRideOrder`。调用者授权一分钟至四小时的观察期限，选择是否向已配置且同 owner 的 PA 递送到车提醒。创建订单权限仍由原出行 Action 处理。
- Worker 按现有 `ScheduledActions` 运行 `CheckDidiRideWatch`，并写入到期或失败的正式状态与日志，绑定原账户、订单与同一有界排程。每一步在同一个 Action 事务更新状态并写入下一次时间。使用来源回执摘要，拒绝把别的订单、账号或无结构的状态当作本订单到车。
- `readDidiRideWatch` 读回当前进度与可用提醒，`readDidiDriverPosition` 按需读取司机位置。`StopDidiRideWatch` 停止观察，已发出的供应商订单保持原状态。
- [Machinery](https://www.palantir.com/docs/foundry/machinery/core-concepts/) 沿 `stateLogs` 观察可枚举状态的已提交转换。现有可选通知队列按观察版本发送和撤回，发送前重新复核原对象、归属和许可。Webhook 接收确认表示通知进入 PA 通道，用户端已读需要独立证据。

开发测试使用合成订单、文档状态和替代的通知接收方。真实订单和用户端通知需要独立验收。

## 原 PA 的滴滴连接

受邀账号用原对话提交询价。PA 可通过通用 Action 选择发布的 RideInquiry.estimate 与 readRideEstimates，随后用同一个任务 ID 轮询。需要来源数据时，Worker 返回 didi.read 请求，包含明确的只读方法、参数、参数摘要及响应结构。

原 PA 用自己的授权向滴滴官方 MCP 发起该次读取。PA 在原会话调用 respond_to_task，回传请求 ID、标准化数据和本次调用的来源回执。如果没有授权就回传 authorization_required，完成供应商配置后再重新询价。滴滴 Key 和发单所需的原始 traceId 留在 PA。PA 可以使用本机只读辅助命令构建回执。先运行 npm run build，再设置 EIGOS_PA_DIDI_KEY_FILE 指向只在 PA 可读的密钥文件，运行 node scripts/didi-pa-observe.mjs TOOL ARGUMENTS_JSON INPUT_DIGEST。命令使用 PA 官方连接，只输出 EIGOS 要求的安全响应。 [滴滴 MCP API](https://mcp.didichuxing.com/api)

Worker 校验调用者、原任务、方法、输入摘要、结果摘要、类型和时间窗口，复用地点解析、报价 Action 和 SourceReceipt 投影。结果标为 pa_reported，完整 PA 回执留在原任务的 PA 请求记录。直接由 EIGOS 验证的 live_readonly 报价仍保留原有 accepted 标志。 [Function 支持的 Action](https://www.palantir.com/docs/foundry/action-types/function-actions-overview)

部署时使用 `EIGOS_SIGNUP=invite`。Gateway 和 Worker 设置 `EIGOS_DIDI_PA_READS_ENABLED=true`，再用管理角色运行 `npm run account -- grant-didi-pa` 开通受邀账号的询价权限。跨任务跟单仍依赖已验证的 EIGOS 原单和同 owner 的供应商绑定。

### 受邀用户用自己的滴滴连接叫车

1. 用户明确要求即时叫车时，原 PA 调用 `ImmediateRideBooking.book` 或 `bookWithEndpoints`。任务先发出 `didi.authorize` 请求。PA 已接通个人滴滴 MCP 时，确认所需工具并回传该连接的随机引用。缺连接时，PA 展示请求中的[滴滴官方申请入口](https://mcp.didichuxing.com/)，保留原请求。用户在滴滴开通 Key 并存在 PA 私有配置里，回到原对话后由 PA 通过 `respond_to_task` 继续。
2. 同一个连接用于解析地址和询价。PA 展示起终点、车型、价格和有效期，用户确认一项后才应答 `ride.confirm_immediate_order`。
3. Worker 记录唯一发单请求后发出 `didi.place_order`。PA 执行器重查原任务，以同一连接验价并使用新报价的 traceId。若车型和价格仍匹配，才从 PA 调用滴滴发单。PA 在私有目录持久化派发与回执。无法确定是否发单时保留未知状态，避免重复叫车。
4. PA 通过同一个 `respond_to_task` 返回下单回执和单独查询到的原订单状态。EIGOS 将准确订单号、状态和证据 `pa_reported` 写入原任务和本体。收到确认号但是原单读回未完成时，结果显示 `submitted`。

生产开通需要 Gateway 和 Worker 同时设置 `EIGOS_DIDI_PA_ORDERS_ENABLED=true`。对单个已开通账号运行 `npm run account -- grant-didi-pa-orders <owner|email>`，为其安装滴滴交易授权。原 PA 使用该用户自己的滴滴连接和发单权限。已有全组授权命令适用于获准的整个测试批次。原任务之外的主动跟单、取消和付款使用各自的授权。

PA 主机可以接入 `DidiPA` SDK，复用发起任务时的 EIGOS 客户端。对支持 HTTP 的 PA，构建后可运行 `node dist/scripts/didi-pa.js <taskId>`。用 PA 主机的私有配置提供 `EIGOS_PA_URL`、原 EIGOS 客户端的 `EIGOS_PA_TOKEN`、个人滴滴 Key 文件路径 `EIGOS_PA_DIDI_KEY_FILE`、稳定私有目录 `EIGOS_PA_DIDI_DIRECTORY` 和 64 位十六进制本地连接标识 `EIGOS_PA_DIDI_CONNECTION`。原 PA 自己处理用户确认。只对收到用户确认后生成的 `didi.place_order` 请求使用 `--dispatch-approved-order`。同一 PA 安装应使用同一个目录保存派发记录。
