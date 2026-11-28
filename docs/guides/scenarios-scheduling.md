# Scenario 与 PA 日历排程

Scenario 为正式 Ontology 提供隔离的对象与关系修改视图。查询和 Function 读取同一视图，Action 的编辑保留在该 Scenario；选定方案后，通过发布的合并 Action 原子写入正式数据。该结构对应 Palantir 的 [Ontology scenarios](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario/) 和 [Merge scenarios](https://www.palantir.com/docs/foundry/ontology/merge-scenario/)。

## 当前能力

- 创建、列出、检查和放弃 Scenario；以 `scenarioId` 调用已有 Query、Function、Action。
- 支持对象创建、修改、删除和关系增删。仅保存修改差量，未修改的数据实时读取当前发布的正式投影，没有复制整库。
- 对象与关系冲突、已改变的方案修订号、权限撤销、过期和跨 owner 请求都会阻止合并。发布更换后需重新建立方案；Scenario 不是历史快照。
- 排程领域包含 `SchedulePlan`、`ScheduledActivity`、`ScheduleResource`、`CalendarAvailability` 及活动、资源、依赖 Links。Functions 计算可用时间并校验冲突，Actions 保存活动与合并方案。[Palantir 排程概念](https://www.palantir.com/docs/foundry/dynamic-scheduling/scheduling-concepts/)
- 第一条排程用例使用用户 PA 提供的个人日历汇总忙闲数据。各计划独立保存所需窗口的日历覆盖，资源身份共享以检查跨计划占用。求解器返回最早可行时段，考虑活动占用、时间窗口和前后依赖。它不执行外部日历写入、邀约、预订或付款，也不声称具备全局优化器或甘特图界面。

## 原任务中的 PA 请求与回传

PA 通过 `submit_task` 提交自然语言需求。EIGOS Agent 从发布目录发现 `SchedulablePlan.prepare`，调用 `PrepareSchedulePlan`。当缺少日历信息时，原任务进入 `input-required`，`result` 包含：

```json
{
  "kind": "pa-request",
  "taskId": "原任务 UUID",
  "requestId": "本次信息请求 UUID",
  "capability": "calendar.freebusy",
  "input": {
    "start": "2026-11-20T09:00:00+08:00",
    "end": "2026-11-20T12:00:00+08:00",
    "timeZone": "Asia/Shanghai",
    "fields": ["busy", "windows"],
    "purpose": "安排 30 分钟会议"
  },
  "responseSchema": "实际响应包含完整 JSON Schema"
}
```

PA 使用自己的 Calendar 接入和用户授权读取日历。凭据留在 PA，默认不传事件标题、参与人、正文。`windows` 表达允许安排活动的时间窗口，`busy` 表达忙碌区间，均使用带时区偏移的绝对时间；区间是 `[start, end)`。PA 须展开周期事件和全天事件、汇总授权范围内的相关日历，并把区间裁剪到请求窗口。

PA 使用 `respond_to_task` 回传。示例中的观测与截止时间须换成实际读取时间；`expiresAt` 不得晚于 `observedAt` 后五分钟。

```json
{
  "taskId": "原任务 UUID",
  "requestId": "本次信息请求 UUID",
  "response": {
    "status": "available",
    "complete": true,
    "start": "2026-11-20T09:00:00+08:00",
    "end": "2026-11-20T12:00:00+08:00",
    "timeZone": "Asia/Shanghai",
    "observedAt": "2026-11-19T18:00:00+08:00",
    "expiresAt": "2026-11-19T18:04:00+08:00",
    "sourceVersion": "PA 的日历读取版本",
    "evidence": "pa_reported",
    "calendars": ["personal-calendar"],
    "windows": [{"start": "2026-11-20T09:00:00+08:00", "end": "2026-11-20T12:00:00+08:00"}],
    "busy": [{"start": "2026-11-20T09:00:00+08:00", "end": "2026-11-20T10:00:00+08:00"}]
  }
}
```

`pa_reported` 表示身份已验证的 PA 报告，不能当成 EIGOS 已独立直连日历供应商的证明。测试使用 `synthetic`。没有完整数据时返回 `status: denied | unavailable | incomplete` 和 `reason`，不要用空 busy 数组代替未知信息。完整且无忙碌事件时，空 busy 数组才代表空闲。

相同请求的相同回传可以重试；改变内容的重复回传、其他 owner 回传、原任务已取消或未在等待该请求时的首次回传均被拒绝。成功回传唤醒原 Worker，继续相同 taskId。同一任务的日历数据请求按规范化时间范围、时区和响应契约识别；Agent 重新表述计划标题不会造成重复请求。

等价协议入口：

| 协议 | 回传方式 |
| --- | --- |
| MCP | `respond_to_task({taskId, requestId, response})` |
| HTTP | `POST /tasks/:taskId/pa-response`，body 为 `{requestId,response}` |
| A2A 1.0 | `SendMessage` 的 `message.taskId` 为原任务 ID，data part 为 `{paResponse: {requestId,response}}` |

这是一套可供 PA 实现的请求／回传协议；没有新增 Google、飞书或 Apple Calendar 凭据托管和后台轮询服务。

## 方案比较与提交

1. `PrepareSchedulePlan` 原子记录 PA 可用时间及计划对象，返回 `SchedulePlan` 引用。对已有计划重规划时，可传入 `plan` 引用并重新向 PA 请求日历。
2. `create_scenario` 返回方案 ID。同一计划可以创建多个 Scenario。
3. 在对应 `scenarioId` 下调用 `findScheduleSlots`，通过 `SaveScheduleActivity` 创建或调整活动。更新已有活动须提交其当前 `revision`；删除使用 `RemoveScheduleActivity`。
4. 用 `validateSchedule` 或 `readSchedulePlan` 检查候选安排。Scenario 可以保留有冲突的方案，冲突以 `hard` 规则结果呈现；缺失或过期日历则直接报错。
5. PA 读取 `inspect_scenario` 的差异和 `revision`，确认选定方案后显式调用 `CommitSchedulePlan({plan,scenarioId,revision})`。Worker Agent 无法绕过此步骤直接写正式活动或合并方案。
6. 合并事务重检当前权限、原对象修订号、关系、日历时效、占用和依赖。并发争用相同时段只能有一个方案成功；校验失败回滚全部业务修改。

Query、Function 和 Action 的 MCP/HTTP 参数都支持可选 `scenarioId`。`list_scenarios` 返回 `items` 和可选 `cursor`，须继续读取 cursor 才能判断列表完整。`discard_scenario` 使用准确的方案 revision。默认 31 天后停止访问；到期差量仍保存在库中用于受管理的清理，不作为历史版本查询接口。

`findScheduleSlots` 默认返回五个候选时段，可调整 `limit` 和 `stepMinutes`。重排已有活动可传 `ignoreActivity`，仅忽略该活动自身的占用，仍检查其前后依赖。当前个人日历资源按同一时刻一个活动处理；请求窗口最多 31 天。现有关系读取上限超出时明确失败，不把部分结果当成完整排程数据。

所有结果包含 `externalCalendarUpdated: false`。任务结果是完成当时的记录；`validation.evaluatedAt`、来源观测时间和有效期指明其适用时间。最终合并重新计算，缓存结果不会替代校验。内部排程提交不代表外部 Calendar 事件已创建。

## 发布与权限

继续使用原 PostgreSQL schema。`npm run db:upgrade` 创建 Scenario、差量、方案 Action 记录和 PA 请求表；由管理角色执行。领域定义通过 `packages/ontology/definition.ts` 合成一个发布，Gateway、Worker 仍使用同一发布引用。

常驻账号保留对 `ontology`、`releases`、`resource_grants`、`property_security` 的 SELECT-only 权限。新增表需要：

- `scenarios`、`scenario_objects`、`scenario_links`、`pa_requests`：SELECT、INSERT、UPDATE。
- `scenario_actions`：SELECT、INSERT。
- 正式活动删除／关系重分配还需要业务表 `objects`、`links` 的 DELETE；不授予发布或授权记录的写权限。

OAuth 的任务读写权限用于原任务及 PA 回传；直接 Scenario 操作使用 `ontology:read/write`。发布新领域后需明确配置用户对新增对象、Functions、Actions 及 `Eigos/source/PACalendar` 的资源授权。可模拟或读取不等于有权合并；`CommitSchedulePlan` 有自己的 Action 授权。

## 验证范围

工程测试覆盖真实 PostgreSQL 事务、权限隔离、时效、原任务恢复、Scenario 冲突与并发合并。进程 E2E 使用独立 Gateway/Worker，MCP 提交、A2A 回传、MCP 检查及显式合并。模型决策和 PA Calendar 都是明确标注的合成夹具。真实用户 PA 的 Calendar 适配、生产部署和真实日历联调需要对应环境验收。

## 时序模型模拟

数值时间序列的属性 schema 使用 JSON 数组和 `format: "eigos-timeseries"`。
标准定义可从 `packages/ontology/time-series.ts` 的
`timeSeriesJsonSchema` 复用。每点包含 ISO 8601 时间 `t` 和数值 `v`。
时间按毫秒严格递增，每个序列最多保存 1 万点。

派生属性可声明 `{op:"timeseries",property:"demandHistory",aggregate:"avg",
window:{size:2,step:1}}`。窗口大小和步长以点数计算，每个结果使用窗口
最后一点的时间。读取沿用原属性的可见性。该表达式由参考查询求值。

把预测契约声明为 `kind: "model"` 的 Function，再由已有的
Function-backed Action 执行。先在 Scenario 中覆盖输入属性，再对该
Scenario 提交模型 Action，预测字段留在该 Scenario。调用
`compare_scenarios` 可对同一指标读取正式数据基线和多个方案修订。
[Vertex Scenario](https://www.palantir.com/docs/foundry/vertex/scenarios-overview/) · [Functions on models](https://www.palantir.com/docs/foundry/functions/functions-on-models/)

## 正式排程的资源占用

确认方案时，Action 在同一事务按计划的当前活动和必要资源更新
`resource_reservations`。时间范围采用左闭右开区间。PostgreSQL 使用
GiST 排他约束拒绝同一资源的重叠预留。若更新与其他持有人冲突，原预留
和本次 Action 的状态一起回滚。排程使用本体和所有者作用域内的资源身份。

数据库升级安装 PostgreSQL 自带的 `btree_gist` 扩展。EIGOS 安装的 upgrade 会读取正式投影中已确认的计划；旧定义缺少状态字段时，通过原 `CommitSchedulePlan` 回执识别。升级在事务内把活动与计划资源恢复为原占用，发现重叠就整次回滚。已有账本记录的计划保留其新占用、暂存或释放状态，重复升级不会重新占用已释放资源。运行角色需要对 `resource_reservations` 的 SELECT、INSERT、UPDATE 及对 `reservation_dispatches` 的 SELECT、INSERT、DELETE。

发布 Action 时可以声明 `reservation: { holderParameter: "holder", allocationsParameter: "allocations", state: "committed" }`。持有人参数必须声明对象类型。每项预留包含 `allocation`、可读的 `resource` 对象引用、`start` 与 `end`。普通 Action 与排程共享同一套 owner 和本体资源键。`sharedSource` 可指定已发布的数据源，调用者还需该源的派发权限；同一源下代表同一共享资源的引用使用跨 owner 的排他键。释放 Action 声明 `state: "released"` 并传入空列表。

需要供应商写入的 Function 继续通过原 `assertDispatch` 和外部操作记录请求。在原派发事务内暂存新旧占用区间的并集。供应商结果未知时，账本保留两组区间并将变更绑定原请求。核对原回执后由原 Action 提交最终占用或释放。独立请求不能替尚未核对的供应商请求释放资源。Scenario 只在正式合并事务写入账本。

若供应商确认来自提交后的外发副作用，发布者可在预留声明加 `confirmationEffect`，指向同一 Action 已声明的效果名称。在原 Action 和外发意图提交时保留新旧区间；只有该效果的成功确认事务会切换到最终占用。可确定没有执行的取消恢复旧占用，未知结果保留预留并沿用原幂等键重试。需要外部确认的操作经原正式 Action 提交及授权；普通 Scenario 的预留在合并时检查。普通 Action 撤销会在同一事务核对原预留日志并恢复可用区间。已经完成的供应商操作需通过授权的补偿 Action 处理。
