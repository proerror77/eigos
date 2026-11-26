# Ontology 查询内核

2026-11-26 选定路线 C：

- PostgreSQL 继续承担权威状态、事务和 Action。
- Funnel 从提交日志维护可直接查询的结构。
- EIGOS 自有的查询服务以 [Apache DataFusion](https://datafusion.apache.org/) 执行 Ontology 查询计划。

现有 PostgreSQL 与进程内求值路径保留为参考实现和回退路径。新内核接管一类查询之前，必须先在这类查询上证明结果与参考实现一致。

## 依据

- Palantir 把职责分成三层：Ontology 专用的规划、对象索引存储、底层计算后端。Funnel 合并变化、生成目标数据库的索引并发布。[运行架构](https://www.palantir.com/docs/foundry/object-backend/overview) · [Funnel 批处理](https://www.palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/)
- OSS 的 Search Around 返回至少有一条匹配关系的目标对象，按 left-semi join 执行。[OSS 限制](https://www.palantir.com/docs/foundry/ontologies/oss-limitations)
- Action 完成后，此后开始的 Action 和查询都能看到它的全部编辑。新内核必须保持这一保证。[一致性保证](https://www.palantir.com/docs/foundry/action-types/consistency-guarantees)
- DataFusion 通过 `TableProvider` 接入自有数据源，并接收投影和过滤下推。实现方要准确声明哪些过滤可以精确下推。[自定义表](https://datafusion.apache.org/library-user-guide/custom-table-providers.html)

## 职责

| 层 | 负责 | 位置 |
| --- | --- | --- |
| Ontology 定义 | 对象类型、Link、Interface、派生属性、发布版本 | `packages/ontology/`，`Metadata` |
| 权威状态 | 对象、关系、来源值、用户编辑、Action 提交、提交日志 | PostgreSQL |
| 语义规划 | 把对象查询、Object Set、聚合、权限、Interface 视图、派生属性和 Scenario 编译成逻辑计划 | `packages/runtime/kernel/`（TypeScript） |
| Funnel | 为每个发布投影维护按类型分列的对象表和按 Link 类型的边表，记录每个 owner 已应用到的提交序号 | 查询服务内，由提交日志驱动 |
| 执行 | 扫描、过滤、半连接与连接、集合运算、聚合、排序与 Top-K | `kernel/`（Rust，DataFusion） |
| 结果 | 对象引用、请求的字段、结果对应的提交序号 | 返回给 TypeScript，由现有对象层补齐和复核 |

权限、属性遮罩和 Scenario 的含义只在规划层定义，查询服务只执行编译好的计划，不自行解释授权。

## 逻辑计划

规划层输出结构化计划，不拼接 SQL 文本：

- **算子：** `scan(type, columns)`、`filter`、`semiJoin`、`antiJoin`、`join`、`union`、`intersect`、`except`、`aggregate(groupBy, metrics)`、`sort`、`limit`（带游标的键集分页）和 `project`。
- **表达式：** 列、字面量、比较、`and`、`or`、`not`、`in`、空值判断、字符串与数组包含、规范化后的词项包含（对应 `text` 谓词）、正则、`case`（属性遮罩），以及派生属性用到的四则运算。

现有 Ontology 结构按下表映射到算子：

| 现有结构 | 计划 |
| --- | --- |
| `query`（`where`、`filter`、`intervalOverlap`） | `scan` 加 `filter` |
| `query.from` 与 `traverse` | 沿边表做 `semiJoin`，每一步换到目标类型 |
| `refs` | 值表 |
| `union`、`intersection`、`difference` | 以 `(type,id)` 为键的集合运算 |
| 聚合（`count`、`sum`、`min`、`max`、`avg`，`groupBy` 至多 5 项） | `aggregate` |
| 派生属性 `linked` | 沿关系路径连接后聚合，`select` 取至多一个对象的值 |
| Interface 视图 | 各实现类型分别扫描，按映射把字段改名后 `union` |
| 对象策略、标记 | 主体上下文作为常量，策略编译为 `filter` |
| 属性安全 | 用 `case` 输出 null |

值的语义必须与参考实现逐项一致：

- 相等比较按规范化 JSON；
- 大小比较只在数值之间进行；
- 字符串排序按 UTF-16 代码单元。DataFusion 默认按字节排序，所以存在差异的字符串排序要么使用等价的排序键，要么回退到参考实现。

## 物理结构与读取版本

**数据结构。** Funnel 为每个活动发布投影维护两类表：
- 对象表按类型分开，列为 owner、id、revision 和存储属性。属性按 Ontology schema 定型：字符串、整数、数值、布尔、时间，嵌套值保存为规范化 JSON。
- 边表按 Link 类型分开，列为 owner、from_id、to_id。

第一版（C1）放在内存里，启动时从 PostgreSQL 载入快照。持久化格式定为 Parquet（2026-11-26 决定）。从 C3 起，Funnel 把每个类型的对象表和每个 Link 的边表写成 Parquet 分段，并记下每个 owner 已应用到的提交序号。内核启动时从分段恢复，再从记下的位置读取提交日志追平。

**读取版本。** 一次查询开始时，规划层读取相关 owner 的最新已提交序号，作为这次查询的最低版本：
- 查询服务应用到这个版本后才执行。超过等待预算时返回"版本不足"，规划层改走参考实现。
- 结果携带它对应的提交序号。

这样，Action 完成后开始的查询一定能看到它的编辑，延迟只会让查询回退，不会让查询读到旧数据。这项工作就是原计划的 Funnel 05.3。

**发布切换。** 新发布在后台载入新投影并追平日志，切换时与活动发布指针一致，对应 Funnel 的替换流水线。

## 阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| C1 原型 | `kernel/` 服务从快照载入对象与边表。规划层编译存储属性过滤、`traverse`、集合运算、聚合、排序和分页，权限只用类型级授权 | 在测试夹具上与参考实现差分一致。在 10 万和 100 万对象、100 万和 1000 万关系上对比现有路径的 p50/p95、读取量和内存 |
| C2 权限与派生 | 对象策略、标记、属性遮罩、派生属性、Interface 视图 | 同一批查询在受限角色和遮罩下差分一致 |
| C3 增量与版本 | 按提交日志增量维护（对象 upsert 和删除、关系增删），读取版本，发布替换 | 持续写入、关系变更和权限撤销下读写一致，记录追赶与恢复时间 |
| C4 路由 | `Objects.query` 与 Object Set 把可执行的查询交给内核，其余回退。测试套件以影子模式双跑比对 | 现有测试全部通过，影子比对无差异 |
| C5 Scenario 与扩展 | Scenario 编辑作为叠加层；多跳查询优化（原 OSS 03.3/03.4）；决定向量检索留在 pgvector（加近似模式）还是迁入内核 | 带 Scenario 的查询差分一致，多跳基准达标 |
| C6 部署与基准 | 在 CI 构建发布产物，生产增加查询服务单元，建立 Engine Benchmark 08 | 部署、发布镜像和生产切换分别取得授权后进行 |

C4 之后的上线、观察和切换步骤见 [路线图](roadmap.md#线一查询内核)。

性能目标：在相同负载下，分页列表和限定范围的关联查询达到百毫秒级交互延迟，全量计算另设预算。比较对象是现有实现、路线 C，以及能取得测试结果时的 Palantir 环境。

## 向量检索的去留（C5c 决定，2026-11-26）

**决定：** 向量留在 pgvector，按授权后的候选做精确排序，不迁入内核，也不改成近似索引。

**依据：** 用 `scripts/benchmarks/vectors.mjs` 在本机 Docker 的 pgvector（PostgreSQL 17）上测得，向量为 384 维随机单位向量，每个规模 20 次查询。测量时本机同时在跑测试套件，两次运行之间相差可达一倍，所以下表只表示量级：

| 候选数 | 精确排序 p50 / p95 | HNSW top 10 p50 / p95 | HNSW 构建 | HNSW recall@10 | 表 / HNSW 大小 | 放进内核需要的内存 |
| --- | --- | --- | --- | --- | --- | --- |
| 10,000 | 69 / 264 ms | 3.8 / 8.5 ms | 3.6 s | 0.36 | 39 / 20 MB | 15 MB |
| 100,000 | 1.89 / 2.80 s | 10.4 / 14.8 ms | 243 s | 0.05 | 391 / 195 MB | 146 MB |

- **语义：**
  - 语义检索在授权且内容仍新鲜的候选上做精确排序：候选按行规则读出，再核对 revision 和文本摘要。
  - 近似索引在全表上取前 K 个，之后再按授权过滤会漏掉结果，所以不能替代精确排序；`semantic.ts` 里的注释也写明了这一点。
  - 随机向量没有聚类结构，是近似检索最不利的情形，所以这里的 recall 偏低。即便将来考虑近似模式，也要先用真实嵌入测 recall。
- **内存：**
  - 384 维 float32 每个向量 1.5 KB，100 万个向量需要 1.46 GB，超过生产内核 768 MB 的内存上限。
  - 迁入内核要么换更大的主机，要么做量化，量化又会改变精确排序的结果。
- **规模：** 生产目前只有 30 个向量，精确排序在 1 万个候选以内仍是百毫秒级。

**规模变大后的方向：** 10 万个候选时，耗时大部分花在候选管线上：JS 按页读出全部候选，在 JS 里计算文本摘要，再把整个候选列表作为 JSON 交给 SQL 连接。所以某个 owner 的索引超过约 1 万个对象时，先改这条管线：
1. 在 SQL 中按行规则选出候选，用 `(type, id, revision)` 直接连接 `objects` 核对新鲜度，不再从 JS 传 JSON 列表；
2. 必要时由内核给出授权后的候选 id。

这两步都不需要移动向量。

## 边界

- 查询服务只监听本机地址，调用方是 Gateway、Worker 和 Indexer。数据按 owner 分区。服务不保存凭据，也不访问供应商。
- 写入、提交条件和 Action 校验仍在 PostgreSQL 事务内完成。查询服务的结果不作为提交条件的依据，提交内的读取继续走事务连接。
- 未证明等价的查询形态一律走参考实现。
