# 业务链贯通：实施与验收

范围：复用现有 TaskService、执行账本、计划许可、来源投影、结果核验和售后流程，贯通「主体 → 委托 → 方案 → 授权 → 业务结果 → 验收 → 补救」。公共 PA 继续接收精简业务回执。真实下单、付款、预订和新供应商接入不在本次范围。

## 事实归属与模型

- 委托主体来自已认证任务所有者；不能据账户身份推断自然人或法律主体。已有 Provider 表达配置或来源中的服务主体，不推断卖方／履约方实名角色。
- 复用 ServiceRequest、ServiceEngagement、Proposal、Authorization、OutcomeAssessment、AfterSalesCase；新增仅用于原来缺失的主体、业务结果、逐项验收及实际业务决策记录。
- Proposal 表达目标、所选提供方式和固定条款；ExecutionPlan 表达技术步骤。无报价的服务也可以形成执行方案，不制造报价来满足关系约束。
- PlanGrant、准确模拟报价批准、授权撤销仍由现有策略和账本决定；本体持续映射其真实范围、有效期和来源。图中的对象本身不能授予权限。
- BusinessResult 对应已验证的来源观察；pending、rejected、unknown 与目标满足分别表达。既有 Order、Payment、Refund 及领域结果通过有来源的映射关联，未知商品规格不编造。
- OutcomeAssessment 关联当时需求、方案、结果及逐项判断；补救保留独立任务、独立授权和独立验收，不能把退款完成改写为原配送目标已完成。
- 控制动作绑定现有提交、批准、撤销、验收和售后处理入口。单纯的数据投影不包装成额外业务执行器。

## 兼容与一致性

对确需升级的对象定义和关系提供明确、原子、幂等的已知前版迁移；保留原身份、事实和历史凭据。不接受未知指纹，不把历史对象升级成可执行许可，也不自动重放旧模型计划。

运行账本和本体映射共用事务与领取栅栏。每次真正业务派发关联实际采用的许可；撤销／到期继续由运行策略检查。来源迟到事实可留存，但不能推进取消后的任务或把未知结果当完成。

## 当前实现

业务模型为 `eigos.business@10`，任务运行契约继续为 `ontology-execution-v8`。公共调用仍通过现有 TaskService、MCP／A2A 和只读本体查询完成，没有新增通用图写入或绕过策略的业务派发入口。

| 环节 | 对象及关系 | 事实来源 |
|---|---|---|
| 主体与委托 | `ServiceRequest.requester → RequestingParty`；内部决策主体单独使用 `ExecutionAgent` | 认证后的 owner 账本身份，不推断自然人或公司身份 |
| 需求版本 | `RequestSpecification.instructions/constraints/facts/conditions` | 原始消息、确认事实与条件；旧版本成员关系保留，当前回读核对封存摘要 |
| 提供方式与方案 | `ServiceRequest.proposals → Proposal`；`Proposal.engagements → ServiceEngagement → provider/channel/bindings` | 固定计划或 Agent 的固定读取范围；报价选择另用 `kind=offer_selection` |
| 许可 | `Proposal.authorizations → Authorization`；`Authorization.attempts → ExecutionAttempt` | `plan_grants` 的真实范围、有效期和撤销；本地模拟报价批准使用独立记录类型 |
| 业务结果 | `Proposal.businessResults → BusinessResult → executionStep/executionResult/subjects/sourceReceipts` | 通过原账本验证并应用的来源观察；未知或未应用的回执保留在技术执行结果中 |
| 验收 | `OutcomeAssessment → specification/proposal/businessResults/findings/acceptedArtifact` | 实际独立核验、要求与条件检查；不把模型完成声明当作验收 |
| 补救 | `AfterSalesCase → originalRequest/remedyRequest/order/originalAssessment/remedyAssessments/originalResults/remedyResults`；`Refund → originalPayment/case` | 现有售后账本与独立补救任务；当前可执行的补救来源为沙箱适配器 |

`BusinessDecision` 关联实际业务决定、注册动作定义及其摘要、时间、主体和原始账本身份。控制动作复用现有宿主校验：

| 注册动作 | 既有处理入口与必要条件 |
|---|---|
| `SubmitServiceRequest` | `TaskService.submit`：认证、写权限、所有者与幂等提交 |
| `ProposeServiceExecution` | 协调器接受固定计划／读取范围：当前需求、固定实现与校验后的范围 |
| `SelectOffer` | 网络询价选择：本人、当前版本、报价时效和硬条件；不授予业务执行权 |
| `AuthorizeProposal` | `TaskService.authorize(approve_plan)`：准确方案、沙箱、effects、提供方、金额与期限 |
| `ConfirmSimulationQuote` | `TaskService.authorize(confirm_simulated_payment)`：准确本地模拟报价 |
| `RevokeProposalAuthorization` | `TaskService.revokeAuthorization`：本人开放方案；已发生事实继续保留 |
| `AssessServiceOutcome` | 运行时独立核验：保存实际总体结论与逐项结果 |
| `RequestServiceRemedy` | `TaskService.requestRemediation`：本人原操作、受支持补救和独立后续授权 |

`PlaceSandboxOrder`、`PaySandboxOrder`、`ObserveSandboxDelivery`、`CancelSandboxOrder`、`RefundSandboxPayment` 绑定原有沙箱操作。派发前同时检查本体动作契约及原策略账本，实际 attempt 保存采用的许可 ID；观察／对账不会虚构新的写入授权。

本体中的 Action 注册记录依旧标记 `definition_only`：发现定义不等于取得可执行绑定或当前权限。`Authorization.effectiveStatus`／`authorizationStatus` 是记录在当前时钟下的状态，实际派发始终重新检查策略账本。测试覆盖“图中伪造许可但策略账本没有许可”，结果为拒绝派发。

### 沙箱来源映射

沙箱报价成为明确 `environment=sandbox` 的 `FulfillmentOffer`。订单、订单项、付款、配送批次、交付事件、数量分配和退款保留原业务键，并使用固定来源绑定区分身份。没有 SKU、支付交易号或独立配送单号时保持缺失，不制造标识。

每个已应用观察有独立 `BusinessResult`，并按订单、付款、配送和退款分别生成对应范围的 `SourceReceipt`；证据等级固定为 `synthetic`。订单等当前对象只接受不早于已有来源版本的快照。累计交付使用一条累计 allocation，重复查询不能重复累计。退款金额来自实际 `refundedMinor`，pending 不会使用申请金额冒充到账金额。

方案需要独立业务许可时才产生 `Authorization`。只读 Agent 的来源账户访问仍由既有连接授权检查负责，不生成虚构的订单／付款许可。已经提供类型化来源映射的跑腿、商品目录、六类服务与 UCP 结果复用现有对象和回执。

### 迁移规则

`business-chain-migration.ts` 只接受当前仓库保留的 v9 定义指纹，将 `Proposal`、`Authorization`、`OutcomeAssessment`、`RequestSpecification` 升到 v10 的兼容定义；关系只调整 `ProposalOffer`、`OrderLineVariant` 的适用范围。未知指纹、无效原属性或身份变化使整个 savepoint 回滚。

迁移不改对象内容、创建时间、revision、旧证据或策略许可；不会补造历史决策或尝试。缺少来源信息的旧 Authorization 查询为 `unknown`。旧计划的模型摘要不变，原有模型／定义检查继续阻止其被当作当前计划派发。业务对象定义兼容不等于重新授权或重放旧任务。

只有执行方案和读取范围允许不带报价；报价选择仍要求准确的一条 `selectedOffer`。允许数量服务的订单项缺少商品规格关系，未知规格不会被转换成商品匹配事实。

### 独立回读

调用 `query_ontology`，先以 `{object: {type: "ServiceRequest", id: taskId}}` 读取本人委托，再逐跳使用 `{from: objectRef, link: relationshipName}`。查询必须检查 `page.hasMore/cursor`，不假设第一页就是完整历史。业务任务摘要继续保留完整交付物与必要下一步信息，内部计划和账本不会在轮询中反复展开。

沙箱端到端测试从 MCP 查询上述关系，并交叉核对提供方账本和 A2A 任务状态；包含 Worker 崩溃、双 Worker、授权撤销、部分交付退款和取消后迟到事实。退款成功后重新查询原委托，原配送验收仍为 `unsatisfied`。

## 验收清单

- [x] 模型与受限前版迁移，含无报价方案和未知商品规格。
- [x] 主体、提供者沟通、版本化方案及执行关系贯通。
- [x] 真实许可映射、撤销／到期及实际派发许可关联。
- [x] 业务结果、来源证据和逐项验收映射。
- [x] 原业务、原验收、售后事项、补救任务／许可／结果关联。
- [x] 既有协议和 Actor 权限保持；PA 返回不展开内部账本。
- [x] 回归：错误所有者、伪造图许可、过期／撤销、部分完成、迟到结果、重复请求、未知结果、补救不改写原结果。
- [x] 多进程 MCP/A2A 端到端成功、部分交付与退款、撤销及崩溃对账；通过本体查询独立回读整条关系链。
- [x] 类型检查、完整测试、构建、端到端与实际差异审查。
- [ ] 提交推送、对应 SHA 的 CI 与远端／工作区回读。

## 验证记录

2026-10-20，本地类型检查和构建通过；`npm test` 为 **623/623**，`npm run test:e2e:run` 为 **9/9**，`git diff --check` 通过。所有业务操作均发生在工程沙箱。

- 迁移：保持对象内容、身份、revision 和证据；重复打开幂等；未知前版使整个迁移回滚。
- 需求：事实与条件按版本保存；旧值不被新值覆盖；当前断言被修改时封存摘要校验失败。
- 授权：伪造图许可不能通过策略账本派发；错误所有者、期限、撤销均拒绝；本地模拟批准单独关联实际 attempt。
- 业务结果：付款、订单、配送和退款各自的证据范围可校验；完整交付剩余为 0；15/20 部分交付退款后仍剩余 5，且原验收保持失败。
- 端到端：通过真实本机 HTTP 提供方、Gateway、Worker 与 MCP／A2A 核验；覆盖两种崩溃恢复、双 Worker、撤销再批准、重复补救与迟到事实。另两项端到端测试验证既有网络生命周期和离线成员权限围栏。

本次贯通以当前已实现的只读与沙箱能力为验收范围。网络成员／发布权限的完整统一、跨来源实体同一性和真实供应商履约仍按各自接入条件验证。
