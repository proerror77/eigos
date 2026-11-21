# Uber 和 Grab 估价

EIGOS 发布 `estimateUberRide` 和 `estimateGrabRide` 两个只读 Function。调用由原 PA 发起的任务进入 Worker。Function 使用现有 `PARequests` 将已确认的 WGS84 起终点交给同一个 PA，收到原任务的回应后校验请求摘要、连接绑定、报价时间和 App 跳转地址。依据 [Palantir Functions](https://www.palantir.com/docs/foundry/functions/overview)。报价的证据为 `pa_reported`，表示原 PA 回传，供应商联调需要独立验收。

## 接通条件

1. 取得供应商伙伴准入。Uber 使用 [3P Demand 估价](https://developer.uber.com/docs/third-party-rides-demand-v1/rides-endpoints/uber-endpoints/get-estimates-for-intent)，由 PA 接入已获准的 OAuth 账户流程，提供对应的 `riderId`。Grab 使用 [Farefeed](https://developer.grab.com/docs/partner-farefeed/) 的伙伴报价权限。
2. 通过现有发布流程发布包含这两个 Function 的 Ontology。Gateway 和 Worker 使用 `EIGOS_PARTNER_RIDE_CONNECTION_FILE` 指向私有绝对路径。该 JSON 文件是配置数组，每项仅包含 `owner`、`provider`（`Uber` 或 `Grab`）、`environment`（`production` 或 `sandbox`）、`bindingId`（UUID）、`active` 和 `expiresAt`（ISO UTC）。每个 owner 和供应商最多配置一条连接。缺少配置、未启用或过期时估价不可用。重新绑定账户时更换 `bindingId`。
3. 在原 PA 中使用 SDK 的 `PartnerRidesPA`。它用 PA 自己的 EIGOS 客户端读回原任务。PA 在自己信任的账户存储中按供应商、环境和连接 ID 加载已授权的短期令牌。收到 `ride.uber.estimate` 或 `ride.grab.estimate` 时，调用 `answer(taskId)`。只有估价结果和校验字段回传 EIGOS。OAuth 签发、续期及用户同意流程由 PA 和供应商集成负责。

## 结果

两家都返回车型、可用的 ETA 和对应的 App 跳转。Uber 的金额保留供应商原始单位标记，Grab 的 ETA 统一转换成秒。PA 明示供应商、环境和来源时间。用户在 App 内确认。结果固定为 `orderCreated: false` 和 `paymentInitiated: false`。伙伴报价权限只覆盖读取，叫车、取消和支付需要各自的授权和供应商接口。

开发验收使用合成供应商响应与临时 PostgreSQL。正式联调应使用已授权连接实际读取报价，然后由用户确认 App 展示的路线和车型。

## Ontology 对象和 Action

| 链路 | Action 与关系 |
|---|---|
| 原任务询价 | `PreparePartnerRideQuote` 复用对应供应商的估价 Function。通过 `complete_with_action` 调用 `PartnerRideQuoting.estimate`，实现类型为 `PartnerRideQuote`，将结果绑定到 `readPartnerRideQuote` 的 `quote` 参数，PA 可以在原任务回传结果。 |
| App 交接 | `PartnerRideQuoting.handoff` 映射到 `PreparePartnerRideHandoff`，接受原报价引用和车型 ID。通过 `PartnerRideQuoteHandoff` 保留报价与交接记录的关系，使用 `readPartnerRideHandoff` 查看尚未到期的跳转链接。 |
| 合成叫车 | `CreateSyntheticPartnerRideQuote` 接受显式试验 ID、供应商和路线。 `BookSyntheticPartnerRide` 要求确认原价与币种，通过 `SyntheticPartnerRideQuoteOrder` 关联原报价。 |
| 合成取消 | `CancelableRideOrder.cancel` 在合成订单上映射到 `CancelSyntheticPartnerRide`。取消更新原订单，已记录的付款继续保留。 |
| 合成付款 | `PaySyntheticPartnerRide` 要求确认原价与币种，通过 `SyntheticPartnerRideOrderPayment` 关联原订单。每个原订单最多保留一条付款记录。 |

以上三个合成操作只在启用 EIGOS 本地开发模式的运行时可用，结果携带 `evidence: synthetic`。合成订单没有供应商订单编号，`orderId` 使用本地对象标识，`independentRead` 为 false。真实叫车、取消和结算需接入对应供应商的正式执行权限，并单独验收。Uber 的 3P Demand 伙伴 API 提供订单生命周期，Uber Rides MCP 当前公开说明将预订、取消与付款方式列为后续能力。Grab Farefeed 提供合作伙伴估价。参考 [Uber 3P Demand](https://developer.uber.com/docs/third-party-rides-demand-u4b-v1/introduction)、[Uber Rides MCP](https://developer.uber.com/docs/third-party-rides-demand-mcp/introduction)、[Grab Farefeed](https://developer.grab.com/docs/partner-farefeed/)。

## Machinery 与 Automate 验收

合成报价、订单和付款分别有自己的 ProcessLog。沿各对象的 `stateLogs` 读取已提交的转换、触发 Action 和记录时间。Machinery 通过 `quote.order` 和 `order.payment` 展示相关子过程。取消不会把付款转为退款。

在启用开发模式的 EIGOS 上，用同一个有权限的调用者通过现有 `save_rule` 保存 [syntheticPartnerRideRules](../../packages/ontology/partner-ride-lifecycle.ts) 中的两条规则，再创建合成报价。规则以发布的 ProcessLog 为触发条件，无需额外的 scheduler 或 Workflow：

- 报价进入 `available` 后等待五分钟。`ExpireSyntheticPartnerRideQuote` 再检查原报价的截止时间，然后记录 `expired`。
- 订单出现已提交的状态转换后，`ObserveSyntheticPartnerRide` 回读原合成订单，并将最新观察写入 `latestObservation`，供 PA 按原订单引用读取。PA 自行选择通知渠道。

开发规则不发送外部通知，也不执行下单、取消或扣款。真实供应商的原单回查和通知交付需要独立的授权与验收。参见 [Machinery 核心概念](https://www.palantir.com/docs/foundry/machinery/core-concepts) 和 [Automate 对象集条件](https://www.palantir.com/docs/foundry/automate/condition-objects)。
