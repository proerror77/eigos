# Scenario 生命周期与 Action 补偿

Scenario 的对象和关系差量由已有 Query、Function、Action 运行层解释。生命周期操作包含临时会话、持久方案、元数据共享、显式合并与清理。

## 临时会话

先调用 `open_scenario_session`，取得会话 ID，再用 `kind: "temporary"` 和 `sessionId` 创建 Scenario。会话属于当前认证身份，默认一小时，最长一天。方案的有效期取自身 TTL 与会话有效期中的较早时间。

`close_scenario_session` 关闭该身份的会话，临时方案立即停止读取和写入，清理过程删除其对象差量、关系差量与方案 Action 记录。重复关闭是幂等操作。后台清理也会删除到期的持久方案，每次最多处理 500 个方案并返回是否还有后续批次。浏览器或 SDK 宿主在结束临时会话时应调用关闭接口，断线期间由 TTL 收尾。

## 持久方案元数据

默认创建持久 Scenario。`OntologyScenario` 作为发布的 Object Type 提供 id、名称、所有者、状态、发布版本、修订号、到期时间、类型和说明。标准对象查询可以读取、筛选这些字段，并应用类型、实例和属性权限。

`share_scenario` 接收方案 ID、已读取的 revision 和读者身份列表。共享授权作用于方案元数据，底层对象差量继续使用原始 owner 的业务数据权限。撤销读者后，新的元数据读取被拒绝。此类型由生命周期服务维护，使用创建、共享和放弃接口进行变更。

持久方案同时拥有生命周期维护的对象投影，可以作为已发布 Link 的端点。普通 Action 可以把业务对象与 `OntologyScenario` 关联，标准关系导航和对象集查询读取这些关联。为适配 owner 范围内的关系外键，每个明确授权的读者拥有一份同 ID 的元数据投影，其 `owner` 属性始终指向原始创建者。生命周期变更同步更新这些投影，撤销共享会一并删除该读者的元数据投影和相关 Links。到期清理删除所有元数据投影及关联，已有定义没有保留类型时继续使用原 Scenario 存储。

## 合并与声明式编辑

`applyScenario` Action 规则声明允许合并的 Object Types 和 Link Types，以及 scenarioId 与 revision 的参数映射。运行时检查方案版本、修改基线、当前权限、关系基数和允许的类型范围。拟议 Action 保存规范化输入、提交顺序和实际产生的字段及 Link 编辑。同一个合并事务按顺序在临时恢复的方案视图里检查每一步，读取当前正式数据和之前步骤形成的变化。合并只调用提交条件及只读校验，并使用已保存的编辑重建候选结果。PA 请求、供应商调用与编辑 Function 的准备过程只发生在拟议阶段。需要检查最终候选状态的约束在重建后复核，例如日历排程的占用和依赖。受约束的旧多步方案缺少完整证据时须重新提出。任一检查失败会回滚整次合并。[Palantir 合并动作](https://www.palantir.com/docs/foundry/ontology/merge-scenario)

方案保存明确编辑过的属性。合并时，来源仍管理未编辑字段，显式清空和显式保留同值维持用户覆盖语义。完整记录的方案允许未编辑字段独立刷新，前提是重建后的字段与 Link 差异和审阅时完全一致，且提交条件继续通过。已审阅字段的基线变化、对象身份冲突或 Link 差异使合并停止，方案保持开放以便重新提出。旧方案根据保留的前后值恢复能够识别的编辑，继续要求原对象版本。可调用 `rebase_scenario({id,revision})` 将兼容的正式字段变更纳入可见方案。显式变基获得新修订号并重新审阅。

正式数据并发新增互斥的单值关系时，方案查询显示拟议关系，正式查询继续显示正式关系。方案检查和工作台的关系差量表标出冲突，合并会拒绝提交，直至方案显式解决冲突或正式关系发生兼容变化。

声明式 Action 还支持 `deleteObject`、`removeLink` 和 `editStruct`。删除与 Struct 编辑要求对象的当前 revision。Struct 编辑合并指定字段，并通过对象属性 Schema 重新校验整个值。关系删除检查已发布的端点类型和当前实例权限。

## 跨账号审阅

持久方案的创建者可调用 `invite_scenario_reviewers({id,revision,reviewers})` 指定其他已验证身份。元数据共享继续使用 `share_scenario`。设置审阅者后，正式合并需要其中一人批准当前修订。

在工作台「方案比较」打开自己的持久方案，选择「邀请审阅」并填写对方从「我的身份」复制的审阅身份。受邀账号可在「方案比较」或「流程运行」的「受邀审阅」中打开差异并批准该修订。使用「同步正式数据」将兼容的正式数据变更带入方案。同步产生新修订时需要重新审阅，冲突由运行层返回。这里沿用同一发布内的显式变基和已发布合并 Action。参考 [Palantir Scenario 隔离与合并](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario)。

审阅者使用 `inspect_scenario_review({id})` 读取拟议属性和 Link 的差异。创建者和审阅者都要满足当前对象、行、字段及 Link 权限。审阅者通过该接口读取被邀请方案的差量，提交 `approve_scenario_review({id,revision,snapshot})`。合并由数据所属账号通过有权执行的已发布 Action 提交，并复核当前邀请、审阅者权限及准确版本。快照绑定差异、录入顺序和修订号。修改方案、变基或修改审阅者名单均要求重新批准。[Palantir 持久方案审阅](https://www.palantir.com/docs/foundry/ontology/persisted-scenario)

## 内部排程重规划

已有计划的重规划需要先创建 Scenario，再调用 `PrepareSchedulePlan`，在其 `input` 中提供原计划引用和 `scenarioId`。PA 日历请求通过原任务取得，新计划字段、日历覆盖和关系保存在所选方案。随后使用该 scenarioId 搜索时段、修改活动和读取方案。

放弃方案后，正式计划和正式日历覆盖保持原值。确认时，`CommitSchedulePlan` 合并所选计划的变更，并重新验证日历有效期、资源占用、活动依赖和时间窗口。方案中新建或移动到过去的活动会报告 `activity_in_past`，合并会拒绝这些安排。原有历史活动可以保留。

## 撤销 Action

`undo_action` 接收原 Action 的 requestId 和新的补偿 requestId。运行时保存每次正式 Action 实际修改的对象与关系，并为补偿检查当前修订号和关系状态。原操作者必须仍具有该 Action 的执行权限及相关对象、属性权限。后续修改发生后，补偿会整体拒绝，保护较新的业务结果。

补偿提交使用同一个数据库事务，记录新的 Action 与逐对象编辑历史。相同补偿请求可重试。原 Action 待投递的副作用在事务内取消，正在执行的副作用会阻止补偿。已完成或失败的外部投递可能已经产生外部结果，响应中 `externalEffectsReversed` 为 false，外部处理需要单独定义补偿操作。

## TypeScript 客户端

`packages/sdk/client.ts` 导出 `OntologyClient`、`ScenarioClient` 和 `OntologyHttpError`。宿主提供服务地址、可选 Ontology 名称和 Bearer token 或取 token 的函数。客户端支持查询、Function、Action、服务调用及 Scenario 生命周期。

通过 `client.scenario(id)` 获取具备场景范围的客户端。Query、Function 和编辑 Action 自动携带 scenarioId。`merge`、`rebase` 和 `discard` 要求提供已读取的 revision。审阅使用 `inviteReviewers`、`inspectReview` 和 `approveReview`。临时客户端可使用 `closeSession` 关闭所属会话。HTTP 错误保留响应状态与错误内容，取消信号传给实际 HTTP 请求。

## 方案评估

使用 [多方案比较与离线试跑](scenario-evaluation.md) 对齐业务指标和候选执行结果。

## 接续与旧方案恢复

`scenario_continuation_sources` 列出当前 owner 的未过期临时或旧发布方案，返回 `continuation.status`（`ready` 或 `blocked`）及原因。`ready` 表示操作日志完整，可以尝试接续；提交时仍重新检查当前契约、权限和数据冲突。日志缺失或不完整返回 `incomplete-action-journal`，不会推断操作顺序或沿用旧审批。

被阻塞的方案可用只读 `inspect_scenario_continuation({id, revision})` 查看差异。接口只接受同一发布祖先链中的自有开放方案，按当前 Schema、对象、行、属性和 Link 权限返回历史前后值；当前对象不可读、方案已过期或修订变化时拒绝。删除的字段不会重新暴露。这个读回不创建方案、不应用编辑，也不代表旧操作仍能执行。

工作台在阻塞行显示「查看差异并重新提案」。用户查看后可通过原生命周期入口新建空的持久方案，再用当前已发布的业务 Action 重新提出变更并送审。恢复不复制旧差量或审批，也不会把无日志草稿升级为可自动合并的方案。隔离和合并继续遵循 [Scenario 与 Action](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario) 的职责。

## 验证

回归覆盖临时会话归属、关闭与过期清理，元数据共享及撤销，Struct 编辑和通用合并，Action 补偿及更新冲突，待投递副作用取消和执行中拒绝，重规划放弃与合并，以及过去时段的最终提交拒绝。日历测试使用明确标注的合成 PA 数据。
