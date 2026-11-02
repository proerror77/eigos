# 长期观察合同

当前实现保存明确委托的观察合同，并创建独立的暂停守护任务。准备合同仍不启动监测。第二阶段提供经审查的只读适配器绑定、持久接收与 Worker 调度；没有安装该来源的适配器时激活失败。通用供应商 Webhook、局部修复及日历接入仍未启用。配置或激活成功都不能代替实际的新鲜回读。

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

期望账号、原生 ID 和读取输入进入合同，**尚未证明与供应商的真实目标一致**。准备阶段核验 schema、可见引用与当前来源权限；激活时，已安装的可信适配器从受信配置及当前可读数据绑定账号、对象身份与原生排序域，随后必须完成独立回读。`sourcePermission:current` 仅描述权限，不证明供应商可用、身份已验证或已有新事实。费用上限也不构成支出或其他业务效果许可。

## 回读和撤销

MCP 用新守护任务 ID 调用 `get_task`，A2A `GetTask` 返回同一个任务。`observation` 只包含状态、期限、策略、预算和累计用量；期望账号、原生 ID、输入值、对象值和私有证明不返回。准备状态的 nextDueAt 仅为声明的首次时间；已激活状态为持久的下次读取时间，仍须检查新鲜度和当前权限。

A2A `SendMessage` 的结构化 data 使用同样的 action 和参数：`message.taskId` 为原任务，`message.messageId` 作为 requestId，contextId 若提供须匹配原任务；data.originalTaskId 若提供也必须一致。返回新的守护任务，原任务仍是 completed。回读在 `metadata.observation`；`metadata.internalState:paused` 表示观察尚未启动。

MCP `cancel_task` 或 A2A `CancelTask` 撤销守护合同。撤销增加 revision 与 revocationRevision，保留原声明、版本、预算和用量，追加不可修改的审计事件。相同准备请求在撤销后重放，仍返回原已撤销任务，不建立新窗口。`resume_task`、回复或修正不能激活合同；改变观察条件需新的明确委托。

原期限结束且控制读取许可仍有效时，回读显示 expired、monitoring:false，不据此宣告业务完成。安装、通道或控制许可失效时沿用现有授权拒绝。来源被撤销时，可读合同显示 sourcePermission:unavailable，仍可用守护任务的控制许可撤销合同。准备状态用量保持零。激活后每次来源调用前扣除一次读取及已审查适配器的最大费用，并保守占用单次超时上限的 activeMs；崩溃、失败或迟到不会释放这部分预算。它是预算占用，不是银行收费或精确 CPU 时间。

合同与审计沿同一业务 SQLite 持久化，原任务、计划、来源证据及本体发布不改写。离线合库保留合同、运行、收件箱、读取账本、通知和不可修改回执；旧记录不因此激活。后续实现继续遵守[态势感知约束](../architecture/situation-awareness.md)。


## 显式激活与通知

MCP `activate_observation_contract` 接受 action 同名、taskId（守护任务）、expectedRevision（守护任务当前 revision）及 requestId。A2A 向该守护任务发送同名 action 的 data；messageId 作为 requestId，taskId 必须一致。普通 resume_task 继续不用于观察激活。重新激活保留原期限与累计占用，已耗尽预算不能恢复；不能借此替换来源、映射、账号或输入。

来源程序必须安装 reviewed `sourceObserver`。它的同步 bind 不做网络或模型调用，不能把调用者的期望身份当成已证明事实；返回绑定须与期望账号/原生 ID、映射及已有的 pipeline 规范实体 ID 一致。不支持的旧身份表示直接拒绝，不创建另一套同名实体。读取适配器只得到固定目标、输入、原读取身份、取消信号和当前权限检查，不获得模型、图写入或业务执行器。当前代码未给真实供应商默认开启此适配器；验收使用合成来源。

每次调用前及接收/采纳时重新核对控制许可、当前安装与来源、平台动作/字段/通道限制、发布与适配器摘要、期限、代次和租约。观察使用既有 work_claims、两调用总上限、心跳、取消及截止保护，不获得通用 Agent 业务执行 authority。规范来源更新由受控 producer 写入同一业务库，不自动更新任何消费者的数据许可。

读取在事务外完成；可信回包先进入持久收件箱。采纳时将去重/版本或冲突处理、规范事实/关系及来源证明、依赖失效、任务唤醒、读取回执一并提交。该事务失败仍保留原收件箱，重启后处理原项，不重复访问来源。原已完成任务不重开。没有原生版本时只能使用独立回读与读取开始时修订；不把到达时间当成供应商顺序。

MCP `report_observation_change`（或 A2A 同名 action）接受 taskId、requestId、eventId、contentDigest。它只接收当前 PA 的提示，不接收事实属性、账号、凭据或完成证据。同事件同摘要幂等，同事件异摘要拒绝；提示持久唤醒已绑定的读取。提示到达正在读取期间时，旧读取不能消耗新提示。该入口不是通用供应商 Webhook 认证实现。

只有独立回读已采纳、来源事实仍新鲜、下次读取未失约、当前权限有效且没有未核实提示时，monitoring 才为 true。targetIdentity 在实际回读校验前为 unverified；runtime.state/health、lastObservedAt 和 pendingChanges 提供裁剪状态。断流、未读到期、错账号、乱序和冲突不能继续标为有效监测。连续三次无进展失败暂停，预算耗尽也暂停；不调用模型解释这些技术状态。

取消、撤权、旧代次、失效租约或超时后的回包只留不可修改的迟到审计，不改写当前事实或业务结果。到期或观察到独立终点证据结束该运行，但守护任务不据此宣告用户到场、订单完成或其他实际履约。后续影响评估、组件修复与真实日历验收仍按闭环计划分阶段完成。
