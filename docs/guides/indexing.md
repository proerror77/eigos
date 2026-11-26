# 来源索引、编辑历史与物化

发布的 datasource mapping 定义来源行如何转换为对象。来源生产者提交带有 `source`、`stream`、`offset`、`observedAt` 的事务，独立索引进程消费事务并写入当前发布的对象投影。每条事务记录提交身份、发布版本、内容摘要、应用进度和失败次数。身份来自已认证请求，返回的 `authenticated_producer` 表示该身份提交的数据。

## 来源事务

`Indexing.submit(access, model, input)` 支持 `batch` 和 `stream` 两种入口标记，两者均按事务整体提交。一个来源事务包含最多 1000 个映射前的 `rows` 和最多 1000 个删除主键 `deleted`。`batch` 表示一批显式增删数据，完整快照的生产者应把消失的主键放入 `deleted`。

每个 owner、Ontology、datasource、stream 组合从 offset 1 开始连续递增。提前到达的 offset 会等待前序事务，完全相同的重传返回既有事务，改变内容的重传被拒绝。应用事务把对象编辑、历史和 applied offset 一起提交。进程退出时数据库回滚并释放领取锁，下一次消费可继续。失败事务保留错误类型并阻止同一 stream 的后续事务，`retry` 在校验当前授权和原始发布后重试相同内容。

生产者必须拥有 datasource 的 `ingest_source` 授权，以及对应来源的 `read_source` 授权。普通成员默认授权不包含 `ingest_source`。Worker 在实际消费时重新加载原始提交身份的当前授权，授权撤销会阻止写入。

`cancel` 允许原始生产者在当前授权有效时取消 pending 或 failed 事务。取消可重复提交，已应用的事务会拒绝取消。Worker 按顺序跳过取消的事务并推进 offset，后续事务继续消费。取消的旧发布事务也可在发布切换后推进，整个过程不会执行其来源编辑。

`Indexing.runOne()` 供单次消费和测试使用，`Indexing.run(signal)` 通过 PostgreSQL 通知唤醒并定期检查队列。多个索引进程通过行锁分摊独立事务，同一 stream 保持顺序。状态接口显示当前 offset、已应用 offset、应用时间和重试次数。

## 来源值与用户编辑

对象保存的值由来源基线与用户逐属性编辑合成。`source_values` 按来源保存基线，`object_edits` 保存编辑值、编辑时间和删除标记。`Objects` 的创建、修改、删除与来源入库在同一个事务内调用这些规则，并写入不可变的 `edit_history` 记录。关系增删写入 `link_history`。两类历史行都记录所属事务，提交时在 `change_commits` 中按 owner 获得提交序号，消费者据此按提交顺序读取。`link_history_commit` 索引按事务和关系类型查找关系历史，供规则判断提交是否触及它的依赖范围。

| 策略 | 合成行为 |
| --- | --- |
| `user_wins` | 已编辑的属性持续采用用户值，其他属性接收新来源值。默认使用此策略。 |
| `latest_value` | 逐属性比较来源观察时间与用户编辑时间。没有来源值的编辑属性仍保留用户值。 |

一批来源行在同一事务内一起合成：批量读取当前对象、来源基线、用户编辑和类型策略，按输入顺序逐个对象应用上述规则，再批量写回基线、编辑历史与对象。语句数不随对象数增长，批次持有编辑锁的时间随之缩短。管理员通过 `setConflictPolicy` 配置类型策略，后续来源事务按新策略重新合成。相同来源观察时间对应不同内容会报冲突，更旧的观察不会覆盖新值。用户删除留下 tombstone，来源刷新保持删除状态，显式创建才重新建立对象。来源删除只移除该来源基线，之后的新来源观察可以重新创建对象。

旧对象首次编辑时保留当时的基线，因此升级前的数据可继续参与合成。发布准备与追赶通过 `copyEditState` 复制当前来源和用户编辑状态，包含有效类型的 tombstone。历史读取跨同一 Ontology 的发布保留连续性，并根据当前对象可见性和历史行的属性策略过滤内容。

## 变化订阅（Funnel 05.4）

`ChangeSubscriptions`（`packages/runtime/change-subscriptions.ts`）让订阅方只在相关提交之后被唤醒，不漏，也不重复。

- **订阅：**
  - 订阅由足迹和位置组成。足迹是一组对象类型和链接类型，也可以给出一个 Object Set 查询，由 `queryFootprint` 推出它的派生属性读取的类型和链接；位置是这个 owner 已经唤醒过的最后一个提交。
  - 订阅时，位置从 owner 的最新提交开始。
  - 主体必须能读取每个被订阅的类型，能看到每个被订阅的链接，并且有 `tasks:write`，因为每次唤醒都是一个任务。
  - 同一个 `requestId` 再次订阅，得到的是同一个订阅。
- **唤醒：**
  - Indexer 的扫描每秒最多检查每个订阅一次，用 `footprintChanges` 读取位置之后的提交窗口，每次最多 500 个提交。
  - 窗口里有提交改动了足迹，就以订阅的主体身份，在订阅的会话里提交一个唤醒任务。任务的消息是 JSON：`{ event: 'ontology_changes', subscription, commits: { after, through }, types, links }`，其中 `types` 和 `links` 是窗口改动到的那一部分足迹。
  - 没有改动足迹的提交，只推进位置。
- **不漏、不重复：**
  - 唤醒任务的 `requestId` 是 `subscription:<id>:<after>`。位置推进在提交这个任务的同一个事务里完成，条件是位置还是读到的值。
  - 并发的分发器读到同一个起点时，只有一个能推进位置，另一个的任务按 `requestId` 去重，窗口因此首尾相接。
- **权限：** 唤醒任务按订阅主体此刻的权限重新读取数据，订阅本身不保存数据。
- **接口：** `subscribe(access, model, input)`、`cancel(access, id)`、`list(access)`。Agent 的唤醒（06.5）和 Machinery 的局部重规划（M3）建在它之上。

## 重放验收（Funnel 05.5）

`replay-check` 检查提交日志能否解释活动投影中的行，只读，在一个 REPEATABLE READ 快照里完成：

```bash
DATABASE_URL=… node --import tsx scripts/ontology.ts replay-check [--owner=<subject>] [--show-identifiers]
```

- **做法：** 按提交顺序重放这个投影的 `edit_history` 和 `link_history`。
  - 每个对象取最后一次已提交的写入：写入后的完整值，删除则为无；每条关系取最后一次 `link` 或 `unlink`。
  - 再与 `objects`、`links` 表比对。
  - 提交顺序就是 owner 的提交序号。提交日志建立之前的历史没有序号，按 `sequence` 排在最前，与消费者的读取顺序相同。
- **每个类型和每个关系类型的计数：**
  - `matched`：表中就是最后一次写入的结果；
  - `differs`：表中的值与最后一次写入不同；
  - `missing`：最后一次写入创建或修改了它，表中却没有；
  - `resurrected`：最后一次写入删除了它，表中仍然存在；
  - `carried`：这个投影的历史里没有它。这些行是发布时复制进来的，不参与比较。在日志之外直接写入的行，也会落在这一类。
- **输出：** 前三类以外都算一致。有不一致时，命令以状态码 1 退出，并列出最多 20 个例子。owner 和 id 默认输出哈希，`--show-identifiers` 输出原值。
- **owner 隔离：** 开启 owner 隔离时，运行时角色只能读取当前 owner 的行，所以要用 `--owner` 逐个检查；或者用可以绕过行级安全的只读角色检查全部 owner。

## 提交日志保留

`edit_history`、`link_history` 和 `change_commits` 保留 90 天，更早的按 owner 和月份归档为 Parquet，归档后仍可查询。这是用户 2026-11-27 采纳的建议。归档默认不运行，由维护命令执行：

```bash
EIGOS_ARCHIVE_BIN=…/eigos-archive DATABASE_URL=…postgres… node --import tsx scripts/ontology.ts archive-logs --archive=<目录> [--days=90] [--owner=<subject>] [--dry-run] [--limit=<月数>]
node --import tsx scripts/ontology.ts audit --owner=<subject> [--table=edit_history|link_history] [--type=… --id=… --request=… --task=… --from=… --to=…] --archive=<目录>
```

### 哪些行会归档

一个 owner 的一个月，只有同时满足下列条件时才归档：

- **时间：** 整个月都早于保留期，例如保留 90 天时，只归档截止日所在月份之前的月份。
- **消费方：** 这个月所有提交都早于该 owner 的边界。边界取下列位置中最早的一个，即任何消费方还没读到的位置：
  - 保留期之后的第一个提交；
  - 未取消的变化订阅的 `position`；
  - 打开的持久 Scenario 的 `sync_position`；
  - 启用的对象规则的位置（过程规则的 `process_commit`、对象集规则的 `match_commit`）。

  一个月被挡住时，之后的月份也等待，归档和保留的历史之间不留空洞。
- **ProcessLog：** 任何活动或已退役发布里有 ProcessLog 跟踪的对象类型，其 `edit_history` 行不归档。这些行就是 ProcessLog 对象，Machinery 最多分析 366 天，所以它们留在表里。
- **提交记录：** 只有不再被保留下来的历史行引用时，提交记录才归档。所以归档和表里的数据不重叠。
- **提交日志之前的历史：** 只有所有消费方都已越过提交日志的起点（边界大于 0）时才归档。

查询内核的检查点只有几分钟前的位置，远在 90 天之内。即使检查点指向的提交已归档，内核恢复时也只是退回到完整载入，不会出错。

### 归档与校验

每个 owner 的每个月在一个 REPEATABLE READ 事务里完成：

1. 以文本取出三张表的行。整数用十进制文本，时间用微秒精度的 UTC 文本，JSON 用其文本形式，所以写入和读回逐字节一致。
2. `eigos-archive write` 把行写成 Parquet，即 `<目录>/<owner 的 SHA-256 前 32 位>/<表>/<yyyy-mm>.parquet`。文件名不含 owner。
3. `eigos-archive read` 读回文件，比较行数和内容摘要。一致后才把文件改成正式的名字。
4. 在 `log_archives` 记下路径、行数、文件的 SHA-256 和内容摘要，然后删除归档的行。

任何一步失败，事务就回滚，写出的文件也被删除。

`eigos-archive` 是内核 crate 的第二个二进制，与内核用同一套 DataFusion 和 Parquet。`Kernel release` 工作流同时发布它，并检查它能写入一行再读回。

### 查询归档

- `audit` 合并表里和归档里的行，按 sequence 输出 NDJSON。归档前后，同一查询的结果相同。
- `replay-check` 把历史已归档的行计为 `carried`，不比较。
- 对象的 `edit_history` 接口（HTTP、MCP 和 `EditHistory.read`）先合并归档和表里的行，再按 sequence 分页。月份交界处两边可能交错，所以每页取两边最小的 sequence。分页游标不变，前几页是归档的编辑。
  - 读取归档需要给运行时配置 `EIGOS_LOG_ARCHIVE_DIR` 和 `EIGOS_ARCHIVE_BIN`，用于 Gateway。
  - 没有配置而 owner 又有归档时，接口只返回表里的行，并带上 `archive: "unavailable"`。
  - 可见性和遮罩与表里的行相同：先按当前权限读取对象，再按快照遮罩属性，并且只返回本本体发布中的编辑。

## 物化

`Materializations.capture` 在可重复读事务中保存选定对象类型的最新合成值和类型间关系。来源值与用户编辑已经由对象运行层合成，物化保存捕获时的结果。调用者提交 `requestId`、`name` 和 `types`，相同请求可安全重传。单次物化最多 10000 个对象，超过上限会明确失败并回滚。

`read` 和 `links` 提供分页读取。每次读取都检查当前实例权限，并依据历史行的策略字段和 markings 重新过滤历史值。快照保留完整策略上下文，当前不可见的属性返回 null。删除的正式对象从物化读取中隐藏。物化绑定原始发布，发布改变后需要重新捕获，以使用新的定义解释结果。

## 存储升级与权限

初始化函数为现有 PostgreSQL schema 添加 `source_values`、`object_edits`、`edit_policies`、`edit_history`、`link_history`、`change_commits`、`change_journal`、`index_streams`、`index_transactions`、`materializations`、`materialized_objects` 和 `materialized_links`。

数据库管理角色执行初始化和 `edit_policies` 配置。运行角色需要来源与编辑状态表的 SELECT、INSERT、UPDATE、DELETE，历史表（`edit_history`、`link_history`、`change_commits`）的 SELECT、INSERT 及其 identity sequence 的 USAGE，`change_journal` 的 SELECT，索引表的 SELECT、INSERT、UPDATE，物化表的 SELECT、INSERT。发布管理角色还需要复制候选状态时的写权限。公开读取都经过运行服务的对象与属性权限判断。

回归覆盖顺序消费、精确重传、授权撤销后的回滚和恢复、两类冲突策略、用户及来源删除语义，以及物化历史值在属性权限变化后的重新过滤。
