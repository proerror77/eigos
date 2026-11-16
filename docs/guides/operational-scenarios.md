# 排程、自动化预演和评估送审

本轮映射 Palantir 的 [Dynamic Scheduling](https://www.palantir.com/docs/foundry/dynamic-scheduling/scheduling-overview)、[Scenario 自动化](https://www.palantir.com/docs/foundry/automate/automations-on-ontology-scenarios)、[Scenario 生命周期](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario)、[分支 Action 试跑](https://www.palantir.com/docs/foundry/action-types/branching-action-types)、[Machinery 历史接入](https://www.palantir.com/docs/foundry/machinery/connect-data)、[流程分析输出](https://www.palantir.com/docs/foundry/machinery/analyze-and-monitor) 和 [AIP Evals](https://www.palantir.com/docs/foundry/aip-evals/overview)。

## 动态排程

工作台排程保留拖动时间轴，也能选择多个活动计算联合建议。`recommendSchedule` 在授权计划和日历覆盖上搜索，目标可选最少时间移动或最早完成。所有选中活动一起分配时段，考虑计划内依赖、必需日历的交集、忙区间及其他计划占用同一资源的固定活动。活动保留现有固定资源集合和时长。搜索使用时间网格，也考虑现有时段；结果会区分网格最优、受预算限制的可行解、不可行和未找到解。

`StageScheduleRecommendation` 在 Scenario 里按活动修订原子调整一组活动并执行正式约束校验。行程活动和依赖已核实餐饮证据的活动继续使用自己的领域 Action。确认仍经过 `CommitSchedulePlan` 和最新忙闲、依赖及权限复核。

## 自动化规则预演

在「自动化」选择规则的「预演」，或调用 MCP `ontology_preview_automation`。请求提供规则及多个 Scenario 的准确修订。对象规则比较相对于当前本体基线新进入条件的实例。过程规则检查方案差量中的状态转换，`elapsedSeconds` 用于检查停留条件。所有步骤复用实际 Workflow 输入绑定与 Action 校验。每个实例在保存点内预演，随后回滚。含外部请求的 Action 可能被离线校验拒绝。需要 Agent 生成新认知提案的流程会返回 `proposal_required`，此阶段仍需要原提案输入。预演不会写入正式 Workflow 队列或变更启用状态。

## 跨发布接续和候选试跑

`ontology_scenario_continuation_sources` 查找所属账号未过期的上一发布草稿和当前临时 Scenario。`ontology_continue_scenario` 根据可核对的 Action 日志，将兼容的差量接续为一个新持久 Scenario，保留源记录和审阅邀请。新 Scenario 需要重新批准；既有批准不会随草稿转移。如果属性、关系基数、Action 契约、Function 绑定或权限有冲突，整个接续回滚。

具备定义编辑权限的用户可向 `ontology_trial_candidate_scenarios` 提交由当前发布准备的候选摘要和试跑输入。候选基线和事务固定，允许在临时 Scenario 中调用登记的离线 Action。试跑后回滚，不激活候选发布。正式写入仍通过活动发布上的已授权 Action。

## Machinery 历史与试跑送审

`ontology_ingest_machinery_history` 导入外部历史，需对声明来源具备 `ingest_source` 和 `read_source`，每条记录携带稳定事件 ID、目标业务对象、前后状态及来源观察时间。相同内容重试幂等，冲突整批拒绝。记录保留独立来源及对象权限边界。分析用 `externalSource` 选择导入来源，使用来源观察时间；历史导入不改业务状态，也不触发正式自动化。分析可设置最多 100,000 条记录的 `eventLimit`，超出预算必须缩小过滤范围。

Workbench 的 Machinery 把当前分析筛选命中的所有可读实例保存为静态 Object Set，也可调用 `ontology_save_machinery_cases`。在工作台可从保存的对象集直接打开试跑，或用 `ontology_evaluation_cases_from_set` 载入有权读取的实例引用和当前修订，再为每个案例配置步骤、指标和补充证据。评估集保存具名试跑配置和修订，支持重跑并留下绑定发布、案例输入摘要与候选结果的回执。每个绑定 Machinery 对象集的案例都必须引用集合中的对象。选定通过的候选后，`ontology_promote_evaluation_candidate` 复核回执、当前证据修订和业务时间，再创建带独立审阅者的持久 Scenario。实际写入仍由批准后的正式合并 Action 执行。

## 部署

管理角色先运行 `npm run db:upgrade`。Gateway 角色需要对 `machinery_history`、`scenario_evaluation_suites`、`scenario_evaluation_runs` 有 SELECT、INSERT 权限，以及对 `scenario_evaluation_suites` 有 UPDATE 权限。启用数据库 owner 隔离的环境随升级重新安装隔离策略 (`npm run db:enable-owner-isolation`)，然后按现有审核与激活流程发布 Ontology 定义。
