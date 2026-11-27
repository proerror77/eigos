# Scenarios：S1–S4 的实施方案

本文是 [路线图](../roadmap.md) 线三的详细做法，Palantir 的依据见 [对标计划](../palantir-parity.md#scenarios补模拟与自动同步)。

## 现状

`packages/runtime/scenarios.ts` 和 `scenario-store.ts` 已经提供：
- **两种方案：** 临时会话（`scenario_sessions`，有 TTL）和持久方案（`kind='persisted'`，默认 31 天后过期）。
- **改动：** 编辑暂存在 `scenario_objects` 和 `scenario_links`，查询通过 `viewTables` 叠加在正式数据上。查询内核在 C5a 实现了同样的叠加层。
- **显式 rebase（`rebase`）：** 按字段做三方合并。正式数据与方案改了同一个属性，或者一方新建、另一方删除，都算冲突；单值关系另外检查基数。
- **合并：** 由带 `applyScenario` 规则的 Action 完成，限定对象和链接类型，在一个事务里逐步校验。
- **审阅：** 分享、邀请审阅、审阅检查（`reviewDiff`）、批准。
- **比较：** `scenario-evaluation.ts` 可以并排比较 2 到 6 个方案（Object Set 聚合和 Function 指标），也可以离线试跑多个候选。

## S1：自动同步与执行上下文

### 自动同步

**状态：** 已实现，见 [Scenario 生命周期指南](../../guides/scenario-lifecycle.md#自动同步)。同步以方案创建者的身份执行 rebase，引入之前创建的方案不参与。

- **数据：** `scenarios` 增加以下列：
  - `sync_position bigint`：方案上次同步到的 owner 提交位置；
  - `sync_state text`：`current`、`behind` 或 `conflict`；
  - `sync_conflicts jsonb`：冲突的对象、字段和链接；
  - `synced_at timestamptz`。
- **触发：** Worker 每 10 分钟扫描一次打开的持久方案，与 Palantir 一致。为了不必逐个尝试，先用提交日志找出需要同步的方案：
  1. 读取 `sync_position` 之后的提交（`change_commits` 和 `edit_history`、`link_history`）；
  2. 只有当这些提交改动了方案暂存的对象、或者与暂存的链接在同一个单值端上，方案才需要 rebase；
  3. 其余方案只把 `sync_position` 推进到最新位置。
- **执行：** 复用 `rebase` 的三方合并。
  - 没有冲突时提交，修订号加一，`sync_state` 设为 `current`。
  - 有冲突时不改动方案，`sync_state` 设为 `conflict`，记下冲突，此后停止自动同步，直到用户显式 rebase 并解决冲突。
- **并发：** 同步与用户编辑用同一把方案锁（`lockEdits`）。用户正在编辑时，这一轮跳过这个方案。
- **验收：**
  - 正式数据有兼容的改动时，方案在下一轮自动跟上；
  - 有冲突时停在冲突处并标出；
  - 只读取了相关提交的方案才会 rebase：测试用语句数断言这一点。

### 执行上下文

**状态：** 已实现。提交条件改为声明 `executionContext`，不用参数表达式，见 [Action 接口指南](../../guides/action-api.md#按执行上下文区分的提交条件)。

- **语法：** 提交条件的参数表达式增加 `{ context: 'execution' }`，在 Scenario 中取值 `'scenario'`，在正式数据上取值 `'live'`。条件函数用一个参数接收它，就能对两种上下文分别判断。
- **改动位置：** `actions.ts` 的 `checkSubmission` 计算参数时，把 `objects.model.scenario` 传给表达式求值。
- **兼容：** 不使用这个表达式的条件，行为不变。
- **验收：** 同一个 Action 在 Scenario 中按宽松条件放行，在正式数据上按严格条件拒绝；合并时按正式数据的条件重新检查。

## S2：模型与模拟

**状态：** 数值时间序列保存在对象属性中，上限为 1 万点。派生字段支持
按点数定义窗口并做和、均值、最小值和最大值，其中步长为 1 的均值窗口
可用于移动平均。模型 Function 通过已发布的 Action 写入指定 Scenario，
现有比较服务可读取基线与方案中的预测字段。

1. **时间序列属性：**
   - Ontology 类型系统增加 `timeseries` 属性：一组按时间排序的点 `[{ t, v }]`。
   - 派生属性可以对它做窗口聚合（`window: { size, step }`、`sum`/`avg`/`min`/`max`）和平滑（移动平均）。
   - 存储仍放在对象的 `properties` 里，所以要限制点数，例如 1 万个。更大的序列放在专门的表里，属性中只保存引用；这一点在设计 PR 中按实际规模决定。
2. **模型 Function：**
   - 函数类型增加 `kind: 'model'`，声明输入（对象、属性、时间序列）和输出（预测属性）。
   - 实现可以是代码内置的函数，也可以是 F1 的组件函数。
3. **在方案中模拟：**
   - 在方案里覆盖模型的输入，可以编辑对象或时间序列；
   - 由一个 Function-backed Action 运行模型，把预测写回方案中的对象；
   - 再用现有的方案比较功能，与基线方案对比（指标就是预测属性的聚合）。
4. **验收：** 一个预测场景，例如容量或需求预测，能在方案里完成覆盖输入、运行模型、与基线比较这三步，结果可复现。
5. **依据：** 动手前先读 Palantir 的 [Vertex scenarios](https://www.palantir.com/docs/foundry/vertex/scenarios-overview/) 和 functions on models 的文档，确认模型输入输出与覆盖的语义。

## S3：方案对象与审批

1. **Scenario 接口：** 定义一个 Interface，属性包括名称、状态、所有者、修订号、过期时间和冲突状态。
   - 方案元数据类型（`OntologyScenario`，见 `scenario-metadata.ts`）实现这个 Interface；
   - 方案因此可以出现在 Object Set、查询和工作台中，按对象策略控制谁能看到。
2. **审批流程：** 用 Ontology 的现有构件搭起来：
   - 提交审阅、批准、驳回是三个 Action，各自有提交条件：只有方案所有者能提交审阅，只有审阅者能批准；
   - 状态变化写在方案对象上；
   - 合并就是 `applyScenario` 规则，可以与批准放在同一个受治理的 Action 里，在一个事务中完成。
3. **迁移：** 现有的 `inviteReviewers`、`approveReview` 改为调用这些 Action，原有接口保留为它们的包装，行为不变。
4. **验收：** 审批流程只用对象策略、提交条件和 Action 就能搭成；现有审阅测试不改也能通过。

## S4：规模

- **查询：** 已由 C5a 完成。Scenario 中的 Object Set、聚合、查询和 `follow` 都经过内核，方案比较中的聚合因此也经过内核。
- **rebase 与合并：** 现在逐个对象执行多条语句。改成集合操作：
  1. 一条语句读出全部暂存对象和对应的正式对象，在 SQL 中比较 revision 和字段；
  2. 冲突检测和字段合并在 JS 中批量完成；
  3. 再用一条语句批量更新 `scenario_objects`。
- **合并上限：** Palantir 的合并受 Action 上限约束。EIGOS 规定单次合并的对象数和链接数上限（例如 1 万），超出时报错，要求分批合并。
- **验收：** 在 1 万个暂存对象的方案上，rebase 的语句数与对象数无关，耗时在 Engine Benchmark 08 中记录。

## 依赖与顺序

- S1 只依赖已完成的 C4。
- S2 依赖 F1、F2。
- S3 依赖 S1。
- S4 的查询部分已经完成（C5a），rebase 与合并的批量化可以随时做。
