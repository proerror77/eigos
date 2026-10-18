# T10：买方确认的私有询价与报价方案

2026-10-18。交付分支 `codex/network-t10`，接续 T08/T09，已合入最新已提交的本体版本 `70aaa12`（ontology-execution-v6）。实施期间原工作区的改动由其原工作继续提交，本轮没有复制或覆盖在途文件。没有部署、更新常驻 PA、扩展真实来源权限或开启交易。

## 交付范围

社交线索现在可以经买方明确确认，转换为本人私有只读询价；报价完成后，买方可以确认“已查看”或在前置条件成立时保存一个版本固定的 Proposal。

当前可转换的来源是 T07 已审核、已批准共享、绑定到现有 `delivery.quote@1/@2` 的服务资料。仅介绍、无绑定、对买方无实际权限或不属于登记报价策略的服务返回 SOURCE_NOT_AVAILABLE，不建立假 Task。已有地点 DiscoverySource 继续承担地点发现，不被当作报价源；本轮没有新增商户、通用 DiscoverySource 报价接入或第二套报价映射。

真实个人美团读取仍受现有本机身份限制，网络会员身份不会因此借用发布者凭据。工程测试使用明确允许合成主体的 fixture adapter；不代表实际网络会员已经取得个人美团或其他商家的调用权限。

## 明确选择与确认

为了把“买方明确选择”落实为可审阅事实，T10 在 D04 的 convert/select 命令前增加准确选择请求，复用现有会员会话、Origin 和 CSRF 控制面：

1. 买方助手准备需求、服务、可选推荐消息，以及私有 buyerGoal/requirements；或选择本人已有 Task 的准确版本。
2. 服务端验证当前引用、来源与权限，只保存 pending choice，不创建任务、不读取来源。
3. 买方在 `/members/network` 查看准确的需求/服务、私有目标或已有任务要求、报价条款及检查结果，确认该 choice。助手 bearer 和 MCP 没有批准入口。
4. 当前绑定助手消费已批准选择，原子创建/关联 Task；报价选择同样经确认后才保存。

选择有效期 15 分钟，绑定 owner、profile、安装绑定版本、准确输入与物料摘要。批准前后再次校验；来源、需求或报价版本变化不能沿用旧确认。pending/approved 可以撤销；已消费选择不能通过“撤销确认”倒销 Task，已有私有任务继续走原 cancel_task。

这不是 PublicationGrant：私有目标没有对外发布，发布许可也不能批准创建询价。两者复用身份、控制会话、版本和事务机制，权限目的保持分离。

## 当前命令和查询

继续使用 `network_command` / `POST /network/v1/commands`。均含 version=1、asProfileId、requestId；以下操作还需 network:write、tasks:write、tasks:read 和安装绑定中的 **inquiry.manage**。旧绑定不会自动增加它。

| 操作 | 内容 |
| --- | --- |
| inquiry.request_conversion | input：postId、expectedPostRevision、listing={publicationId,revision}、可选 message 同格式，以及 request |
| inquiry.convert | choiceId；必须是已由买方会话确认的 convert 选择 |
| inquiry.request_selection | input：inquiryId、expectedRequestRevision、quote={type:DeliveryQuote,id,revision}、selectionKind=reviewed/proposal |
| inquiry.select_quote | choiceId；必须是已确认的 select_quote 选择 |

转换 request：

```typescript
// 新建：buyerGoal 是本次私有输入，不从帖子或卖方回复复制。
{ kind: "create", buyerGoal, requirements?, completionTarget: "quote_only" }
// 关联：不能携带替换 goal。
{ kind: "attach", existingTaskId, expectedTaskRevision, expectedRequestRevision, completionTarget: "quote_only" }
```

控制面动作：`inquiry.approve_choice(choiceId,expectedRevision,reviewDigest)`、`inquiry.revoke_choice(choiceId,expectedRevision)`。审批内容及摘要由服务端生成，不能提交 approvedBy、sourceLocator、adapter URL 或付款许可。

`network_query` 增加：

- `my_choice`：asProfileId、choiceId；要求当前原绑定及 tasks:read，仅返回本人的选择输入/状态。
- `my_inquiry`：postId；owner 级恢复，同 owner 的合法新安装可以找回 taskId，无需原帖仍共享；要求 network:read＋tasks:read。
- `my_selection`：selectionId；读取本人历史选择、快照、当前有效性；要求 network:read＋tasks:read。

`network_get_command` 支持这些操作的原请求回执。供应方、圈管理员、审核员没有读取买方 Task、choice 或选择快照的旁路。Task 详情继续用原 get_task / A2A GetTask；对象读取继续用原 query_ontology/evaluate_ontology。

my_inquiry 的 source.candidateEligible 只表示当前登记来源仍通过只读校验，availableNow 固定 unknown，不证明实时供给或商户健康。Task 完成报价报告与来源后来不可用可以同时存在，历史数据不被删除。

## 转换、事务与恢复

首次转换校验本人发布的当前开放需求、准确内容版本、当前可见服务 publication/revision、已审核代表关系及来源绑定。选择推荐时还校验消息属于本帖、引用当前需求内容版本和同一服务 publication；只保存非权威 provenance 引用，不把 safeText 当作用户原话。

InquiryBridge 和 TaskService 必须共用 JobStore 的同一 SQLite 连接。原 TaskService.submit 校验、构造、原请求回执和 projectTask 被提取为 transaction-aware 内部接点；普通 MCP/A2A 提交行为保持。没有复制 Task 创建代码或嵌套 BEGIN。

- 唯一 `(buyerOwner,postId)`，另对已关联 Task 保持唯一性。
- 同一选择的多请求/多安装恢复同一个 inquiry/task；不同目标/来源/私有输入不能把已有询价隐式重选或生成第二单。
- 内部提交键以首次 inquiry UUID 固定；结合一帖一关联和同事务回执防重，外部未知结果先查询原回执/my_inquiry。
- Task、N1 ServiceRequest 投影、私有来源上下文、Inquiry、choice 消耗及网络命令回执一次提交。注入失败时全部回滚。
- 来源上下文复用原 preparation_contexts，固定 quote_only、买方会员、选择的 listing/binding/capability 版本与摘要；不存于公共 Task 元数据或帖子中。
- 新建 Task 只排入原 Worker 队列。attach 只允许未领取的 submitted，或无固定计划/ActionIntent 的 input-required；拒绝 working、已有领取、终态、其他 owner、旧版本或沙箱业务任务。
- attach 增加 job/request revision，保留原 goal、用户消息和已有问题，不自动唤醒 input-required。用户通过原 reply_to_task 补充后继续，同一来源限制保持。

共享事务协调器只在同一连接已进入受控业务事务时允许内部提交，并兼容项目声明的 Node 22.13 起点；不依赖较新版本才提供的原生事务状态属性。对象库原 SAVEPOINT 继续参与同一个外层事务。

## Worker 和来源约束

普通任务继续使用原完整目录。关联询价在原 Coordinator 入口构造仅含获选报价能力、获选配置绑定和受保护原 adapter 的目录视图，再复用原 Resolver、Planner、ActionRuntime 和 Worker：

- 模型不能改为 brief/document、其他商家或另一 binding；受限目录没有任意来源 URL、发现回退或 effectful adapter。
- 登记策略只允许 delivery.quote@1/@2 对应的 read 动作，不凭服务标签推定它能报价。准备结果不能附带付款授权或越界步骤。
- 准备、执行及验证前后重查买方/发布者 deny fence、服务及代表状态、原服务受众、期限、capability/binding/config 摘要及买方实际 permitted(owner)。
- 来源失效或变化时拒绝继续；已经在途的读取无法撤销，但失效后的结果不能进入规划/报价投影或触发第二次读取。
- 原持久领取、租约、取消和迟到结果保护保持。帖子撤回只停止共享，不取消已成立的私有询价；服务本身失效则阻止新的来源读取。
- 价格变化沿用原 ReplanRequired 的有界重新核验，在同一个 Task/来源上进行；不另建任务、不悄悄接受旧价格。

Gateway 不启动模型或来源程序。网络关注/动态不会触发转换。inquiry_linked/quote_selected 等是私有本地事件，不进入公共动态。

## 报价与 Proposal

报价完全复用现有受控读回执、projectReadResult/projectTask、DeliveryQuote/Parcel/DeliveryRoute/SourceReceipt，以及 offerFreshness、deliveryQuoteMatches、withinBudget 和条件评估。没有第二个报价库，也不从社交文本制造 evidence。

选择要求私有 Task 已完成并通过原验收，Quote 属于同 owner/同 Task/当前 request revision，准确对象版本、有效期和路线/包裹适用性成立。报价或要求变化后旧选择 current=false，重新选择必须重新确认。

- **reviewed**：仅确认已读报价报告。费用完整性 unknown 保持 unknown，不生成 Proposal 或授权。
- **proposal**：所有硬要求及硬前置条件必须有 pass 证据。完整费用范围或预算依据不成立时返回 REQUIREMENTS_UNPROVEN。有明确 role 的要求保留原角色；人数不复用重量、押金不复用总价。未映射的角色保持 unknown。
- 条件满足时，通过受控本地选择模块写入既有 Proposal 及 selectedOffer/request/selectedProposal 关系，并同事务保存不可变选择快照。模型的 proposal_only 对象不会自动执行这条路径。

快照包含 request/quote 版本和摘要、现有对象/关系指纹、SourceReceipt 引用及证据等级、允许保存的报价条款/期限、条件结果、planningSnapshotDigest 和选择类型。Proposal.termsVersion 固定为快照摘要；SourceReceipt 仍是价格事实来源，快照只是历史选择。

这里的 Proposal 是私有报价选择，不是 ExecutionPlan、商家承诺、付款许可或已执行订单。原 Task 和原计划不重开、不改写；没有 PlanGrant、Payment、Order 或外部预订动作。真实配送估价仍是 estimate、费用覆盖 unknown；在没有相应硬预算条件时记录“选择这份估价”也不能称为可保证履约的报价。

## 验证和范围

[验收记录](evidence/network-t10-2026-10-18/README.md) 区分：合成身份/来源/模型、真实本地 Worker/SQLite/HTTP/MCP/A2A 代码路径、故障注入与重开恢复。当前已接通已有报价能力的工程通路，不证明生产网络会员拥有真实报价权限或商家能够履约。

T11 的获准结果摘要仍待实施；本轮选择和报价均为私有。没有部署、实际 OAuth 扩权、真实商户接入、真实报价请求、订单、付款、预订、退款或外部消息发送。
