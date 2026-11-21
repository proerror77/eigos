# Workflow 与对象规则

Workflow 保存一组已发布 Action 的执行顺序。规则可以定期查询对象集合，也可以逐条处理已提交的过程转换。执行使用创建请求的身份、原始 OAuth scopes 和当前资源权限。

## 定义与启动

`Automation.workflow` 接收名称、说明和最多二十个具名步骤。步骤名称在同一 Workflow 中唯一。每步指定 Action 和参数绑定。

```json
{
  "name": "Record a route",
  "steps": [{
    "name": "Create record",
    "action": "CopyRoute",
    "input": {
      "id": {"property": "name"},
      "name": {"literal": "Copied route"}
    }
  }]
}
```

`literal` 传递显式值，`property` 读取原始触发对象的可见属性或嵌套属性，`object: true` 传递该对象引用。`step: "Create record"` 引用之前具名步骤返回的对象，因此创建 Action 的结果可以成为后续修改或关联 Action 的输入。保存定义时拒绝不存在、向前或自身引用。运行时从已提交的 Action 与持久步骤记录读取引用，并重新检查结果对象当前可读性。每一步首次执行时重新读取对象并绑定参数，随后使用 Action 的参数契约规范化，包括默认值。

`run` 接收 `{workflow, object, requestId}`。服务检查原始对象可读和步骤 Action 可执行，并固定 Workflow 正文、发布版本及原始 scopes。相同请求和相同 Workflow 内容可重试；同一 requestId 绑定不同内容会被拒绝。

更新 Workflow 或规则需提交 `id` 和当前正整数 `revision`。创建时 revision 为零。更新定义影响后续新运行，已经提交的运行保留原有正文。

## 执行恢复

冻结记录同时保存原输入的安全标记。重试在执行前及提交锁内复核当前权限，恢复原始依赖与标记，不能因为输入后来改名、降级标记或步骤重试而降低输出保护。旧版未提交步骤若没有这份历史上下文，会明确要求新建运行；已经提交的 Action 仍可根据原凭据恢复进度。Scenario 合并后，仍存活对象的依赖转为正式对象，删除和回滚的依赖继续拒绝复用。

步骤结果绑定在首次求值后固定为准确 ObjectRef，重试继续使用该引用；尚未执行的 Action 会重新检查该对象当前权限。每步在调用 Action 前将规范化参数、授权依赖和稳定 requestId 保存到 `workflow_steps`。即使 Action 改变了触发对象，恢复时仍使用已保存参数。

Action 的对象写入和执行记录使用现有原子事务。Workflow 在 Action 提交后记录步骤完成。进程在两者之间中断时，恢复会核对 Action 执行记录的摘要并补记完成，随后继续下一步。Action 事务中的提交回调同时更新该步骤的数据授权依赖。

多个 Worker 使用领取租约和行锁分配运行。提交前检查租约、取消状态与当前发布。一次 `runOne` 执行最多两分钟，租约为一百五十秒；逾期 Worker 的后续提交会被拒绝。失败状态需要显式 `retry`，运行从第一个未完成步骤继续。重试重新检查当前 Action 权限和原始发布，未提交步骤重新检查冻结参数所依赖的数据权限。

`cancel(access, model, id)` 停止后续步骤，可用于待执行、执行中或失败运行。取消会在同一事务中补记已提交但尚未写入 Workflow 进度的 Action 记录，再清除领取令牌。已提交步骤保留在 Workflow 和 Action 审计中。取消后的运行不能重试。

## 对象规则

`rule` 接收 `{name, query, workflow, enabled}`。`enabled` 默认为 false，只有显式启用后才参与扫描。查询使用现有对象条件、关系导航、派生字段和权限控制。

每次扫描在一致的数据库事务中完成，最多匹配 10,000 个对象。规则每三十秒进入一次可扫描状态。对象从不匹配变为匹配时生成运行；持续匹配期间不会反复生成。每次进入使用独立递增代次，所以关系变化引起的离开和重新进入，即使对象 revision 相同，也会重新触发。

保存规则时记录调用者原始 scopes。扫描和所提交的 Workflow 使用这份记录。旧规则缺少 scopes 时，升级会将其停用，并要求重新保存。

查询、权限或定义错误会回滚当次扫描产生的运行和匹配变化，将规则停用，并记录诊断状态。用户修正原因后重新保存并启用规则。扫描错误不会让 Indexer 持续崩溃或无休止重试同一规则。

## 过程规则

`save_rule` 也接受 `process` 条件，例如为连续两小时处于待执行状态的出行流程安排一个 Workflow。

```json
{
  "name": "Review a trip awaiting departure",
  "process": {"type":"EventTripStateLog","to":"authorized","dwellSeconds":7200},
  "workflow": "WORKFLOW_ID",
  "enabled": true
}
```

`type` 使用已发布的具体 ProcessLog Object Type。`from` 和 `to` 是可选的状态筛选。省略一侧匹配任意状态，`from: null` 匹配从空状态进入已知状态。配置 `dwellSeconds` 时必须指定 `to`。日志与业务对象沿用同一行、字段和密级权限。规则用业务对象作为 Workflow 输入。为异常回退设置一对具体的前后状态即可复用这条路径。

保存规则从当时已提交的转换之后开始。Indexer 以有界批次按历史序号读取，规则修订、转换序号和稳定的运行 ID 一起防止重复执行。更新游标与创建 Workflow 在同一事务内完成，因此扫描之间发生的短暂状态仍会被处理。已提议的 Scenario 修改在合并并写入正式历史后才会触发规则。

有停留时间的规则根据转换记录时间安排现有 Workflow 运行。首个 Action 提交前重新检查原规则、历史权限、当前状态和最新转换。离开再进入会生成新的一轮等待。工作流以业务条件控制正式 Action 的提交，过程条件只决定何时尝试启动。参考 [Palantir 对象集条件](https://www.palantir.com/docs/foundry/automate/condition-objects)。

## 查看与权限

写操作需要 `ontology:write`，列表需要 `ontology:read`。Workflow 和规则检查本体定义可见性及 Action 资源权限。输入属性经过当前行和属性策略遮罩。

运行列表重新检查原始对象、已完成步骤的数据依赖和每个结果对象的当前可见性。失去权限的对象引用返回 `null`。列表返回最多一百条记录及 `hasMore`。

## 存储与升级

管理员调用 `initializeAutomation(db)` 建立或升级以下表。

- `workflows` 保存定义。
- `object_rules` 保存规则、启用状态、原始 scopes、过程历史游标和扫描错误。
- `rule_matches` 保存匹配状态和进入代次。
- `workflow_runs` 保存运行、租约、冻结正文、触发转换和最早执行时间。
- `workflow_steps` 保存逐步参数、授权依赖及执行记录。

业务运行角色需要这些表的 SELECT、INSERT、UPDATE 权限，修改规则还需要 `rule_matches` 的 DELETE。定义编辑与执行使用同一个 PostgreSQL schema。Indexer 通过 `scanOne` 和 `runOne` 驱动后台执行。

## 验证

`tests/22-automation.test.ts` 覆盖并发领取、重复提交、Action 已提交但进度未记录时的恢复、取消提交隔离、取消时补记执行记录、原始 scopes、关系变化触发、错误扫描停用、输出引用权限和发布版本保护。过程回归验证轮询间内进入和离开、历史游标的重复读取、状态离开后重新计时以及触发权限撤销。测试使用隔离数据库和合成 Action。

## 从酒店行程任务学习与复用

在 Grok 或其他 PA 中，可以用 `submit_task` 提交自然语言目标，并设置
`learnHotelWorkflow: true`。Agent 从当前已发布的 Ontology 选择操作。
学习范围是 RollingGo 酒店、滴滴驾车路线、PA 日历与当天的一段上海出行。
成功工具调用记录保存在原任务的 workflow_trace 中，PA 暂停、进程重启和续跑共用这份记录。
任务必须实际读到所选酒店和路线，并生成通过校验的持久 Scenario，
才会得到待批准的行程。PA 仍使用原任务的忙闲请求回传日历。

任务结果中的 `hotelWorkflow` 给出待审的 Scenario、修订号和证据摘要。
在工作台的任务详情审核后，点击「批准本次模拟执行」。也可由具有
`tasks:read`、`ontology:write` 和计划批准权限的操作员通过
`POST /tasks/:id/hotel-simulation-approval` 提交 `scenarioId`、`revision`、
`snapshot` 和 `decision: "approve-simulation"`。接口会重新校验原身份、
方案版本、日历有效期、报价和路线，再原子地保存模拟回执和学习到的 Workflow。
模拟根据出发时间和当前路线估计到达时间，并记录距计划结束的余量。
回执标记为 `synthetic`、`executed: false`、`bookable: false`。
Scenario 保持可审核状态，批准模拟与正式合并是独立操作。

Grok 可用 `list_learned_hotel_workflows` 查找当前账号的已保存行程。
用 `submit_task` 提交 `replayHotelWorkflow: { workflowId, checkIn }` 复用。
复用按新日期重新查询同一家酒店、路线和日历，生成新 Scenario 和审批请求。
原日期、报价、行程对象、Scenario 及审批均不会被带入下一次运行。
流程保留学习时的定义摘要。发布变更后，使用已保存步骤和已声明的依赖核对原发布与当前发布的 Action、Function、来源和对象契约。v8 流程可以在增加过程日志的 v9 中复用。相关契约变更或原发布无法核实的流程会从复用列表隐藏，尝试按原 ID 重放会在调用来源前停止。重放执行及审核使用当前发布，并复核原身份、酒店和路线证据。[Palantir Workflow Lineage](https://www.palantir.com/docs/foundry/workflow-lineage/refactor-and-understand-workflows)
酒店能力模块负责路线证据、日期绑定和模拟审批。普通 Action Workflow 和酒店 Workflow 共用按 owner 与本体限定的流程记录存储。酒店复用通过任务入口运行，调用同一套 Action、Function、权限和 Scenario 工具。

学习到的正文保存实际成功的工具顺序，并把对象引用映射到前序步骤的返回值。
酒店选择按原生酒店 ID 从新结果中定位，路线地点则重新读取并核对原地点身份。
入住日期和计划窗口作为可变参数保存。出行开始时间来自新一轮可用时段，
结束时间由学到的活动时长计算，随后重新检查路线是否装得进该时段。
正文保留原任务的成功证据，学习失败的步骤、未返回权威结果的任务或旧审批
都不会成为下一次执行的依据。

## Workflow 认知提案

普通 Workflow 可以在声明式 Action 步骤之后增加一个 `proposal` 节点。节点冻结发布、触发对象及其修订，创建属于该运行的 Scenario 和持久任务。模型只获得该节点声明的 Action 和只读 Function，且所有工具必须使用指定 Scenario。模型外发和回值继续经过现有资料权限及模型外发策略。预算跨 PA 暂停与进程重启累计。工具串行执行，提交提案等待前置工具结束。准备日历时，已登记的 `PrepareSchedulePlan` 可在该 Scenario 内通过原任务请求 PA 忙闲，写入仍在 Scenario 内。

```json
{
  "name": "酒店行程重排",
  "steps": [],
  "proposal": {
    "name": "酒店接驳方案",
    "goal": "在酒店行程的有效时间窗口内选择可执行的接驳安排",
    "actions": ["PrepareSchedulePlan", "AttachPlanService", "SaveScheduleActivity"],
    "functions": ["findScheduleSlots"],
    "validation": {"function": "validateSchedule", "objectParameter": "plan"},
    "mergeAction": "CommitSchedulePlan",
    "mergeObjectParameter": "plan",
    "reviewers": ["itinerary-reviewer"],
    "timeoutSeconds": 900,
    "maxToolCalls": 24
  }
}
```

发起者通过常规 `run_workflow` 传入已存在的触发对象引用。运行列表返回认知任务和 Scenario ID。任务使用现有 PA 请求及响应协议，`waiting-proposal` 不占用 Workflow 执行租约。通过所声明的验证 Function 后，Workflow 进入 `waiting-approval`，指定的其他账号可检查和批准当前差量。Workbench 的「流程运行」列出受邀审阅。SDK 的 `pendingScenarioReviews` 使用同一接口。审批后由有权限的所属账号显式提交已声明的合并 Action。审阅摘要绑定实际业务差量、决策版本、规范化参数及声明的外发意图。酒店计划的确认状态也写入拟议差量。合并事务在 Action 完成编辑后比较对象和关系的实际差量，任何额外变更都会使事务回滚。完成 Workflow 与 Scenario 合并一起提交。

认知任务记录决策时实际读取的对象和版本、Link 导航和成员、来源观察及原 PA 回执摘要。Query 和 Object Set 保存规范化谓词与所见结果摘要，空结果也作为证据。分页 Query 按已观察页复核。Object Set 的成员读取同时绑定完整集合摘要和用到的已保存集合修订。证据只保存参数、对象引用和摘要。

暂存 Action 与其读取证据在同一事务写入。PA 暂停和恢复仍沿用原任务的证据。审批绑定证据摘要。审阅及合并按原调用身份和模型可见范围复核，在对应的 Scenario 编辑阶段读取当前正式数据和当时的覆盖层。合并的复核与正式写入使用同一事务及数据编辑锁。遗漏的读取阶段或变化的证据都会阻止合并。已按整 owner 指纹提交的旧提案沿用其原证据契约。

发布激活检查包括 `waiting-proposal` 和 `waiting-approval`。当前发布继续处理这些运行，直到完成、显式取消或超时后才可切换。

等待总时限从创建 Scenario 起计算。超时检查先于项目发布和执行权限复核。超时以及流程终止时，在同一事务中取消尚未完成的原认知任务。普通 Action 步骤的重试行为继续适用，认知提案终止后可发起新的 Workflow 运行。该节点用于内部编辑提案。模型只能暂存编辑。合并动作可以派发审批中列出的声明式效果，发单或付款仍需各供应商 Action 的业务授权。

实现沿用 [Palantir 的 Scenario 合并权限](https://www.palantir.com/docs/foundry/ontology/merge-scenario)、[AIP Logic 调用者权限](https://www.palantir.com/docs/foundry/logic/blocks) 和 EIGOS 已有 Action、Task、Scenario 与执行追踪。数据库升级后，Indexer 的角色需要创建和取消认知任务，以及写入 Scenario 元数据和执行追踪。现有任务和 Workflow 记录使用兼容的默认值。

## 向使用者发布流程

本体定义管理员（`manage_definition`）在工作台的「规则与监测」中选择一个工作流草稿的准确修订和运行对象类型，发布后才进入「已发布流程」。`ontology_publish_workflow` 和 `ontology_withdraw_workflow` 提供同一管理入口。修改草稿保留正在使用的发布副本，直到管理员发布新修订。切换 Ontology 发布后，运行前检查原发布谱系及 Action、Function 和对象契约。

服务团队维护本体和流程草稿，普通已准入账号登录后进入「已发布流程」。目录仅显示当前用户有权执行、兼容当前本体的公开修订，不包含步骤配置或绑定。运行使用用户自己的身份、授权对象和当前 Action 权限，保留现有审批和幂等机制。下架阻止新的运行，已经提交的运行保留其冻结输入。管理员和编辑者继续通过既有 `manage_definition`、`edit_definition` 授权，发布流程不会转授任何业务或来源权限。参考 [Palantir Action 权限](https://www.palantir.com/docs/foundry/action-types/permissions) 与 [Ontology 权限](https://www.palantir.com/docs/foundry/object-permissioning/ontology-permissions)。

### 单个 Action 作为状态规则的效果

过程规则可在 `workflow` 与 `effect: {action, input}` 中选择一项。例如进入某个已发布状态后执行一次检查，可以通过 `{object:true}` 绑定当前对象，并沿用 Workflow 步骤的属性与常量参数绑定。后台继续使用原有运行记录、租约、去重和恢复机制，并在执行时检查发布契约、当前权限和 Action 的提交条件。机器人的自动执行身份不能代替 PA 对具体交易的直接确认。

工作台「我的状态触发规则」按当前账号与过程类型显示已配置的条件、效果、启用状态和本修订最近可见运行。转换统计分别展示模型预期和日志中观察到的来源或 Action。某条预期转换出现并不意味着已启用一条规则。

升级数据库时运行 `npm run db:upgrade`。直接效果的运行无需关联已保存 Workflow，因此 `workflow_runs.workflow_id` 允许为空；`object_rules.effect_release` 记录效果绑定时的发布。已使用列级授权的管理服务需核对该列的读写权限。
