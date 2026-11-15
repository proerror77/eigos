# 执行因果记录

通过 `POST /ontology/services/execution_trace` 或 MCP `ontology_execution_trace` 传入 `{ "taskId": "..." }` 或 `{ "requestId": "..." }`。读取需要同一 owner 的已验证身份、`tasks:read`、`ontology:read` 和该本体的定义权限。Action 还需当前的调用权限。该机制参考 Palantir 的[执行追踪](https://www.palantir.com/docs/foundry/aip-observability/trace-view)和[流程权限关系](https://www.palantir.com/docs/foundry/workflow-lineage/manage-security)。

- 来源记录带已入库回执引用与原读取身份。文档证据采用该版本的对象引用。模型与出站决策记录状态、策略摘要和获准披露的引用。
- Scenario 审阅记录绑定方案修订号、审阅摘要和已验证的审阅者身份。正式合并记录使用的准确版本、摘要与 Action 申请 ID。修订后旧记录仍可核对。
- Action 状态和执行者身份取自提交日志，编辑序号取自现有 Edit History，外部回执与投递状态取自原事务和 outbox。重试沿用已有操作 ID。外部回执已确认与 Action 已提交分别呈现。
- 身份、字段、行权限和来源权限在读取时复核。接口只返回必要引用、状态和摘要。原始供应商结果、业务编辑正文、提示词和凭据由各自的原存储与权限保护。

`after` 是上一页返回的 `next`，`limit` 为 1 至 100。每页读取同一关联系统记录，编辑、Actions、回执和投递分别有 100 条读回上限。历史任务与已有提交日志仍可读取，关联来自原运行时已经记录的证据。

上线前执行现有 `db:upgrade`。Gateway 需要 `execution_trace` 的 SELECT 权限，执行来源、模型及审核的角色需要 INSERT 和对应 identity sequence 的 USAGE。所有这些主体继续沿用既有 Action、编辑历史、来源和投递表权限。启用 PostgreSQL owner 隔离的环境应重新安装策略，覆盖新表。
