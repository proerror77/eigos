# Machinery 流程挖掘与瓶颈分析

Workbench 的「流程运行 → Machinery」和 Ontology MCP 使用同一份分析结果。选择已发布的具体 ProcessLog 类型和时间范围，可以查看流程图、实际路径、状态存量、停留时长分布和偏离实例，再打开原业务对象的时间线或有权限的原任务。选择节点、转换、路径、分布区间或一致性类别可以筛选实例。已连接的子流程可以通过发布的 Link 从父实例下钻。

实现对应 [Palantir 的流程模型与 Action](https://www.palantir.com/docs/foundry/machinery/draw-a-graph)、[从历史挖掘流程](https://www.palantir.com/docs/foundry/machinery/process-mining)、[数据接入](https://www.palantir.com/docs/foundry/machinery/connect-data) 和 [路径、耗时及一致性监控](https://www.palantir.com/docs/foundry/machinery/analyze-and-monitor)。业务状态、Action 和数据来源继续由现有 Ontology、索引和 Action 引擎执行。分析根据提交后的 ProcessLog 计算，Scenario 中尚待合并的编辑不会成为实际路径。

## 建模与挖掘

在具体 ProcessLog Object Type 上可选配置 `machinery`。它属于 Ontology 发布定义，与绑定的对象、属性、Action 和 Link 一起验证。以下是出行流程的配置示例。

```json
{
  "states": [
    { "name": "proposed" },
    { "name": "authorized", "dwellSeconds": 7200 },
    { "name": "dispatched", "terminal": true },
    { "name": "canceled", "terminal": true }
  ],
  "transitions": [
    { "from": null, "to": "proposed", "action": "CommitSchedulePlan" },
    { "from": "proposed", "to": "authorized", "action": "AuthorizeEventTrip" },
    { "from": "authorized", "to": "dispatched", "action": "ExecuteEventTrip" },
    { "from": "authorized", "to": "canceled", "action": "CancelEventTrip" }
  ],
  "subprocesses": [
    { "link": "registration", "process": "EventRegistrationStateLog" }
  ]
}
```

示例的两小时是分析目标。它不改变出行调度。需要在状态进入或超时后执行 Workflow 时，Workbench 的「配置状态规则」与 MCP 的 `ontology_save_rule` 使用同一个 [过程规则](automation.md#过程规则)。Workflow 可以继续调用既有 Action，或走认知提案、Scenario 与人工审阅。模型上的 Action 标记用于解释预期转换，也能从流程实例打开现有 Action 表单。执行沿用 Action 原有权限和条件。一致性按状态边判定。

`ontology_machinery_processes` 列出可读类型和参考模型。`ontology_machinery_analysis` 可以按单个实例、已保存 Object Set 的 `setId`，或 `focus` 中的父实例、父 ProcessLog 类型与子流程 Link 分析：

```json
{
  "type": "EventTripStateLog",
  "from": "2026-11-01T00:00:00Z",
  "to": "2026-11-08T00:00:00Z",
  "mining": { "minCases": 2, "coveragePercent": 95 },
  "limit": 25
}
```

首次分析可以直接从观察到的状态与转换起步。指定 `minCases`、频次覆盖率和 `exclude` 可筛选挖掘结果。发布参考模型后，报告列出观察到但未建模的转换、已建模但在样本中未观察到的转换和瓶颈。编辑器可将挖掘结果带入参考模型。`ontology_machinery_propose_model` 只创建绑定观察版本的定义分支，继续沿用候选准备、独立审阅和发布。通过同一分析请求传入 `candidate`，可以在同一批已授权记录上比较两个模型的路径一致性。实际更换 Action 顺序或调用策略的收益需在 [Agent 回归评估](agent-evaluations.md) 或隔离 Scenario 中另测。

## 时间和权限

- 以提交记录时间 `recordedAt` 确定半开窗口 `[from,to)`。时间线也保留可见的来源观察时间。对按时间顺序索引的外部历史，选择 `durationClock: "observedAt"` 可按来源时间差计算耗时，仍以记账时间选择报告窗口。来源时间回退或被隐藏时，对应停留时长保持未知。窗口开始前最后一条记录用于还原当时状态。缺失的停留时间保持未知。路径统计只包括窗口中确实发生转换的实例，当前库存还可以包括窗口内没有转换的实例。
- 历史停留和截至窗口末仍在进行的停留分别统计。已知起点在窗口前的时长保留并计入 `priorToWindow`。总停留、P50、P95、最大值、分布和可配置停留目标用于找瓶颈。终态参与状态计数，但不进入瓶颈排名。来自实际状态和时长的观察本身不能说明根因。
- 分析同时检查当前对象、历史快照、日志属性与权限。相关记录中任一必要日志不可见时，整个实例不参与路径和指标，以免把被隐藏的转换拼成一条路径。可选的来源、时间和因果字段只在可读时返回。报告按已授权样本计算，`cases` 可以分页。每次分析最多读取 20,000 条可用转换和窗口起点记录，超限时需缩小时间范围或指定实例。对固定范围使用相同的 `from`、`to` 和筛选条件分页。
- 业务结果以原对象和回执为准。出行状态 `dispatched` 对应已发出供应商订单，后续业务状态沿原订单继续查证。对没有状态变更的失败或来源延迟，可以沿时间线关联的原任务查看执行追踪。

## 定期复盘

在 Workbench 保存复盘配置，或调用 `ontology_save_machinery_review`。可以手动运行 `ontology_run_machinery_review`，也可以启用同一 Indexer 中的定期复盘，周期以天为单位。定期复盘在创建者权限下运行，保存最新分析的时间窗口和发布引用。Workbench 或 `ontology_machinery_review` 读取时按当前权限重算，避免把撤权历史留在聚合缓存里。发布变化后可重新运行取得新报告。结果包含可以打开审阅的候选状态和转换。添加、修改和启用实际运行规则仍通过既有 Automation 入口。
