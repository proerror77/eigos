# Scenario 多方案比较与离线试跑

Workbench 的「方案比较」提供「并排比较」和「离线试跑」。两者通过 Ontology MCP 和 TypeScript SDK 也可调用。

- **并排比较**读取 2 至 6 个明确修订的 Scenario，让正式数据和各方案使用相同的 Object Set 聚合及业务 Function 指标。每列显示对象与关系差量计数、冲突和预览。各方案保留原有权限、审阅和合并路径。
- **离线试跑**为每个案例固定输入、证据对象修订和业务时钟。系统在临时 Scenario 中实际调用已发布 Action，运行明确配置的业务检查，并记录完成、拒绝和指标结果。每个候选执行完即回滚，其后候选从同一个正式数据起点开始。输出包含发布、案例输入摘要、各步骤和指标。试跑输出中的新对象引用属于当次模拟。

该实现使用既有 Scenario 隔离、Action 提交条件、只读 Function 和 Object Set 模型，分别对应 [Palantir Scenario 比较](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario) 和 [用 Ontology Edits 评估实际行为](https://www.palantir.com/docs/foundry/aip-evals/ontology-edits)。

## 比较已保存的方案

MCP 工具为 `ontology_compare_scenarios`，SDK 方法为 `compareScenarios`。示例使用排程校验和活动数量作为业务指标。

```json
{
  "scenarios": [
    {"id": "<第一个 Scenario UUID>", "revision": 3},
    {"id": "<第二个 Scenario UUID>", "revision": 5}
  ],
  "metrics": [
    {"name": "feasible", "function": "validateSchedule", "input": {"plan": {"type": "SchedulePlan", "id": "<计划 ID>"}}, "path": ["valid"]}
  ],
  "aggregates": [
    {"set": {"op": "query", "query": {"type": "ScheduledActivity"}}, "metrics": {"activities": {"op": "count"}}}
  ]
}
```

修订过时需要重新选择。指标可从已登记的无外部请求 Function 中提取布尔、数值、字符串或 null。对象集合聚合可进一步按计划或其他属性筛选。对象与关系预览每种最多 50 条，计数覆盖完整差量。比较使用一次事务和现有发布及 owner 编辑锁，避免在比较不同列之间混入正式对象或关系变化。

## 用相同证据试跑候选流程

MCP 工具为 `ontology_trial_scenarios`，SDK 方法为 `trialScenarios`。调用者须具备读写 scope 及正常的 Action、Function 和对象权限。传入 1 至 8 个案例、2 至 4 个候选流程，以及共享指标。案例的 `evidence` 列出使用中的 Plan、PA 日历或路线回执对象及准确修订。不同候选从同一个 `inputs` 取值。

案例的可选 `evaluatedAt` 可将登记的排程和行程 Function 放在同一个过去的评估时间，按当时的业务时钟判断证据有效期。Scenario 仍以当前许可读取的、指定修订的数据为基线。查验历史数据时，需要提前保留对应证据对象。

每个候选的步骤是 `action` 或 `check`。后者对已登记的只读 Function 提取一个标量并与 `equals` 比较。步骤参数支持 `{"input":"plan"}`、`{"result":"previousStep"}` 或 `{"value":...}`。检查不通过或业务条件拒绝会结束该候选，并保留经过的步骤；其他候选继续运行。

例如，先用 `SaveScheduleActivity` 排入原时间再检查，与先校验再排入另一时段进行比较。两组共用 `validateSchedule` 和相同日历覆盖。试跑报告可显示通过数、被拒绝的步骤、尝试步数和已配置的业务指标。报告里可以比较计划或活动状态，供应商等待、订单结果和真实审批仍由正式执行中的证据衡量。

目前可试跑声明式编辑和已登记的排程/出行 Function，例如 `SaveScheduleActivity`、`PlanEventTrip`、`findScheduleSlots` 和 `validateSchedule`。试跑使用当前发布的 Action 和实现，合并、外部来源调用及依赖 PA 回传的 Function 走各自已有入口。Machinery 挖掘到的实例可以作为选取案例的依据。实际选择一个候选用于运营时，使用正式 Scenario 重新提出，按其当前修订完成审阅和合并。
