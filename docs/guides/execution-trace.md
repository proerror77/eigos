# 执行因果记录

通过 `POST /ontology/services/execution_trace` 或 MCP `ontology_execution_trace` 传入 `{ "taskId": "..." }` 或 `{ "requestId": "..." }`。读取需要同一 owner 的已验证身份、`tasks:read`、`ontology:read` 和该本体的定义权限。Action 还需当前的调用权限。该机制参考 Palantir 的[执行追踪](https://www.palantir.com/docs/foundry/aip-observability/trace-view)和[流程权限关系](https://www.palantir.com/docs/foundry/workflow-lineage/manage-security)。

- 来源记录带已入库回执引用与原读取身份。Action 提交事务内投影的来源按原请求 ID 关联，回执可见时返回当前有权读取的证据标记。文档证据采用该版本的对象引用。模型与出站决策记录状态、策略摘要和获准披露的引用。
- Scenario 审阅记录绑定方案修订号、审阅摘要和已验证的审阅者身份。正式合并记录使用的准确版本、摘要与 Action 申请 ID。修订后旧记录仍可核对。
- Action 状态和执行者身份取自提交日志。结果对象可见时返回 `resultRef`。旧提交可通过同一发布、同一请求的编辑历史关联回原任务。外部回执与投递状态取自原事务和 outbox。
- `action-read` 记录正式 Action 提交后的结果 Function 成功返回。重读沿用原请求 ID，只记录本次读回，结果内容留在原调用。回执已确认、Action 已提交和结果 Function 已读回各有独立证据。
- 身份、字段、行权限和来源权限在读取时复核。接口只返回必要引用、状态和摘要。原始供应商结果、业务编辑正文、提示词和凭据由各自的原存储与权限保护。

`after` 是上一页返回的 `next`，`limit` 为 1 至 100。每页读取同一关联系统记录，编辑、Actions、回执和投递分别有 100 条读回上限。历史任务与已有提交日志仍可读取，关联来自原运行时已经记录的证据。

上线前执行现有 `db:upgrade`。Gateway、Worker 和执行 Action 的 Indexer 角色需要按职责配置 `execution_trace` 的 SELECT、INSERT 和对应 identity sequence 的 USAGE。所有这些主体继续沿用既有 Action、编辑历史、来源和投递表权限。启用 PostgreSQL owner 隔离的环境应重新安装策略，覆盖新表。

## MCP 返回计时

Gateway 将 `submit_task`、`get_task` 和 `complete_with_action` 的 HTTP 返回计时以 `mcp_request` JSON 行写入服务日志。每次调用独立记录，适用于 Grok 和其他 MCP 客户端的正常问法。计时从 Gateway 收到 HTTP 请求开始，包含请求解析、认证和响应发送，不增加数据库查询。

| 字段 | 含义 |
| --- | --- |
| `mcpRequestId`、`clientId`、`tool` | 单次请求标识、已验证的 OAuth 客户端和 MCP 工具。客户端可用 HTTP 响应头 `X-EIGOS-MCP-Request-Id` 对齐自己的记录 |
| `receivedAt`、`toolStartedAt`、`toolFinishedAt`、`finishedAt` | Gateway 收到请求、开始工具回调、结果序列化或错误处理完成、HTTP 响应结束的 UTC 时间。`durationMs` 使用单调时钟计算整次 Gateway 请求耗时 |
| `transport`、`httpStatus`、`toolStatus` | `sent` 表示服务端将响应交给传输层，`closed` 表示在此之前连接关闭。HTTP 状态与工具状态分别记录 |
| `taskId`、`taskState`、`taskCreatedAt`、`resultIncluded`、`taskCompletedAt` | 任务型工具返回的已授权快照。创建和完成时间取自任务记录。单次 Action 调用也记录是否返回结果 |

从 Gateway 日志按任务 ID 查看轮询。`gateway_container` 填运行中的 Gateway 容器名，`task_id` 填查询返回的 ID。

```sh
docker logs "$gateway_container" 2>&1 | jq -Rc --arg id "$task_id" \
  'fromjson? | select(.event == "mcp_request" and .taskId == $id)'
```

找第一次 `get_task` 同时返回 `taskState=completed`、`resultIncluded=true` 和 `transport=sent` 的记录。用 `taskCompletedAt`、`receivedAt` 和 `finishedAt` 对齐任务完成、取回请求和 Gateway 发送。`finishedAt` 到客户收到结果之间还经过网络和客户端传输。Grok 收到工具结果、开始生成回复及显示报价的时间需要由客户端侧记录。

## 执行阶段计时

Worker 领到任务时写 `worker_claim`，运行结束时写 `worker_finish`。两行和执行阶段的 `stage_timing` 共用 `taskId` 和本次领取的 `workerRunId`。`taskCreatedAt`、`taskAvailableAt` 和 `taskClaimedAt` 来自 PostgreSQL，同一笔任务首次领取时可以分别算出合批等待与进入可执行状态后的排队时间。恢复和重试各有独立的 `workerRunId`。`worker_finish.taskState` 表示本次的已提交结果，`uncommitted` 表示未能提交状态。

| `stage_timing.stage` | 时间范围 |
| --- | --- |
| `model_session`、`agent_tool` | EIGOS 驱动模型会话和各工具的时间。模型会话包含等工具的时间，可以用首个 `agent_tool.startedAt` 看模型启动到第一次选择工具经过多久 |
| `action_apply`、`result_read` | 发布的 Action 提交与结果 Function 的读回 |
| `didi_read`、`didi_rpc` | 每个滴滴工具的连接器执行耗时，以及其中的 MCP 工具调用耗时。两次地点读取可能并行 |

在 Worker 容器里用同一个任务 ID 查看阶段。单次 `complete_with_action` 的阶段在 Gateway 日志里，用同一个 `mcpRequestId` 查询。

```sh
docker logs "$worker_container" 2>&1 | jq -Rc --arg id "$task_id" \
  'fromjson? | select(.taskId == $id and (.event == "worker_claim" or .event == "worker_finish" or .event == "stage_timing"))'

docker logs "$gateway_container" 2>&1 | jq -Rc --arg id "$mcp_request_id" \
  'fromjson? | select(.mcpRequestId == $id and (.event == "mcp_request" or .event == "stage_timing"))'
```

阶段记录包含 UTC 起止时间和单调时钟计算的 `durationMs`，可按 `startedAt` 排列。同一调用内会有嵌套和并行阶段，按起止时间读取关键路径。用 Grok 的消息发送和报价显示时间对齐首条和末条 Gateway 记录，可量出 EIGOS 边界外的时间；Grok 内部阶段仍需客户端日志。

日志只保存调用元数据。凭据、提示词、入参与报价内容留在原调用的权限边界内。
