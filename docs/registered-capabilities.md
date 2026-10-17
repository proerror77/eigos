# Ontology + LLM 后端 v3

2026-10-17。当前通用委托使用 `ontology-execution-v3`。Personal Agent、MCP/A2A、身份和会员接入保留；v1/v2 执行计划只读，不迁移、不恢复，也不回退到旧执行器。三阶段目标与门槛见 [实施记录](backend-implementation-goals.md)。

## 主路径

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

LLM 没有工具、数据库、凭据或授权能力。它先读取最多16项能力摘要及输入契约，选定领域后再读取相关本体、最多8项候选、来源与逐条件检查。目录超限要缩小检索范围，不能静默截断或假装搜过全网。

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
| `geo.search@1`、`address.book.read@1`、`delivery.quote@1` | 既有美团个人 CLI 的新适配器 | 地点/本人地址/运费只读结果；无订单/支付/送达 |
| `food.pickup.compare@1` | 官方麦当劳 MCP 门店、菜单、详情、计价及复查 | 当前账号、当前已查门店的只读报价比较；库存、产能、取餐时间仍未知 |
| `service.fulfillment.sandbox@1` | 显式启用、带认证的本机 HTTP 测试提供方 | 仅工程验证：接单、模拟付款、交付、取消、退款；没有现实商家或资金 |

CSV 只支持完整五项审计，子集或重复检查明确拒绝，不静默扩大范围。文档、跑腿读取已走新后端；独立历史原型仅保留其原有测试模式，不作为新后端执行 fallback。

麦当劳只读接入复用现有授权，以私有 `EIGOS_MCD_TOKEN_FILE` 配置；固定官方 `https://mcp.mcd.cn`，只允许门店/菜单/详情/计价/原单查询工具，禁止创建、取消、领券及积分兑换。使用方式及端点以 [官方 MCP 接入说明](https://open.mcd.cn/mcp/doc) 为准。个人 MCD/美团凭据仅限 loopback 开发身份，不能共享给 JWT 多用户。

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

真实模型/真实只读来源另行显式运行 `EIGOS_MCD_TOKEN_FILE=/private/token node --import tsx examples/verify-service-network-e2e.ts --live`（先构建）。证据见 [本轮 E2E](evidence/service-network-e2e-2026-10-17/README.md)。它不部署、不创建现实商家订单、不移动真实资金，也不能证明所有商家、地域、任务或长期可靠性。
