# 长期观察合同

当前实现保存明确委托的观察合同，并创建独立的暂停守护任务。它属于动态感知第一阶段；持续读取、Webhook 接收、长期调度、局部修复和日历接入尚未启用。回读固定包含 `monitoring:false`、`activation:observer_not_installed` 和 `targetIdentity:unverified`。配置成功不能表示正在监控。

## 准备合同

Foundation 模式的 MCP 工具 `prepare_observation_contract` 接受 `action:prepare_observation_contract`，以及以下内容。所有引用使用当前实际读取到的值。

| 字段 | 含义 |
| --- | --- |
| originalTaskId、expectedRevision | 当前可读、已完成的原任务及其当前 revision；不改写原任务 |
| requestId、goal | 本次明确的观察委托及幂等键；完成业务不自动推定长期委托 |
| source | 原任务发布中的 serviceId、mappingId，以及期望的 expectedSourceAccount、expectedNativeId |
| target | 可读对象、准确 revision、来源映射提供的 fields，以及可选映射关系 relations |
| read | 已发布、已配置且当前获准的只读动作，以及匹配该动作 schema 的输入；不传凭据 |
| startsAt、until | 明确起止；一期最多覆盖未来 24 小时，受当前安装和来源许可的更早期限限制 |
| maxStalenessMs、strategy | 失鲜上限及 poll.intervalMs 或 push.maximumSilenceMs；间隔不能超过失鲜上限，失鲜上限不能超过映射上限 |
| terminal | horizon_only，或选定标量字段的 source_evidence 条件；后者必须声明 proof:independent_read |
| perReadBudget | 单次 timeoutMs 与 maxCost（minor/currency） |
| lifetimeBudget | 累计 maxReads、maxModelTurns、maxActiveMs、maxCost；恢复或重启不能清零 |

动作定义、数据字段、来源许可和对象版本分别检查。原任务的权限用于核对本次选择，不复制到守护任务。新守护任务只有自己的读取与控制许可，inputs、outputs 均为空，不签发 Worker 执行 authority。合同、任务、许可和幂等记录在同一业务事务内提交，验证失败整体回滚。

期望账号、原生 ID 和读取输入进入合同，**尚未证明与供应商的真实目标一致**。一期核验 schema、可见引用与当前来源权限；后续可信读取适配器必须在启动前绑定账号、对象身份、输入、原生排序域及来源回读。`sourcePermission:current` 仅描述权限，不证明供应商可用、身份已验证或已有新事实。费用上限也不构成支出或其他业务效果许可。

## 回读和撤销

MCP 用新守护任务 ID 调用 `get_task`，A2A `GetTask` 返回同一个任务。`observation` 只包含状态、期限、策略、预算和累计用量；期望账号、原生 ID、输入值、对象值和私有证明不返回。`nextDueAt` 是合同声明的首次读取时间，不是已排队或已执行的承诺。

A2A `SendMessage` 的结构化 data 使用同样的 action 和参数：`message.taskId` 为原任务，`message.messageId` 作为 requestId，contextId 若提供须匹配原任务；data.originalTaskId 若提供也必须一致。返回新的守护任务，原任务仍是 completed。回读在 `metadata.observation`；`metadata.internalState:paused` 表示观察尚未启动。

MCP `cancel_task` 或 A2A `CancelTask` 撤销守护合同。撤销增加 revision 与 revocationRevision，保留原声明、版本、预算和用量，追加不可修改的审计事件。相同准备请求在撤销后重放，仍返回原已撤销任务，不建立新窗口。`resume_task`、回复或修正不能激活合同；改变观察条件需新的明确委托。

原期限结束且控制读取许可仍有效时，回读显示 expired、monitoring:false，不据此宣告业务完成。安装、通道或控制许可失效时沿用现有授权拒绝。来源被撤销时，可读合同显示 sourcePermission:unavailable，仍可用守护任务的控制许可撤销合同。累计用量在一期保持零，因为尚无观察执行器。

合同与审计沿同一业务 SQLite 持久化，原任务、计划、来源证据及本体发布不改写。离线合库保留两张观察元数据表，旧合同不因此激活。后续实现继续遵守[态势感知约束](../architecture/situation-awareness.md)。
