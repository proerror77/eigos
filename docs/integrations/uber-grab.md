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

## 目录与运行接线

SQLite `createExecutionCatalog` 和 PostgreSQL `PostgresReadProgramRegistry` 均提供两家默认禁用的目录元数据；所属用户及其现有目录权限仍然适用。未配置时没有执行动作，也不为新能力生成来源／数据／角色授权。MCP 与 A2A 使用各自 Gateway 入口背后的同一目录和任务服务。

显式部署配置只接受元数据，不接受供应商 Key：

- `EIGOS_UBER_RIDES_ENABLED`／`EIGOS_GRAB_RIDES_ENABLED` 默认 `false`。
- 对应 `EIGOS_<PROVIDER>_RIDES_CONNECTION_FILE` 是私有绝对路径，内容符合 `rideConnectionSchema`：provider、environment、bindingId、connectionId、revision、owner、active/revoked 状态和 expiresAt。
- 对应 `EIGOS_<PROVIDER>_RIDES_RELAY_AGENT_ID` 是已登记 PA 来源节点。还需要现有 primary authority、task Relay 和 `EIGOS_PERSONAL_SOURCE_OWNER`。绑定变化、过期或撤销会拒绝继续执行。
- Worker 仅通过 `RideRelayConnector` 读取；SQLite 接收验收再次读取真实 `security_relay_reads` 行。PG 经过 registry → 原始 dispatch → action observation → 同事务独立 Relay 回执核验 → 共享 GraphProgram 投影。quote 输入还必须等于原始已封存的 action query，不能借相同 scope 引用替换路线。

来源节点入口为构建后的 `apps/ride-source-agent/main.js`，由 `EIGOS_RIDE_SOURCE_AGENT_FILE` 指向私有配置。配置扩展 `rideServiceConfigSchema`，另含现有 relayUrl、credentialPath、statePath、connectionFile、tokenFile 和默认关闭的 enabled／partnerApproved。入口要求已经登记的 Relay 凭据，不负责开通伙伴、建立账户授权或刷新官方令牌。tokenFile 的 `rideTokenSchema` 包含 PA 已完成 OAuth 后的原始身份映射；Uber riderId 必须来源于正式获准的账户绑定，不能从 Worker 输入复制。令牌过期须由 PA 的既有授权流程刷新，不能换用平台共享密钥。Grab Farefeed 的伙伴应用令牌也不代表乘客已授权钱包或下单。

来源账本仅在明确证明「供应商调用前的授权暂时不可用，且调用栈已退出」时解除 processing；此时同 callId 可在授权恢复后重试。任何已越过调用边界的崩溃、取消或未知结果继续保留不可重放屏障。

## 显式 v30 升级

默认内核仍为 v28，语义检索为原有显式 v29。`createRideSourcesKernelDefinition` 和 `StagedKernelBuilder('30')` 是新增的软件支持，不会激活数据库。静态安全清单审查最大支持版本 v30，不代表部署或权限已升级。

SQLite `upgradeRideSources` 只接受精确 v28／v29 前驱、预期 active release／generation、policy digest／revision，并在同一 business transaction 内发布、建立 lineage、激活和更新策略。默认 dry-run。活动 manager／claim 或未清理 fence 会阻止应用。原有 namespace role 只保留已存在且定义未变的动作／函数，绝不新增供应商执行权限、延长有效期或改变来源授权。启动仅识别已一致安装的 v30 本体与策略，不自动迁移。

PostgreSQL `upgradePostgresRideSources` 使用现有序列化 business transaction、实际 schema owner、停止状态和精确前驱校验，在同一事务更新不可变 release、namespace CAS 和 policy CAS，并写不可变 operation receipt。无 DDL、无 GRANT、无启动调用。若 COMMIT 结果未知，现有事务器会丢弃连接；应使用新 client 调用只读 `readPostgresRideUpgrade` 比对真实 receipt、active release 和 policy，返回 applied／not_applied／inconsistent，不能盲目重试。

SQLite 原子升级及故障回滚、同步／异步 GraphProgram 语义使用合成夹具验证。异步包装 SQLite 不是 PostgreSQL 引擎测试；实际 PG 驱动、权限、故障提交和 Relay 网络的验证须分别记录终态，不能因类型检查成功而宣称已通过。
