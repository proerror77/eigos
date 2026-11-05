# Uber／Grab 只读估价与 PA 来源

只读估价和用户 App 交接不能代表叫车、付款或履约完成。所有新来源默认关闭，不在启动时创建账号、凭据、许可或数据库升级。本地合成数据测试不是伙伴审批或真实联调证据。

## 官方范围

- Uber 使用 [3P Demand GetEstimatesForIntent](https://developer.uber.com/docs/third-party-rides-demand-v1/rides-endpoints/uber-endpoints/get-estimates-for-intent) 的即时、已绑定用户报价子集。服务需要伙伴准入和相应用户账户绑定。返回官方 universal link，让用户在自己的账户确认。
- Grab 使用 [Farefeed](https://developer.grab.com/docs/partner-farefeed/) 的估价、ETA、车型及返回的 deepLink／directDeepLink。伙伴应用 OAuth `ride.estimate` 不等于乘客钱包授权。当前没有实现或声称公开普通乘客下单、取消 API。

输入必须明确使用 WGS84 经纬度，起终点不同。地址字符串不能替代坐标；本模块不自动把 GCJ02 当作 WGS84。Uber `eta_in_seconds` 为秒；Grab ETA 为分钟。Uber Fare 金额和过期时间保留原始字段语义，不把另一个 CurrencyAmount 类型的 E5 约定推导到 Fare。Grab 价格区间是估计值，不是费用上限保证。缺失、空报价及异常链接都不可作为成功估价。

## 来源与授权边界

`PaRideConnector` 仅在用户 PA／来源节点运行，加载令牌、解析 Uber riderId，并核对 owner、provider、environment、connectionId、revision、有效期和 riderId。Worker 不调用令牌加载器。开关和伙伴批准声明均为显式配置前提，并不证明真实准入或连通。

Relay 延续 `eigos.source-read/1`，以明确 `provider: uber | grab` 的严格判别结构扩展；旧 DiDi 消息 schema 保持严格且不接受新请求。新 source 绑定 provider、environment、binding、connection、revision、connectionDigest、evidenceKind；完整绑定摘要包含 owner。主实例重新计算已获原任务授权的配置摘要，并核对原模型计划、request revision、intent、attempt、modelRun、action/input digest、peer、connection、authority、当前来源和 Pipeline。仅通过普通 PA 消息或知道请求哈希，不能获得来源权限。

`RideRelayService` 使用已登记 Relay 身份和 DPoP 向原主实例检查当前授权。它与 DiDi 共用来源持久账本及授权／交付程序。调用前写 processing，保存结果后再检查授权，交付前再次检查。崩溃留下 processing 时返回 READ_OUTCOME_UNKNOWN；不重放供应商请求。已完成回执重启后保持原内容，授权不可用时留在私有账本，撤权后不释放缓存事实。

令牌和授权正文不进入模型、任务对象或诊断。来源错误只返回安全分类。HTTP 只访问固定官方估价地址，拒绝重定向；无 SDK 自动重试。报价链接不会自动打开，也不强制预算，始终标明 user_action_required、orderCreated=false、paymentInitiated=false。

## 验证范围

`ride-connector.test.ts` 验证合成 wire 数据、默认禁用、令牌归属、空报价、错误、取消／超时、响应上限和恶意链接。`ride-relay-source.test.ts` 验证来源端持久恢复、不可重放和迟到授权；该测试用内存传输和合成 DPoP 授权响应，不是实际 Relay 网络／加密端到端证明。独立 Relay 套件继续验证原网络边界；无法监听时须报告环境阻塞。

服务端下单、付款、取消、正式账户 OAuth 签发与真实伙伴联调均不在这份只读协议的已完成范围。目录、共享任务和 SQLite／PostgreSQL 执行接线应以对应代码和新提交的完整验证为准，不能从适配器或来源 schema 的存在推定已连通。
