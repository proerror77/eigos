# Machinery 过程日志、Scenario 与排程

过程日志沿用同一发布 Ontology 的 Object Type、Interface、Link 与对象集查询。它不是新的执行引擎，也不替代 Action、Automation 或 Scenario。设计依据是 Palantir 的 [Process Object 与 Log Object](https://www.palantir.com/docs/foundry/machinery/connect-data)、[过程状态](https://www.palantir.com/docs/foundry/machinery/core-concepts)、[Scenario 执行上下文](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario) 和[排程修改后校验](https://www.palantir.com/docs/foundry/dynamic-scheduling/scheduling-validation-rules)。

## 定义、实例与查询

`ProcessLog` 是共同属性的 Interface；具体日志 Object Type 对应某个业务类型的可枚举状态属性。接口不保存实例，Object Set 只是查询结果。

| 业务对象属性 | 日志 Object Type | 从业务对象导航 |
| --- | --- | --- |
| `EventRegistration.state` | `EventRegistrationStateLog` | `stateLogs` |
| `EventTrip.state` | `EventTripStateLog` | `stateLogs` |
| `StripeLinkPaymentRequest.status` | `StripeLinkPaymentRequestStatusLog` | `statusLogs` |
| `ActionConfirmation.state` | `ActionConfirmationStateLog` | `stateLogs` |
| `SchedulePlan.state` | `SchedulePlanStateLog` | `stateLogs` |

`packages/ontology/process-definition.ts` 生成这些普通类型和关系定义。类型的 `machinery-log` 分类标记来源对象类型，`machinery-property` 标记被跟踪属性；定义发布和重命名沿用现有校验与资源映射。它们不声明第二套状态转换规则。日志沿 `process` 关系返回原业务对象。

Gateway MCP 通过现有 `query_ontology` 查询：

```json
{
  "query": {
    "type": "ProcessLog",
    "from": {
      "object": {"type": "EventRegistration", "id": "REGISTRATION_ID"},
      "link": "stateLogs"
    }
  }
}
```

HTTP、MCP 和 Object Set 的关系查询使用同一对象与 Link 视图，包含过程日志的只读投影。也可按具体日志类型和 `processId` 筛选，或使用现有 Object Set 聚合、保存集合及物化读取。关系查询可以用 cursor 继续分页，直接跟随 Link 仍遵守既有完整读取上限。

Worker 中的模型通过任务专用 `eigos_ontology` MCP 使用相同查询；其 `query_ontology` 工具使用 `queries` 批次封装。`describe_ontology` 能发现日志类型，`follow_links` 导航同一发布关系。模型不读取数据库文件或直连供应商来替代这些能力。

`ontology_process_status` 或 `POST /ontology/services/process_status` 接受 `{type,object}`。其中 `type` 是具体日志类型，`object` 是对应业务对象引用。返回当前可见状态、最近一条可见转换的引用、观测时间、记录时间和按记录时间算出的停留秒数。最近的真实转换缺失或不可见时，时间和停留秒数为空。业务对象中每个独立状态属性可以各自发布过程日志和规则。状态转换监控和超时 Workflow 见 [过程规则](automation.md#过程规则)。

## 状态值的数据库约束

每个发布投影冻结其 Machinery 状态属性、可选值及必填性。数据库根据正式对象的投影和 Scenario 的所属发布绑定约束。`objects` 和 `scenario_objects` 使用同一个行内 PostgreSQL `CHECK` 检查状态值。约束同时覆盖方案的原始基线和拟议属性，删除差量使用 SQL NULL。可选状态可以缺省，显式的状态值必须是枚举中的字符串。

运行 `npm run db:upgrade` 为现有发布和已跟踪对象绑定契约，并验证已有数据。常驻角色继续使用现有对象写权限及发布读取权限。候选复制使用候选契约，历史投影和旧方案继续使用其原契约。后续发布随原有事务保存新的契约，复用已有约束和触发器。[PostgreSQL CHECK 约束](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)

## 日志来源与因果

日志实例是已有 `edit_history` 的只读查询投影，不建立新的日志数据库、复制对象或等待后台日志任务。普通业务查询不展开该投影。当前发布只读取自身与祖先发布的历史，旧发布不会读到后续版本新增的转换。

每条日志有稳定 ID、业务对象 ID、被跟踪属性、前后状态、时间、记录时间、历史序号、来源、执行者与发布引用。创建对象的前态为 null。来源更新有明确观察时间时，`timestamp` 使用该时间；其他编辑使用系统记录时间。`recordedAt` 始终表示系统记录时间。

Action 的名称、请求身份与原任务身份在同一编辑事务中写入历史。Indexing 记录原索引事务身份。旧历史的未知因果字段保持 null，不根据时间接近猜测 Action，也不把运行任务 completed 当作业务成功。

没有改变被跟踪属性的普通编辑不产生状态日志。重复 Action、重复或陈旧来源回包不重复生成转换；业务事务回滚时日志也不会出现。日志与其关系禁止业务创建、编辑、删除或来源写入。跨本体实例迁移应迁移业务对象，不能把只读日志当作可复制业务数据。

## 权限

读取日志需要日志类型及原业务对象的读取权限，同时应用当前业务行、历史前后行和状态属性的可见性。日志筛选和聚合在同一权限过滤之后计算。任务缓存记录原业务对象依赖；撤权、原对象删除或可见性改变后重新校验。

与现有编辑历史入口一致，已删除或不可见业务对象的日志不通过普通对象入口暴露。日志不会因为被共享、物化或保存为集合就授予原业务数据权限。

## Scenario 与动态排程

Scenario 内的编辑不进入正式 `edit_history`，因此不会变成已发生的过程转换。带 `scenarioId` 的日志查询仍读取已提交历史，并遵守该视图中的对象可见性。正式合并才记录该 Action 实际提交的变化。

`SchedulePlan.state` 为可选内部业务属性：新准备的计划为 `prepared`，通过 `CommitSchedulePlan` 审查、冲突与排程校验后为 `confirmed`。确认只表示内部计划已接受，结果仍为 `externalCalendarUpdated: false`。已有计划缺少该可选属性时保持未知，首次确认后记录已知状态。

候选搜索继续使用 `findScheduleSlots`，约束校验继续使用 `validateSchedule`，编辑与合并继续使用已有 Actions。拟议活动不会提前成为正式活动或日志；冲突、旧修订或撤权导致合并失败时，正式状态和日志一起保持原值。确认后再次调整但未改变状态的字段编辑仍保存在完整编辑历史中，不伪造新的状态转换。

简单询价或单项服务操作继续直接调用能力，不因为存在日志类型而创建 SchedulePlan、Scenario 或保存 Workflow。只读搜索没有业务状态过程时无需建立 Machinery 过程。询价遇到地点歧义时，才为原 Action 创建确认过程；状态与原任务的等待、确认和最终结果同步提交。原 Action 和地点候选继续使用既有权限；查看确认对象及日志需要单独的对象读取授权。流程挖掘、路径统计、瓶颈分析和定期复盘见 [Machinery 分析](machinery.md)。

## 升级与验证

数据库管理角色先执行现有 `npm run db:upgrade`，在 `edit_history` 增加 nullable 的 `action`、`request_id`、`task_id`、`observed_at` 四列，再按现有候选准备、审核和激活机制发布定义。使用既有历史表授权，查询节点也需要其 SELECT 权限。日志本身不增加写入表。

回归覆盖 `tests/06-worker.test.ts`、`10-scheduling.test.ts`、`12-indexing.test.ts` 与构建后的进程 E2E。测试用合成模型决策替身连接生产 Harness 的真实 MCP 传输，验证发现、直接能力执行、PA 暂停续接、排程、日志查询及显式合并；它不证明真实模型的规划质量。供应商与日历回包明确为合成数据，不代表真实报名、日历写入、叫车或付款。
