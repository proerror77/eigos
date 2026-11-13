# Scenario 生命周期与 Action 补偿

Scenario 的对象和关系差量由已有 Query、Function、Action 运行层解释。生命周期操作包含临时会话、持久方案、元数据共享、显式合并与清理。

## 临时会话

先调用 `open_scenario_session`，取得会话 ID，再用 `kind: "temporary"` 和 `sessionId` 创建 Scenario。会话属于当前认证身份，默认一小时，最长一天。方案的有效期取自身 TTL 与会话有效期中的较早时间。

`close_scenario_session` 关闭该身份的会话，临时方案立即停止读取和写入，清理过程删除其对象差量、关系差量与方案 Action 记录。重复关闭是幂等操作。后台清理也会删除到期的持久方案，每次最多处理 500 个方案并返回是否还有后续批次。浏览器或 SDK 宿主在结束临时会话时应调用关闭接口，断线期间由 TTL 收尾。

## 持久方案元数据

默认创建持久 Scenario。`OntologyScenario` 作为发布的 Object Type 提供 id、名称、所有者、状态、发布版本、修订号、到期时间、类型和说明。标准对象查询可以读取、筛选这些字段，并应用类型、实例和属性权限。

`share_scenario` 接收方案 ID、已读取的 revision 和读者身份列表。共享授权作用于方案元数据，底层对象差量继续使用原始 owner 的业务数据权限。撤销读者后，新的元数据读取被拒绝。此类型由生命周期服务维护，使用创建、共享和放弃接口进行变更。

## 合并与声明式编辑

`applyScenario` Action 规则声明允许合并的 Object Types 和 Link Types，以及 scenarioId 与 revision 的参数映射。运行时检查方案版本、所有修改的基线、当前权限、关系基数和允许的类型范围，再在 Action 事务内提交。

声明式 Action 还支持 `deleteObject`、`removeLink` 和 `editStruct`。删除与 Struct 编辑要求对象的当前 revision。Struct 编辑合并指定字段，并通过对象属性 Schema 重新校验整个值。关系删除检查已发布的端点类型和当前实例权限。

## 内部排程重规划

已有计划的重规划需要先创建 Scenario，再调用 `PrepareSchedulePlan`，在其 `input` 中提供原计划引用和 `scenarioId`。PA 日历请求通过原任务取得，新计划字段、日历覆盖和关系保存在所选方案。随后使用该 scenarioId 搜索时段、修改活动和读取方案。

放弃方案后，正式计划和正式日历覆盖保持原值。确认时，`CommitSchedulePlan` 合并所选计划的变更，并重新验证日历有效期、资源占用、活动依赖和时间窗口。方案中新建或移动到过去的活动会报告 `activity_in_past`，合并会拒绝这些安排。原有历史活动可以保留。

## 撤销 Action

`undo_action` 接收原 Action 的 requestId 和新的补偿 requestId。运行时保存每次正式 Action 实际修改的对象与关系，并为补偿检查当前修订号和关系状态。原操作者必须仍具有该 Action 的执行权限及相关对象、属性权限。后续修改发生后，补偿会整体拒绝，保护较新的业务结果。

补偿提交使用同一个数据库事务，记录新的 Action 与逐对象编辑历史。相同补偿请求可重试。原 Action 待投递的副作用在事务内取消，正在执行的副作用会阻止补偿。已完成或失败的外部投递可能已经产生外部结果，响应中 `externalEffectsReversed` 为 false，外部处理需要单独定义补偿操作。

## TypeScript 客户端

`packages/sdk/client.ts` 导出 `OntologyClient`、`ScenarioClient` 和 `OntologyHttpError`。宿主提供服务地址、可选 Ontology 名称和 Bearer token 或取 token 的函数。客户端支持查询、Function、Action、服务调用及 Scenario 生命周期。

通过 `client.scenario(id)` 获取具备场景范围的客户端。Query、Function 和编辑 Action 自动携带 scenarioId。`merge` 和 `discard` 要求调用方提供已经审阅的 revision。临时客户端可使用 `closeSession` 关闭所属会话。HTTP 错误保留响应状态与错误内容，取消信号传给实际 HTTP 请求。

## 验证

回归覆盖临时会话归属、关闭与过期清理，元数据共享及撤销，Struct 编辑和通用合并，Action 补偿及更新冲突，待投递副作用取消和执行中拒绝，重规划放弃与合并，以及过去时段的最终提交拒绝。日历测试使用明确标注的合成 PA 数据。
