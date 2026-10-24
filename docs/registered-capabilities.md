# Ontology + LLM 后端

全部对象、动作、计算及接入状态见[模型与接入能力总览](ontology-and-integrations.md)。工作分支定义与本人常驻运行版本分别核对，不能用本文的源码版本代替运行回读。

2026-10-23 增加 `booking.participant.free@1`：免费活动报名／通用预约模型、可选付款、审核与候补跟踪、独立确认回读。当前真实来源为本机 Luma 参与者浏览器桥接，需要在线操作代理；其配置和证据以[免费报名说明](free-booking-participant-2026-10-23.md)为准。旧预约沙箱升级为 `booking.pa-payment.sandbox@3`，明确免费的预约不再要求付款。下列较早日期的沙箱记录保留其当时边界。

更新于 2026-10-24。本文所在分支代码使用 `ontology-execution-v19`，业务模型为 `eigos.business@16`，同时保留 v18 常驻版本的读取上下文、首次只读动作选择与 PA 客户端更新。Personal Agent、MCP/A2A、身份和会员接入保留；旧版本计划只读，不自动迁移或恢复。三阶段目标与门槛见 [实施记录](backend-implementation-goals.md)。

`commerce.journey.sandbox@2`：新安装默认关闭，只对显式本机沙箱任务开放。17 个原子动作由模型选择，覆盖 PA 上下文、商家与商品发现、可供数量、履约选项、清关、完整报价、购物车、结账、模拟订单及付款/交付读取。11 个查询动作不创建交易；6 个业务动作逐个绑定精确沙箱许可。提供方为独立本机模拟器，不能连接真实商家或支付接口。详见 [交易履约沙箱](commerce-agent-sandbox-2026-10-19.md)。

本文描述运行边界与能力登记。对象模型和受控规划见 [N1](ontology-n1.md)、[N2](ontology-n2.md)，领域来源与真实业务执行仍按各适配器单独验证。

## 主路径

实际供应商 MCP 已统一为独立本体数据及 Agent 动作循环，见 [完整范围与维护边界](mcp-ontology-unification.md)。其初始化只创建范围，模型读取定义及观察后选动作，连接器不做预先候选准备。下图的 Resolver 分支仍用于其他已登记的非 MCP／模拟能力，不能据此把它当成 MCP 固定流程。

```mermaid
flowchart LR
  PA[Personal Agent] --> G[Gateway：认证与任务]
  G --> W[Worker：持久领取]
  W --> I[LLM：解释目标与本体]
  I --> R[Resolver：受控来源与实时事实]
  R --> P[LLM：基于事实提议短计划]
  P --> V[程序：约束／版本／依赖／许可校验]
  V --> A[事务外动作与查询恢复]
  A --> E[独立结果核验与受控反馈]
  E --> G
```

LLM 通过宿主提供的有界只读工具查询定义、对象、关系及函数；不能直接访问数据库、凭据或授予业务权限。它先读取最多16项能力摘要及输入契约，选定领域后再读取相关本体、最多8项候选、来源与逐条件检查。目录超限要缩小检索范围，不能静默截断或假装搜过全网。

## 对象与职责

| 模块 | 职责 |
| --- | --- |
| `packages/ontology/execution.ts`、`supply.ts`、`actions.ts` | 需求/成功条件、能力、提供者、报价/比较、短计划、动作/尝试/观察、许可、售后与验收 |
| `packages/core/catalog.ts` | 独立登记能力、绑定、适配器及发现来源；身份、环境及配置固定 |
| `packages/coordinator/requirements.ts` | 保留原文、来源和需求 revision；拒绝模型覆盖已有要求或伪造来源 |
| `packages/coordinator/resolver.ts`、`comparison.ts` | 实际查询、有界候选、同店归组、规格区别、费用/时效及 unknown |
| `packages/coordinator/plan.ts` | 校验短 DAG、固定输入、已验收输出引用、本体/绑定/配置摘要及有效期 |
| `packages/core/policy.ts` | 每次派发/业务续接前核对许可、动作、金额、币种、收款方和累计占用 |
| `packages/coordinator/runtime.ts`、`packages/core/store.ts` | 写前意图、尝试、事务外调用、原键对账、迟到观察、独立验收及任务隔离 |
| `packages/capabilities/catalog.ts` | 应用的受控组合入口；没有在线安装任意供应方代码 |

同一 ServiceCapability 可有多个 ProviderBinding。计划同时固定声明版本与定义/提供者/配置摘要，即使同一个版本号被错误复用，也拒绝静默换提供方。发现绑定按 owner + request 隔离；重启从固定计划恢复相同绑定，技术端点仍来自受控配置。

## 要求、方案与结果

`eigos.delegate` 接收原始 goal 和可选 requirements。数量、金额、时间、地点和条件保留类型与来源；金额用整数 minor 字符串，时间保留明确时区和原表述。PA 结构化输入标为 structured，模型原文抽取标为 quoted_text；二者不能混成模型自报事实。

硬条件 fail/unknown、币种不兼容、过期报价和未检索绑定不得作为可执行方案。搜索区域与配送目的地分开，查询附近门店不证明能送到。最终送达/退款等条件放到 successCriteria，不能既要求它在执行前已经发生，也不能从计划生成推出它已经发生。

报价比较保留 Merchant/Channel/ProductVariant/Offer。相同有证据的门店标识才归组，保留各渠道报价；同名不证明同规格。没有全量费用/库存/时效就保留 unknown，不填零或宣称有货。只读报价变化可在固定用户约束下有界重规划，保留 planHistory 和原业务键；发生未知业务副作用后只查原操作。

计划最多8步，依赖必须无环。输入只可引用本任务已验收前步输出，不能读别人的对象或执行模型生成代码。首次支持一项购买业务的短串行组合，拒绝无明确策略的多个订单；不宣称已实现任意规模的旅行/多商家优化。

## 已注册业务

| 能力 | 提供方/执行 | 完成含义 |
| --- | --- | --- |
| `brief.prepare@2` | 本地说明生成与精确验收 | 说明完成，底层 execution=not_started |
| `data.quality.audit.simulated@2` | 固定本地 CSV 快照、独立字节解析 | 全量五项报告完成；只有模拟授权，无真实付款 |
| `document.compose@1` | 显式配置的受限文档模型 | 草稿产生且格式/摘要核对；不认证内容真理或文档中的业务完成 |
| `geo.search@1`、`address.book.read@1`、`delivery.quote@2` | 模型读取独立本体并选择 stdio MCP 原子读取，逐次调用美团个人 CLI | 地点/本人地址/运费只读结果；无订单/支付/送达 |
| `ride.estimate.query@1` | Worker 经官方 MCP 执行两个受控只读工具；默认关闭，仅本机本人 | 地点或估价观察；无完整车费、订单、付款或行程完成，见[说明](didi-readonly-integration.md) |
| `commerce.catalog.query@2` | Agent 读取本体，选择搜索／详情／商家发现／店铺读取及其参数和组合；逐次观察后由模型提出完成，程序验收 | 有来源的公开商品查询或比较文件；显示单价与可售标记不证明库存、配送或购买权限 |
| `service.fulfillment.sandbox@1` | 显式启用、带认证的本机 HTTP 测试提供方 | 仅工程验证：接单、模拟付款、交付、取消、退款；没有现实商家或资金 |

CSV 只支持完整五项审计，子集或重复检查明确拒绝。文档、跑腿读取均走新后端；旧独立原型入口和状态机已删除。delivery.quote@2 支持同任务真实地址读取、选项保存、自然语言选择与价格查询。

个人美团凭据仅限 loopback 开发身份，不共享给 JWT 多用户。新后端由 Worker 通过内部 stdio Ontology MCP 读取版本化能力定义，再调用对应只读工具；Gateway 不运行查询程序。见 [美团接入说明](meituan-paotui-integration.md)。

## 动作与恢复

自动任务总等待默认24小时，可由 EIGOS_TASK_MAX_MS 配置（最多7天）。到期停止自动派发/轮询并保留未知支出；显式对账只查原操作，不恢复新的业务或模型调用。硬性交付期限经过后也不再开始新的业务副作用。

短的本地/只读原语实现 ExecutionAdapter；异步提供方实现 ActionAdapter 的 dispatch、observe、reconcile、verifyAction、输入验证与独立 verify。网络和模型调用都在 SQLite 事务外，适配器不直接修改 Job。

一个业务操作先落 ActionIntent，再落 ExecutionAttempt，稳定键不随 Worker 重启或业务重规划换掉。外部成功后本地崩溃会进入 effect_unknown，按原操作键/已验证远端引用查询，不能重下单、换供应方或释放未知支出。缺少查证能力、连续查询失败或回执冲突时需人工核对，不把 not_found 猜成“没发生”。健康 pending/重复回执不算失败。

观察先追加，再由当前有效领取者推进任务。重复事件去重，旧源版本不覆盖新事实；未知查询不能抹掉已证实的付款事实。取消和租约丢失后的迟到观察保留，但不能把取消的 Task 改成完成。取消任务只停止后续派发，供应商订单是否取消要单独观察。

`plan_grants` 固定 owner、计划摘要、绑定、动作、金额/币种、收款方、有效期。撤销阻止后续派发，在途操作继续查证。预算记录是本计划的许可/可能支出占用，不是钱包或结算账户；未知金额保持占用，退款不抹去原付款历史，也不自动产生新花费授权。

所有现实 order/payment/change/cancel/refund 副作用仍被程序策略拒绝。沙箱同时要求配置开关、认证 loopback 端点、请求 executionEnvironment=sandbox 和准确许可；真实/default-environment 请求看不到沙箱履约能力，不能用合成提供者代替真实履约。

## 售后、验收与反馈

`eigos.aftersales` / request_remediation 对本人原操作创建新的关联 Task，原失败/取消/完成状态不重开。新方案固定原引用与金额；退款申请保持 pending，只有提供方到账读回并独立核验后才 resolved。聊天“已付/同意”不是付款事实或动作许可。

逐条件 OutcomeAssessment 区分 satisfied/unsatisfied/unknown/needs_human。订单号不证明送达；付款不证明数量/时间达标；部分成功不整体完成。任务 metadata 可分别读 actions、businessFacts、authorizationBudget、outcome 和 afterSales。

反馈按 owner、准确绑定版本/定义及目标类型保存。Claim、Verification 与变更提议分开；正常进行、unknown、取消都保留在样本分母，退款成功不算原购买成功。只读/模型/沙箱证据不晋升为现实履约，变更提议不可自动发布或修改受信定义。本次未保存跨任务个人偏好或共享私人订单。

## 验证与部署边界

运行 `npm run check`、`npm test`、`npm run test:e2e`、`git diff --check`。E2E 使用独立 Gateway、两个竞争 Worker、独立持久测试提供方，覆盖接单/扣款后崩溃、取消/撤销竞态、部分交付和退款读回。

真实 PA／模型／美团只读来源在本人常驻服务上验收。PA 发起自然语言目标、收到真实地址选项、在原任务选择并读回报价后，运行 `node dist/examples/verify-pa-paotui-e2e.js --live --session-dir /private/session --expected-query /private/expected-route.json` 只读核对证据。观察器不代替 PA 提交、选择或查询供应商。实际记录见 [本轮常驻验收](evidence/persistent-pa-2026-10-18/README.md)；[前轮临时实例](evidence/service-network-e2e-2026-10-17/README.md) 保留为历史证据。

## 2026-10-18 六类服务扩展

六类扩展时的运行契约为 ontology-execution-v7，业务模型为 eigos.business@5；后续商品只读扩展升级模型至 @6。六个新增能力只在受信任代码显式传入 domainSandboxProviders 时登记，默认真实能力列表不包含它们；它们要求 sandbox 任务和本机开发身份。新增 domain 业务终点必须由逐条件领域验收及独立 verifier 同时通过。来源观察由有效领取者投影到稳定业务对象，旧回执保留，私人字段不进入协议交付物。

## UCP 官方本地测试商家

显式 `createExecutionCatalog({ store, ucpSandbox })` 可登记 `commerce.ucp.prepare.sandbox@1` 和 `commerce.ucp.confirm.sandbox@1`。连接限定 127.0.0.1 和官方模拟支付处理器；前者完成会话准备，后者需 order/payment 两种准确许可并独立读取原订单。复用现有执行账本和授权预算，默认关闭。协议版本、对象映射、恢复规则、实际模型及官方商家证据见 [UCP 接入说明](ucp-local-integration-2026-10-18.md)。

[六类实现、测试与真实接口缺口](service-domains-2026-10-18.md)。该轮未切换常驻服务；2026-10-19 为 [Shopify 只读 PA 验证](shopify-pa-worker-2026-10-19.md) 更新了本机服务。真实交易及六类服务预约仍未接通；后续 Luma 免费报名的单独实现与真实验证见本文开头，当前常驻状态见[总览](ontology-and-integrations.md)。
