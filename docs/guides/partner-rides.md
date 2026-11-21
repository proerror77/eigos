# Uber 和 Grab 估价

EIGOS 发布 `estimateUberRide` 和 `estimateGrabRide` 两个只读 Function。调用由原 PA 发起的任务进入 Worker。Function 使用现有 `PARequests` 将已确认的 WGS84 起终点交给同一个 PA，收到原任务的回应后校验请求摘要、连接绑定、报价时间和 App 跳转地址。依据 [Palantir Functions](https://www.palantir.com/docs/foundry/functions/overview)。报价的证据为 `pa_reported`，表示原 PA 回传，供应商联调需要独立验收。

## 接通条件

1. 取得供应商伙伴准入。Uber 使用 [3P Demand 估价](https://developer.uber.com/docs/third-party-rides-demand-v1/rides-endpoints/uber-endpoints/get-estimates-for-intent)，由 PA 接入已获准的 OAuth 账户流程，提供对应的 `riderId`。Grab 使用 [Farefeed](https://developer.grab.com/docs/partner-farefeed/) 的伙伴报价权限。
2. 通过现有发布流程发布包含这两个 Function 的 Ontology。Gateway 和 Worker 使用 `EIGOS_PARTNER_RIDE_CONNECTION_FILE` 指向私有绝对路径。该 JSON 文件是配置数组，每项仅包含 `owner`、`provider`（`Uber` 或 `Grab`）、`environment`（`production` 或 `sandbox`）、`bindingId`（UUID）、`active` 和 `expiresAt`（ISO UTC）。每个 owner 和供应商最多配置一条连接。缺少配置、未启用或过期时估价不可用。重新绑定账户时更换 `bindingId`。
3. 在原 PA 中使用 SDK 的 `PartnerRidesPA`。它用 PA 自己的 EIGOS 客户端读回原任务。PA 在自己信任的账户存储中按供应商、环境和连接 ID 加载已授权的短期令牌。收到 `ride.uber.estimate` 或 `ride.grab.estimate` 时，调用 `answer(taskId)`。只有估价结果和校验字段回传 EIGOS。OAuth 签发、续期及用户同意流程由 PA 和供应商集成负责。

## 结果

两家都返回车型、可用的 ETA 和对应的 App 跳转。Uber 的金额保留供应商原始单位标记，Grab 的 ETA 统一转换成秒。PA 明示供应商、环境和来源时间。用户在 App 内确认。结果固定为 `orderCreated: false` 和 `paymentInitiated: false`。伙伴报价权限只覆盖读取，叫车、取消和支付需要各自的授权和供应商接口。

开发验收使用合成供应商响应与临时 PostgreSQL。正式联调应使用已授权连接实际读取报价，然后由用户确认 App 展示的路线和车型。
