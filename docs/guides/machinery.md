# Machinery 流程挖掘与瓶颈分析

定期复盘绑定发布和分析时间窗。发布变化后，已启用规则由原 Indexer 刷新上次分析，不等待整个周期；暂停规则保持暂停。刷新保留原时间窗和定期执行时间，不重复运行附带的评估，也不把旧发布的评估回执当作新发布结果。到达原定期执行时间或用户选择「立即复盘」时，才按配置重新评估。该职责仍基于 [Machinery 的状态、过程日志与 Action](https://www.palantir.com/docs/foundry/machinery/core-concepts)。

`machinery_reviews` 返回 `status`：`pending`（未完成）、`stale`（发布已变化）、`ready`（可读取）或 `failed`。工作台只为当前可用结果显示「查看上次复盘」，失效时提示等待刷新或立即复盘。刷新重新检查当前权限并与发布切换互斥；失败记录原因，同一发布不会紧密循环重试，可修正权限或配置后手动重跑，原定期执行仍保留。

Workbench 的「流程运行 → Machinery」和 Ontology MCP 使用同一份分析结果。选择已发布的具体 ProcessLog 类型和时间范围，可以查看流程图、实际路径、状态存量、停留时长分布和偏离实例，再打开原业务对象的时间线或有权限的原任务。选择节点、转换、路径、分布区间或一致性类别可以筛选实例。已连接的子流程可以通过发布的 Link 从父实例下钻。

如果指定的现有运营者 MCP 连接只有任务 scope，可在 Gateway 设置 `EIGOS_MCP_OPERATOR_MACHINERY=<OAuth client ID>:<运营者 owner digest>`。用该连接的 `/identity` 验证两项标识，client ID 必须属于 `OAUTH_EXISTING_CLIENT_IDS`。匹配的连接凭 `tasks:read` 和 `Eigos/view_definition` 调用 Eigos 的 `ontology_machinery_processes`、`ontology_machinery_analysis`，按当前对象、日志和属性权限读取结果。配置独立于目录读取授权。通用本体、HTTP 和会员接入继续沿用原有校验。

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

## 视图、选择与指标

依据 Palantir 的 [Analyze and monitor](https://www.palantir.com/docs/foundry/machinery/analyze-and-monitor/)。

### 四种视图

分析请求带上 `view: { kind, scope }`，结果里的 `view` 就是对应的视图：每个节点和每条边各有一个 `value`。Palantir 预设了同样四种视图，分别显示曾经计数、当前计数、历史停留时长和当前停留时长。

| `kind` / `scope` | 节点 | 边 |
| --- | --- | --- |
| `count` / `historical` | 曾经处于该状态的流程数 | 经过该转换的流程数 |
| `count` / `current` | 现在处于该状态的流程数 | 最后一次转换就是这条边的流程数 |
| `duration` / `historical` | 已结束停留的 P50，另附 P95 和最大值 | 经过该转换的流程数 |
| `duration` / `current` | 仍在进行的停留的 P50，另附 P95 和最大值 | 最后一次转换就是这条边的流程数 |

- **停留目标着色：** 状态配置了 `dwellSeconds` 时，时长视图给节点着色。历史视图看 P95，当前视图看最长的一次，超过目标为 `red`，否则为 `green`。
- **Sankey：** `transitions[].cases` 是每条边的流量，可以直接映射为 Sankey 图的边宽，与 Palantir 用边宽表示 flow frequency 一致。

### 选择流程

`filter` 除了原有的单个 `state`、`edge` 以外，还可以多选：
- **节点：** `states: [...]`。与 `current: true` 一起使用时，选出现在处于其中某个状态的流程；否则选出曾经处于其中某个状态的流程。
- **边：** `edges: [...]`。`edgeMode: "through"`（默认）选出曾经经过其中某条转换的流程，`"last"` 只选最后一次转换是其中某条的流程。

这对应 Palantir 的 “Processes currently in selected states / ever in selected states”，以及边的 “ever went through a transition or just the last transition”。选出的流程用 `ontology_save_machinery_cases` 保存为 Object Set，供下游的分析、Automation 和 Action 使用：
- `mode: "static"`（默认）保存当前的实例；
- `mode: "dynamic"` 保存选择本身，即 Object Set 表达式 `{ "op": "machinery", "analysis": … }`。每次读取都在同一时间窗上重新分析，所以流程离开所选状态后，集合也随之变化。

### 工作台

工作台的 Machinery 页面在流程图上方提供四种视图的切换：曾经计数、当前计数、历史停留、当前停留。
- 节点显示视图的数值和节点指标，按指标阈值或停留目标着色。
- 边按视图的流量加粗，悬停时显示流程数和边指标。
- 流程图下方可以多选状态（当前处于、曾经处于）或转换（经过、最后一次转换）来筛选。
- 保存匹配的实例时，可以选择静态或动态。

### 节点和边的指标

流程模型可以各声明一个节点指标和一个边指标，与 Palantir 的 “one node metric … an optional edge metric” 相同：

```json
"metrics": {
  "node": { "label": "Distance", "aggregation": { "op": "sum", "property": "distance" }, "unit": "km",
            "colors": [{ "min": 0, "color": "green" }, { "min": 10, "color": "red" }] },
  "edge": { "label": "Routes", "aggregation": { "op": "count" } }
}
```

- **聚合对象：** 被跟踪的业务对象，例如上例中的 Route，而不是 ProcessLog。`sum`、`min`、`max` 和 `avg` 只能聚合数值属性，定义校验会检查。
- **计算范围：** 与 Palantir 一样，只在一致的流程上计算。节点聚合现在处于该状态的流程，边聚合经过该转换的流程。没有这样的流程时，值为 `null`。
- **执行：** 聚合就是 Object Set 聚合，在分析快照之后执行，所以路由允许时由查询内核回答。超过 1 万个对象时，这一项不聚合，标记为 `truncated`。调用方无权读取被聚合的属性时，这一项标记为 `denied`，分析的其余部分照常返回。
- **着色：** `colors` 取值达到的最高一档 `min` 对应的颜色。结果里的 `metrics.node.values` 和 `metrics.edge.values` 带有 `value`、`cases`，以及可选的 `color`。

## 流程容器

一个对象类型可以有多个被跟踪的状态属性，每个属性生成一个 ProcessLog，例如 `RouteStateLog` 和 `RoutePriorityLog`。依据是 Palantir 的 [core concepts](https://www.palantir.com/docs/foundry/machinery/core-concepts)：

- 流程容器 “can be linked to one another and even be nested”；
- 一个对象同时处在多个状态时，“should be modeled as a process hierarchy”。

EIGOS 用两种方式组织容器：

- **并行：** 流程模型的 `parallel` 列出同一类对象上的其他流程，即其他被跟踪的状态属性。分析结果的 `parallel` 按本流程的当前状态，统计这些对象在每个并行流程中的当前状态。
- **嵌套：** `subprocesses` 沿 Link 连到子流程，可以跨类型。分析结果的 `alignment` 按父流程的当前状态，统计这条 Link 连到的子对象在子流程中的当前状态。

```json
"parallel": ["RoutePriorityLog"],
"subprocesses": [{ "link": "requests", "process": "RideRequestStatusLog" }]
```

两种统计的形状相同：`[{ state, with: [{ state, count }] }]`。

- **校验：** 定义校验要求 `parallel` 里的流程跟踪同一对象类型的另一个状态属性，并且不能重复。各流程模型的 `subprocesses` 合起来不能成环，成环时报出环的路径。
- **权限：** 子对象按调用者的行策略读取，被遮罩的状态不参与统计。

## 时间和权限

- 以提交记录时间 `recordedAt` 确定半开窗口 `[from,to)`。时间线也保留可见的来源观察时间。对按时间顺序索引的外部历史，选择 `durationClock: "observedAt"` 可按来源时间差计算耗时，仍以记账时间选择报告窗口。来源时间回退或被隐藏时，对应停留时长保持未知。窗口开始前最后一条记录用于还原当时状态。缺失的停留时间保持未知。路径统计只包括窗口中确实发生转换的实例，当前库存还可以包括窗口内没有转换的实例。
- 历史停留和截至窗口末仍在进行的停留分别统计。已知起点在窗口前的时长保留并计入 `priorToWindow`。总停留、P50、P95、最大值、分布和可配置停留目标用于找瓶颈。终态参与状态计数，但不进入瓶颈排名。来自实际状态和时长的观察本身不能说明根因。
- 分析同时检查当前对象、历史快照、日志属性与权限。相关记录中任一必要日志不可见时，整个实例不参与路径和指标，以免把被隐藏的转换拼成一条路径。可选的来源、时间和因果字段只在可读时返回。报告按已授权样本计算，`cases` 可以分页。每次分析最多读取 20,000 条可用转换和窗口起点记录，超限时需缩小时间范围或指定实例。对固定范围使用相同的 `from`、`to` 和筛选条件分页。
- 业务结果以原对象和回执为准。出行状态 `dispatched` 对应已发出供应商订单，后续业务状态沿原订单继续查证。对没有状态变更的失败或来源延迟，可以沿时间线关联的原任务查看执行追踪。

## 定期复盘

在 Workbench 保存复盘配置，或调用 `ontology_save_machinery_review`。可以手动运行 `ontology_run_machinery_review`，也可以启用同一 Indexer 中的定期复盘，周期以天为单位。定期复盘在创建者权限下运行，保存最新分析的时间窗口和发布引用。Workbench 或 `ontology_machinery_review` 读取时按当前权限重算，避免把撤权历史留在聚合缓存里。发布变化后可重新运行取得新报告。结果包含可以打开审阅的候选状态和转换。添加、修改和启用实际运行规则仍通过既有 Automation 入口。


## 下一步 Action

为参考转换增加 `execution` 后，工作台的流程详情会列出该
业务对象按当前状态可以用的 Action。也可以调用
`machinery_next_actions` 并传入 `{object:{type,id},process?}`。
结果包含发布、目标状态、可直接填入 Action 的参数和仍需填写的字段。

`execution.subject` 是 Action 的主体参数。`parameters` 可以把参数
绑定到主体可读取的字段。每个 `requires` 守卫声明目标 ProcessLog、
合格状态以及 `all` 或 `any`。跨对象的依赖沿声明的 `link` 读取。
关系为空就等待建立相关实例，字段或关系的读取不完整时显示「待检查」。

提交仍使用发布的 Action。Action 会在提交检查中重新求值当前状态和
依赖，直接调用也做同样的检查。为守卫验证完整性时，关系使用相同的
PostgreSQL 事务快照。 [Machinery 状态与转换](https://www.palantir.com/docs/foundry/machinery/core-concepts/) · [Action 提交条件](https://www.palantir.com/docs/foundry/action-types/submission-criteria/)

### 已提交变化触发的局部重规划

调用 `watch_machinery_process`，传入流程对象 `object`、幂等键 `requestId` 和接收通知的 `conversationId`。订阅从当前提交位置开始，固定在创建时的发布版本。调用者需要读取依赖对象和关系、写入 Ontology 及提交任务的权限。用返回的订阅 ID 调用 `cancel_machinery_watch` 可结束订阅。

Indexer 按 owner 读取 05.4 的提交窗口。原对象被编辑、守卫依赖的关联对象被编辑，或原对象的守卫关系被建立或解除时，Indexer 按订阅人的当前权限重算候选 Action。可见结果发生变化时，原对话收到 `machinery_replanned`，可用 `machinery_next_actions` 读取详情。通知和游标在同一事务提交。原对象不可读、被删除或发布已切换时，订阅结束。

已授权、绑定到该对象的待执行 Action 按排程原身份复查守卫。条件阻塞时延后检查，恢复时继续遵守原开始时间和截止时间。原对象关联的观察计划也会提前复查，沿用既有排程规划器。整个过程保留原 Action、参数和授权。


### 流程改进提案的依据

从 Workbench 的流程分析保存候选模型时，服务端在已发布基线和选定时间窗上重新分析，记录偏离实例数、候选模型对同一批历史的偏离数、各瓶颈已结束停留的 P95，以及拟修改的转换和观察到这些转换的实例数。缺少已结束的停留样本时，P95 显示为“无样本”。手工创建定义分支的原有入口继续可用。

提案人按当前数据权限读取记录的依据。独立审阅人打开提案时，界面明确标出按其自身权限复算的数字。私有对象、子流程焦点、外部来源或保存的对象集受限时，界面只显示依据状态。修改候选流程或变更基线后，在提案中重新分析并准备候选。审阅绑定该次依据、候选版本及数据指纹；证据作者和提案作者均不能自审该提案。通过现有定义分支合并操作激活新版本，可以从原发布版本回读历史模型。
