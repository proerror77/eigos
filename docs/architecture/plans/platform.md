# 平台线：Funnel、运行时与规模的实施方案

本文是 [路线图](../roadmap.md) 并行线的详细做法：05.4、05.5、提交日志保留、06.1–06.3、04.3/04.4 和 09。

## 现状

- **提交日志：** 每次提交在 `change_commits(owner, xact, commit_seq)` 中有一个编号，对象和关系的变化分别记在 `edit_history`（含 `after_values`）和 `link_history`。查询内核按这个日志增量维护投影（C3）。
- **变化检测：** `change-feed.ts` 提供：
  - `latestCommit`；
  - 查询的变化足迹 `queryFootprint`；
  - 按足迹判断有无相关变化的 `footprintChanged`。
- **观察兴趣：** `observation-interests.ts` 为对象登记观察兴趣并定期扫描（`scanOne`）。
- **任务：**
  - `Tasks` 用 `claim(lane)` 领取任务，分 `scheduled` 和 `interactive` 两条通道；
  - Worker 一次处理一个领取到的任务，执行时续租（`renew`）；
  - 对象级提交（#243）让同一 owner 不相关对象的提交并行，不必整体排队。

## 05.4：变化订阅

**状态：** 已实现，见 [索引指南](../../guides/indexing.md#变化订阅funnel-054)。分发器挂在 Indexer 的扫描里。唤醒以任务形式投递到订阅的会话。

**目标：** 订阅方只在相关提交之后被唤醒，不漏，也不重复。Agent 唤醒（06.5）和 Machinery 的局部重规划（M3）都依赖它。

- **数据：** 新表 `change_subscriptions(id uuid, owner text, subscriber text, footprint jsonb, position bigint, created_at, cancelled_at)`。
  - `footprint` 就是 `queryFootprint` 的结果：类型、字段、链接和对象引用；
  - `position` 是订阅方已经处理到的 owner 提交编号。
- **分发：** Worker 里的分发器按 owner 循环：
  1. 读出 `position` 之后的提交，带上对应的 `edit_history` 和 `link_history` 行；
  2. 用 `footprint` 匹配；
  3. 匹配到的，在同一个事务里做两件事：为订阅方入队一个唤醒任务（携带提交区间），并把 `position` 推进到区间末尾。

  入队和推进在一个事务里，所以既不会漏，也不会重复。没有匹配的，只推进 `position`。
- **背压：** 唤醒任务按 `(subscription, 区间)` 去重。订阅方还没处理完上一次唤醒时，新的区间合并进同一个待处理任务。
- **权限：** 订阅属于一个主体。唤醒时按这个主体现在的权限重新读取，订阅本身不缓存数据。
- **接口：** `subscribe(access, footprint)`、`cancel(id)`、`list()`。Agent 的观察兴趣可以改为建立在订阅之上，作为后续 PR。
- **验收：**
  - 并发写入下，订阅方收到的提交区间连续，既不重叠也不缺口：用 1 万次提交的测试断言；
  - 不相关的提交不唤醒订阅方。

## 05.5：重放验收

- **做法：** 从提交日志重建投影，再与表比对：
  1. 按 commit_seq 顺序把 `edit_history.after_values` 和 `link_history` 应用到一个空的临时 schema，得到对象表和关系表；
  2. 按 owner 和类型比较行数和行摘要（`digest(properties)`），关系按端点比较；
  3. 同时与查询内核的检查点（Parquet）比对，内核的检查点也是从同一个日志维护的。
- **工具：** `npm run ontology -- replay-check`。只读，输出每个 owner 的差异；生产上用于部署前后的验收。
- **验收：** 在测试数据和生产副本上，重放结果与表一致。日志之外的写入（直接 SQL）会被报告为差异，这是预期行为。

## 提交日志保留

**状态：** 用户 2026-11-27 采纳了 90 天的建议，归档和审计已实现，见 [来源索引、编辑历史与物化](../../guides/indexing.md#提交日志保留)。与下文不同的地方：
- ProcessLog 跟踪的类型，其历史不归档，因为这些行就是 ProcessLog 对象；
- 边界也考虑对象规则的位置；
- 文件按表分开存放。

- **建议：** `edit_history`、`link_history` 和 `change_commits` 保留 90 天，更早的归档。见路线图"需要决定的事"第 4 条。
- **条件：** 只归档已被以下各方确认处理过的提交：
  - 内核的检查点；
  - 所有变化订阅的 `position`；
  - 运行中的 Scenario 的同步位置。
- **归档：**
  - 按月写成 Parquet 文件（`archive/<owner-hash>/<yyyy-mm>.parquet`），放在仓库之外的归档目录或对象存储；
  - 写入并核对行数之后，再删除表中的行。
- **审计：** `edit_history` 同时是审计记录。归档后仍能用 DataFusion（内核同一套库）查询，CLI 为 `npm run ontology -- audit --from … --to …`。
- **验收：** 归档前后，同一审计查询的结果一致；归档不影响内核和订阅。

## 06.1–06.3：运行时预算

06.1 和 06.2 已实现 Worker 槽数、每个 owner 的交互槽上限和按 owner 轮转。06.3 已实现按进程配置主连接池，以及声明 `source` 的 Function 调用速率预算。配置见 [README](../../../README.md)。

1. **工作槽（06.1）：**
   - Worker 进程同时处理多个任务，每个进程有 N 个槽，默认 4；
   - 每个 owner 同时最多占 M 个交互槽，默认 2，排程有独立槽；
   - Worker 控制进程槽数，`claim` 领取交互任务时用 `FOR UPDATE SKIP LOCKED` 和 owner 锁复查运行中交互任务数。
2. **队列与公平（06.2）：**
   - 两条通道各有优先级，交互通道优先；
   - 同一通道内，按 owner 轮转领取，避免一个 owner 的大批任务挡住其他 owner；
   - 定时任务在到期时间之前不可领取，沿用 `available_at`。
3. **连接、配额与速率（06.3）：**
   - Gateway、Worker 和 Indexer 可各自设置 `EIGOS_DB_POOL_MAX`。独立的只读连接池及 Rust 内核连接配置沿用现有机制；
   - `EIGOS_PROVIDER_RATES` 为已发布的 Function `source` 设置每分钟速率和突发额度，按 owner 和 source 在 PostgreSQL 保存共享令牌桶；
   - 超过预算时，Worker 用 `Tasks.postpone` 释放槽位并延后任务，直接调用返回 429。累计用量配额和独立 Action 外部写入预算仍待实现。
4. **验收：** 压测下各预算按约定生效。一个 owner 提交 1000 个任务时，另一个 owner 的交互任务等待时间不超过一个任务的执行时间。

## 04.3 / 04.4：热点对象与资源预留

- **热点对象（04.3）：** 对象级提交已经让不相关对象并行。热点对象上的并发编辑仍会排队，补两件事：
  - 检测：设置 `EIGOS_OBJECT_LOCK_REPORT_MS` 后，PostgreSQL 按对象记录超过阈值的锁等待。通过 `object_lock_wait` 日志按对象键摘要汇总，关联已有 Action 或任务记录。此入口默认关闭。
  - 自适应：同一对象在途的简单声明式编辑会按 owner、发布投影和对象键排队并合批，保留每个原始请求的权限、历史与回执。可用 `expectedProperties` 对将修改的字段声明比较值；其它规则保持严格修订检查。Nightly 的 `hot-writes` 用 1、4、16 个调用者记录 9 组吞吐样本。
- **统一资源预留（04.4）：** 排程里的时间和资源预留统一成一张预留表 `(resource, interval, holder, state)`，用 PostgreSQL 的排他约束（`EXCLUDE USING gist`）保证不重叠；排程、Action 和供应商履约都通过它预留。
- **验收：** 热点对象上的并发编辑吞吐不再随并发数下降；预留在并发下不会重叠。

## 09：规模化

分区、Saga、事件风暴、供应商治理和分层 Agent 运行时，各自另行设计。前提是上面各项完成之后，用 Engine Benchmark 08 和生产数据确认瓶颈在哪里，再定先做哪一项：
- **分区：** 按 owner 把对象和日志表分区，迁移要在线进行；
- **Saga：** 跨供应商的多步履约，每步带补偿 Action，状态存在 Ontology 中；
- **供应商治理：** 每个供应商的出口策略、配额、凭据轮换和故障隔离；
- **分层 Agent 运行时：** 规划、执行、观察分层，各层用 05.4 的订阅衔接。

## 依赖与顺序

- 05.4 依赖 C3（已完成）。
- 05.5 和日志保留依赖 C3；日志保留还依赖 05.4，因为要看订阅位置。
- 06.1–06.3 互相独立。
- 04.3/04.4 在 06.x 之后。
- 09 最后。
