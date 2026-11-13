# 来源索引、编辑历史与物化

发布的 datasource mapping 定义来源行如何转换为对象。来源生产者提交带有 `source`、`stream`、`offset`、`observedAt` 的事务，独立索引进程消费事务并写入当前发布的对象投影。每条事务记录提交身份、发布版本、内容摘要、应用进度和失败次数。身份来自已认证请求，返回的 `authenticated_producer` 表示该身份提交的数据。

## 来源事务

`Indexing.submit(access, model, input)` 支持 `batch` 和 `stream` 两种入口标记，两者均按事务整体提交。一个来源事务包含最多 1000 个映射前的 `rows` 和最多 1000 个删除主键 `deleted`。`batch` 表示一批显式增删数据，完整快照的生产者应把消失的主键放入 `deleted`。

每个 owner、Ontology、datasource、stream 组合从 offset 1 开始连续递增。提前到达的 offset 会等待前序事务，完全相同的重传返回既有事务，改变内容的重传被拒绝。应用事务把对象编辑、历史和 applied offset 一起提交。进程退出时数据库回滚并释放领取锁，下一次消费可继续。失败事务保留错误类型并阻止同一 stream 的后续事务，`retry` 在校验当前授权和原始发布后重试相同内容。

生产者必须拥有 datasource 的 `ingest_source` 授权，以及对应来源的 `read_source` 授权。普通成员默认授权不包含 `ingest_source`。Worker 在实际消费时重新加载原始提交身份的当前授权，授权撤销会阻止写入。

`cancel` 允许原始生产者在当前授权有效时取消 pending 或 failed 事务。取消可重复提交，已应用的事务会拒绝取消。Worker 按顺序跳过取消的事务并推进 offset，后续事务继续消费。取消的旧发布事务也可在发布切换后推进，整个过程不会执行其来源编辑。

`Indexing.runOne()` 供单次消费和测试使用，`Indexing.run(signal)` 通过 PostgreSQL 通知唤醒并定期检查队列。多个索引进程通过行锁分摊独立事务，同一 stream 保持顺序。状态接口显示当前 offset、已应用 offset、应用时间和重试次数。

## 来源值与用户编辑

对象保存的值由来源基线与用户逐属性编辑合成。`source_values` 按来源保存基线，`object_edits` 保存编辑值、编辑时间和删除标记。`Objects` 的创建、修改、删除与来源入库在同一个事务内调用这些规则，并写入不可变的 `edit_history` 记录。

| 策略 | 合成行为 |
| --- | --- |
| `user_wins` | 已编辑的属性持续采用用户值，其他属性接收新来源值。默认使用此策略。 |
| `latest_value` | 逐属性比较来源观察时间与用户编辑时间。没有来源值的编辑属性仍保留用户值。 |

管理员通过 `setConflictPolicy` 配置类型策略，后续来源事务按新策略重新合成。相同来源观察时间对应不同内容会报冲突，更旧的观察不会覆盖新值。用户删除留下 tombstone，来源刷新保持删除状态，显式创建才重新建立对象。来源删除只移除该来源基线，之后的新来源观察可以重新创建对象。

旧对象首次编辑时保留当时的基线，因此升级前的数据可继续参与合成。发布准备与追赶通过 `copyEditState` 复制当前来源和用户编辑状态，包含有效类型的 tombstone。历史读取跨同一 Ontology 的发布保留连续性，并根据当前对象可见性和历史行的属性策略过滤内容。

## 物化

`Materializations.capture` 在可重复读事务中保存选定对象类型的最新合成值和类型间关系。来源值与用户编辑已经由对象运行层合成，物化保存捕获时的结果。调用者提交 `requestId`、`name` 和 `types`，相同请求可安全重传。单次物化最多 10000 个对象，超过上限会明确失败并回滚。

`read` 和 `links` 提供分页读取。每次读取都检查当前实例权限，并依据历史行的策略字段和 markings 重新过滤历史值。快照保留完整策略上下文，当前不可见的属性返回 null。删除的正式对象从物化读取中隐藏。物化绑定原始发布，发布改变后需要重新捕获，以使用新的定义解释结果。

## 存储升级与权限

初始化函数为现有 PostgreSQL schema 添加 `source_values`、`object_edits`、`edit_policies`、`edit_history`、`index_streams`、`index_transactions`、`materializations`、`materialized_objects` 和 `materialized_links`。

数据库管理角色执行初始化和 `edit_policies` 配置。运行角色需要来源与编辑状态表的 SELECT、INSERT、UPDATE、DELETE，历史表的 SELECT、INSERT 及其 identity sequence 的 USAGE，索引表的 SELECT、INSERT、UPDATE，物化表的 SELECT、INSERT。发布管理角色还需要复制候选状态时的写权限。公开读取都经过运行服务的对象与属性权限判断。

回归覆盖顺序消费、精确重传、授权撤销后的回滚和恢复、两类冲突策略、用户及来源删除语义，以及物化历史值在属性权限变化后的重新过滤。
