# Agent 电商与社交身份 MVP：现有代码复用及缺口审计

日期：2026-10-18。审计基线：`3266f35b462fe091ccfe7ddb6bcbf790cbd6ae4a`。

本轮为方案研究：读取当前已跟踪代码与测试源码，未修改实现，未运行新的测试或生产验证。读取开始时已跟踪文件无未提交改动。另有其他写入者的未跟踪 `packages/ontology/model.ts`，未读取、修改或计入已交付能力。本报告中的“已有”指基线源码已实现；测试栏指已有测试表达的验证意图，不代表本轮重新执行通过。

## 1. 判断

现有底座可复用程度较高，但复用的是**私有、受约束、可恢复的任务执行内核**，不是已经完成的多边电商市场。现有 Ontology 不是仅有概念：供给、动作、报价、要求、计划、回执、验收、售后已经存在独立类型和运行路径。MVP 应在这些边界上增加市场与身份对象，不应重写一套平行执行器。

需要新增最多的是公开/受限发布、买卖双方身份及权限、供给管理与交易入口。真实付款、跨商家订单、跨任务预算、公共信誉和转介绍归因都不能仅通过打开现有开关获得。

## 2. 可复用模块及具体限制

| 能力 | 已跟踪实现/符号 | 可复用内容 | MVP 需要补充 |
| --- | --- | --- | --- |
| 人类会员身份 | `packages/members/store.ts`: `MemberStore`、`profileSchema`、`authorize` | issuer+tenant+subject 身份，会员同意/审批/停用、会话、连接撤销 | 对外 profile、组织/商家主体、认证信息、隐私可见性；当前 profile 只有 displayName/locale/timezone |
| Agent 安装与人类绑定 | `packages/members/agents.ts`: `AgentRegistrations.bind/authorize/revoke` | 安装登记、credential/token 哈希、所有者绑定、独立撤销、入会邀请 | 长期可公开 Agent ID、能力页、操作者与代理关系；登记对象不能直接当公开信用主体 |
| OAuth 与接口认证 | `apps/gateway/auth.ts`: `jwtVerifier`；`apps/gateway/app.ts`: `authenticate` | JWT 验证、会员门槛、MCP/A2A 共用 Principal | 新资源权限范围、公共读取与私有写入的差异、发布/推荐/授权职责分离 |
| 私有任务隔离 | `packages/core/domain.ts`: `ownerKey`；`packages/core/tasks.ts`: `TaskService` | 任务创建、查询、回复、取消、幂等请求 | 跨双方交易共享投影；不要放宽私有 job 的 owner 校验来实现社交共享 |
| 供给/商品描述 | `packages/ontology/supply.ts`: `Offer`、`ProductVariant`、`SupplyIdentity` | 来源 ID、商家、规格摘要、数量、费用、可用性、有效期、证据与未知项 | 当前 Offer.pricing.currency 固定 CNY，偏向餐饮；缺公开 listing 生命周期、类目索引、发布者权利和目录版本治理 |
| 业务定义与供应绑定 | `packages/ontology/execution.ts`: `ServiceCapability`、`ProviderBinding`；`packages/core/catalog.ts`: `ExecutionCatalog` | 业务定义与 adapter 分离、精确版本、配置摘要、绑定验证级别 | 当前构造时注入内存 registry，非持久自助商家入驻/发布市场 |
| 供给发现与比较 | `packages/core/catalog.ts`: `DiscoverySource`；`packages/coordinator/resolver.ts`: `CapabilityResolver`；`comparison.ts`: `compareOffers` | 来源/owner/request 绑定、coverage、超时、相同商家分组、谨慎同品判定 | 分类检索/分页/排序、用户可解释的推荐；当前最多 16 个 capability 摘要、8 个候选，不能扩成无限目录后仍全量提示给模型 |
| 需求与规划 | `packages/coordinator/requirements.ts`: `groundRequirements`；`plan.ts`: `proposePlan/validatePlan` | 硬约束、来源摘录、版本和输入摘要、固定 recipe、过期检测、依赖验证 | 更丰富商品/服务约束；计划最多 8 步且显式禁止多个 order，不能直接支持跨店购物车 |
| 执行与恢复 | `packages/coordinator/runtime.ts`: `createActionIntents`、`ActionRuntime`；`packages/core/store.ts`: `JobStore` | 持久 intent、attempt、observation、未知结果对账、迟到结果保护、独立验收 | 真实 provider adapter、provider-specific retry/receipt 校验；业务侧 webhook 接入与落库需单独设计 |
| Worker 隔离 | `apps/worker/worker.ts`: `Worker`；`JobStore.claim/renew/finish` | Gateway 不执行模型，数据库领取与租约、两 worker 竞争保护 | 当前共享 SQLite 且全局最多 2 个 claim，缺每用户配额、公平排队、租户成本控制和生产容量证据 |
| 授权与预算 | `packages/core/policy.ts`: `authorizationRequest/authorizeDispatch/createSandboxGrant`；`JobStore.reserveBudget` | 固定 plan digest、effect、payee、币种、额度、到期、撤销和预算占用 | 当前仅 sandbox grant；缺真人批准的可信证明、跨任务预算、商家分项额度、实际支付凭证 |
| 售后 | `TaskService.requestRemediation`；`AfterSalesCase` | 与原订单关联的取消/退款任务，要求先取得原 paid 事实，保留原失败记录 | 当前仅 sandbox adapter；缺商家/买方不同角色、部分退款/多次补救、争议材料与处理责任 |
| 运行事实反馈 | `JobStore.recordFeedback/providerEvidenceView/capabilityFacts` | owner 内的 binding 版本结果、未解决样本、证据等级、改进建议 | 公共信誉/推荐不能直接复用私有记录；需要发布同意、去标识、验证来源、刷量与争议处理 |

源码入口：[会员](../../packages/members/store.ts)、[Agent 登记](../../packages/members/agents.ts)、[任务领域](../../packages/core/domain.ts)、[目录](../../packages/core/catalog.ts)、[供给](../../packages/ontology/supply.ts)、[计划](../../packages/coordinator/plan.ts)、[运行时](../../packages/coordinator/runtime.ts)、[存储](../../packages/core/store.ts)。

## 3. 四个容易被误判的已有能力

### 身份隔离不等于每个 Agent 都有自己的授权边界

`ownerKey(p)` 只使用 `[issuer, tenant, subject]`，不含 `clientId` 或 registration ID。同一人授权的不同 OAuth client，拥有相同 tasks scope 时可以接续同一个人的任务，这是个人助理跨协议接续的设计。`AgentRegistrations` 能区分并撤销安装，但任务模型没有记录 actor installation 作为资源 ACL。

MVP 保留 owner 为人/组织的权利主体，另加 actor（具体 agent installation/client）作为操作归因，并按需要设资源 grants。不要把 registration displayName 当唯一身份，不要把用户 email 当主键。一个 agent 公开页面应映射稳定 public ID，再由后台绑定拥有者，不公开 issuer/sub/email。

### 现有入会 invitation 不等于社交转介绍

`AgentRegistrations.invite/redeemIntoMember` 的 token 绑定预先存在的 member，保证单次使用和入会门槛。它没有推荐人、被推荐供给、触达链路、订单归因、佣金或反自推模型。MVP 如需要转介绍，应新增 `Referral` 或 `Introduction`，明确它是“推荐关系/来源”，不可赋予下单或读取私有订单的权限。

### 现有授权 endpoint 不证明是人类批准

`POST /tasks/:taskId/authorize` 与 `TaskService.authorize` 要求有效 bearer 和 `tasks:write`，将授权通道与任务回复分开；当前没有专属 `authorizations:approve` scope，也没有额外 trusted-surface、人类会话或签名 mandate 证明。现阶段只允许 sandbox，因此这不是本轮发现的真实支付漏洞；但真实付款 MVP 不能把该 endpoint 原样开放就宣称“人类已批准”。

应增加独立授权服务：人类在可信界面确认精确 quote/plan，agent 只能提交授权请求和读取结果。授权记录绑定 actor、owner、payee、金额、币种、目的、到期与凭证来源；模型不能取得签名钥匙。MCP/A2A scope 仍只是“可调用哪些接口”，不能代替具体交易许可。

### 现有运行事实不是公共商家评分

`providerEvidenceView(owner,bindingRef,definitionDigest)` 限定同一 owner、精确 binding 版本/摘要，保留 unknown/canceled 样本；返回 `availabilityProof:false` 和 `automaticPromotion:false`。`capability_claims` 的 publisherId 当前取 channelId 或 configured-binding，没有公开主体证明。`changeProposals` 明确 `publishable:false`。

这些表可做信誉事件的私有原始依据，但公开推荐必须从单独的、经权限检查的 projection 读取。展示“3 次被证实按时交付，2 次仍待确认”比先做一个无法解释的综合分更适合初期。私人任务目标、地址、金额及证据不可随交易成功自动公开。

## 4. 预算、支付与多商家边界

- `PlanGrant.environment` 固定 `sandbox`；`Quote.environment` 固定 `local_simulation`。`authorizeDispatch` 对 reserve/order/payment/change/cancel/refund 一律要求明确配置的 sandbox action adapter 和 sandbox request，真实副作用默认拒绝。
- `reserveBudget` 汇总同 owner、同 job 的 held/consumed 金额；它不是整个用户、组织、月份或跨任务的 spending limit。payeeIds 是允许集合，缺每个 payee 上限，缺支付方式级额度和汇率处理。
- 已有累计占用可防同一 job 内多步超额；未知结果保持占用，确认 payment 才消费，明确 rejection 才释放。这是良好起点，但不能当完整财务账本。
- `proposePlan` 显式禁止一个 plan 中多于一个 order；虽然 recipe 能跨 binding，不能因此声称支持跨商家组合购买。MVP 先保持单商家单交易，之后通过父任务+独立子订单+各自授权+补偿策略扩展，而不是删掉限制。
- `ActionRuntime.assess` 用最终一步 delivery、adapter verifier、硬约束及目标状态决定完成。它独立于模型计划，但 verifier 仍由 adapter 实现，不是独立第三方鉴定；真实服务需要按垂类明确证据标准和人工争议入口。

## 5. 多用户上线准备度

身份与任务归属已有多用户结构和隔离测试；**业务供给仍不能按“已支持多用户生产服务”描述**：

1. `PaotuiReadAdapter.permitted`、`PaotuiGeoDiscoverySource.permitted` 固定只接受本地 developer owner；`PaotuiRequestAdapter` 继承该限制。Gateway 配置要求 Paotui 为 loopback development。公共地点查询还必须匹配受信任配置中的 allowlist。
2. `createExecutionCatalog` 只装载显式配置的本地 brief、CSV、document、sandbox 及 Paotui 只读能力；没有已注册的 UCP/ACP/Shop MCP 商业 adapter。
3. 当前私有 credential/context 避免进入模型是可复用设计，但新商家和用户账户需要明确 credential vault 的 ownership、授权续期、撤销和租户隔离，不能把本地个人 reader 的登录态用于全体用户。
4. Tenant 参与 owner key，但未见组织成员/role 管理、团队审批人、商家运营角色、资源共享 ACL。多租户键存在与企业级组织权限完整是两回事。
5. Gateway 和 Worker 的身份/队列隔离可复用；生产部署、容量、可用性、流量滥用与数据恢复没有在本轮验证。

## 6. 社交交易 MVP 最小新增对象和接缝（方案）

| 新增对象 | 最小职责 | 与已有内核连接 |
| --- | --- | --- |
| `PublicActorProfile` | agent/商家的稳定公开 ID、所有者验证、简述、可见性与状态 | 引用 Member/AgentRegistration；只发布批准字段 |
| `Relationship` | follow、trusted-provider 等有方向关系，主体、状态、撤销 | 提供发现过滤或偏好，不授予付款或任务读取权限 |
| `Listing` / `CapabilityPublication` | 发布版本、供给主体、能力、地区、价格语义、验证状态、上下架 | 编译/适配到 ServiceCapability + ProviderBinding，不直接执行任意上架代码 |
| `Referral` / `Introduction` | 谁向谁推荐何供给、来源、同意及撤销 | 传递 attribution ID 到任务/订单；不把引用转为授权 |
| `TransactionLink` | 买方 job 与商家 order/远端任务的关联、各方可读投影 | 私有 JobStore 继续 owner 隔离；共享状态放独立表 |
| `EvidencePublication` | 哪部分验收事实可公开，证据等级、脱敏和争议状态 | 从私有 observation/outcome 派生；原记录仍保留 |
| `AuthorizationGrant` 扩展 | 人类批准证明、actor 限制、可消费预算及撤销 | 复用 plan digest/effect/payee/expiry；独立于 tasks:write |

建议 `packages/members` 保持账号与接入职责；市场 profile/关系/发布用独立服务与存储边界，避免把 MemberStore 变成所有业务对象的通用数据库。`ExecutionCatalog` 只接受已经验证并适配的发布快照；`DiscoverySource` 承接市场检索；`ActionAdapter` 承接具体交易执行。

## 7. 推荐实施顺序与可否证验收（本轮不实施）

1. **身份+公开供给薄层**：一个买方、一个商家、一个 agent 安装，创建/更新/停用 profile 和 listing；未公开内容不可检索，停用不可生成新计划，已有任务可保留只读历史。先无社区 feed、无佣金。
2. **发现与推荐**：从已验证 listing 或一条实际官方供给源取 Offer，保留 coverage、有效期和未知项；推荐理由必须指向价格/适用范围/历史证据，用户关系只能作为明示偏好。
3. **单商家闭环**：先运行无支付的真实搜索/报价/商家结账交接，内部保留 remote reference；支付和订单未确认不得 completed。再在单独授权下接 sandbox 交易及失败补救。
4. **双边交易状态**：买卖双方仅看到各自被允许的信息，取消本地任务不等于撤销商家订单；超时、重复通知和撤销后迟到成功都有可追踪结果。
5. **证据公开与轻信誉**：只有完成的可验证交易才能产生经批准的公开事实；未验证、模拟和真实结果分开，撤销公开不删除私有审计证据。
6. **后续再扩**：跨商家拆单、跨任务预算、付费转介绍、争议裁决和自动赔付分别立项，不塞入第一版。

## 8. 已有测试可直接扩展的位置

| 测试文件 | 已有断言主题 | MVP 应追加的回归 |
| --- | --- | --- |
| `tests/members.test.ts` | 身份/同意/审批、CSRF、撤销、OIDC PKCE、scope 不被 membership 取代 | 私有与公开 profile、组织角色、字段级可见性 |
| `tests/agent-onboarding.test.ts` | owner-bound 单次邀请、token/installation 绑定、即时撤销、scope/identity escalation 拒绝 | actor 归因、同 owner 不同 agent 的资源限制、推荐不等于入会权限 |
| `tests/ontology-backend.test.ts` | 受限 binding 先过滤、硬约束 unknown 不执行、模型不可改输入/版本、独立验收 | 发布状态变化、真实 quote/可信授权绑定、公开字段投影 |
| `tests/supply-discovery.test.ts` | discovery owner/request/source 固定、同名异规格、不完整费用不能过预算 | listing 检索分页、来源覆盖、推荐归因与隐私 |
| `tests/action-runtime.test.ts` | order/payment 不等于 delivery、部分失败、退款确认、回执冲突、累计预算、等待期限 | provider-specific retry、跨任务预算（若入范围）、公开信誉不混入 sandbox |
| `tests/worker.test.ts` | 双数据库领取、租约 fencing、不重放、多进程接续、owner 隔离、迟到取消 | 多用户公平性/限额、商家通知入口和双边投影 |
| `tests/backend-gateway.test.ts` | MCP/A2A 共用 intake、澄清/授权/验收、篡改计划拒绝 | 新市场工具与 REST 共用授权行为，trusted approval 不可由普通 tasks:write 伪造 |

验证层级：本报告是**源码与测试定义审查**，未把测试存在写成已重新通过；也未证明任何真实商家订单、支付、退款、公开发布或生产多用户服务。本轮仅新增本文档。
