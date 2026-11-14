# Workflow 与对象规则

Workflow 保存一组已发布 Action 的执行顺序。对象规则定期查询本体，对新进入匹配集合的对象提交 Workflow。执行使用创建请求的身份、原始 OAuth scopes 和当前资源权限。

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

## 查看与权限

写操作需要 `ontology:write`，列表需要 `ontology:read`。Workflow 和规则检查本体定义可见性及 Action 资源权限。输入属性经过当前行和属性策略遮罩。

运行列表重新检查原始对象、已完成步骤的数据依赖和每个结果对象的当前可见性。失去权限的对象引用返回 `null`。列表返回最多一百条记录及 `hasMore`。

## 存储与升级

管理员调用 `initializeAutomation(db)` 建立或升级以下表。

- `workflows` 保存定义。
- `object_rules` 保存规则、启用状态、原始 scopes 和扫描错误。
- `rule_matches` 保存匹配状态和进入代次。
- `workflow_runs` 保存运行、租约、冻结正文与进度。
- `workflow_steps` 保存逐步参数、授权依赖及执行记录。

业务运行角色需要这些表的 SELECT、INSERT、UPDATE 权限，修改规则还需要 `rule_matches` 的 DELETE。定义编辑与执行使用同一个 PostgreSQL schema。Indexer 通过 `scanOne` 和 `runOne` 驱动后台执行。

## 验证

`tests/22-automation.test.ts` 覆盖并发领取、重复提交、Action 已提交但进度未记录时的恢复、取消提交隔离、取消时补记执行记录、原始 scopes、关系变化触发、错误扫描停用、输出引用权限和发布版本保护。测试使用隔离数据库和合成 Action。

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
学习到的酒店 Workflow 使用任务入口运行，普通 Action Workflow 和对象规则
继续使用各自原有的接口。

学习到的正文保存实际成功的工具顺序，并把对象引用映射到前序步骤的返回值。
酒店选择按原生酒店 ID 从新结果中定位，路线地点则重新读取并核对原地点身份。
入住日期和计划窗口作为可变参数保存。出行开始时间来自新一轮可用时段，
结束时间由学到的活动时长计算，随后重新检查路线是否装得进该时段。
正文保留原任务的成功证据，学习失败的步骤、未返回权威结果的任务或旧审批
都不会成为下一次执行的依据。
