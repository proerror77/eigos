# 查询内核原型（C1）

这是 [查询内核](../architecture/query-kernel.md) 路线 C 的第一阶段。

- `kernel/` 是 Rust 服务，基于 Apache DataFusion。它从 PostgreSQL 载入一个发布投影的快照，然后执行 TypeScript 规划层编译出的 Object Set 计划。
- `packages/runtime/kernel/` 是规划层和客户端。

**目前还没有任何运行路径调用内核。** Gateway、Worker 和 Indexer 继续只用参考实现。

## 构建与测试

```bash
cargo build --release --manifest-path kernel/Cargo.toml
EIGOS_KERNEL_BIN=$PWD/kernel/target/release/eigos-kernel npm test -- --suite=46
```

- **服务启动：** 服务只监听 `127.0.0.1`。端口由 `EIGOS_KERNEL_PORT` 指定，不设置时随机分配，启动后输出一行 `kernel_listening` JSON 报告实际端口。
- **测试套件：** `tests/46-query-kernel.test.ts` 在同一份数据上分别用参考实现（`ObjectSets.evaluate`、`aggregate`）和内核执行同一批表达式，逐项比较结果。没有 `EIGOS_KERNEL_BIN` 时，只运行回退测试。
- **CI：** 在套件 46 的 job 里先构建内核，再运行这个套件。

## 覆盖范围

规划层只编译与参考实现可证明等价的部分，其余返回 `undefined`，调用方继续使用参考实现。

- **集合：**
  - `query`：仅限具体对象类型，支持 `where`、`filter`、`from`；
  - `refs`：跳过不存在的对象、未知类型和不可读类型，与参考实现相同；
  - `union`、`intersection`、`difference`；
  - `traverse`：多跳，集合可以混合类型，每一步按每个源类型分别导航。
- **谓词：**
  - `eq`、`ne`、`in`、`all`、`any`、`not`；
  - 数值之间的 `gt`、`gte`、`lt`、`lte`；
  - 字符串的 `contains`。

  谓词按参考实现的二值语义翻译：缺失与 null 相同，`ne` 对缺失值成立，`not` 不会遇到未知值；类型不符的字面量折叠为常量。
- **字段：** 只用存储标量字段（字符串、整数、数值、布尔），且字段不能有派生值、属性安全或分级标签。
- **类型：** 只用对当前主体没有行过滤的类型。判断方法是直接执行参考实现的 `Access.rowFiltered`，即对象策略、标记、带模型许可级别时的行分级、文档分块和过程日志都不存在。
- **输出：**
  - 分页：按 `canonical(ref)` 排序；内核为每个对象预先计算等价的排序键。
  - 总数。
  - 聚合：对单一类型做 `count`、`sum`、`min`、`max`、`avg` 和 `groupBy`，分组按首个成员出现的顺序排列。
- **出口分级：** 内核为结果集合中的每个类型返回成员数、最高的行分级等级和全部分区。客户端把它们与文档分级、类型分级合并后记录一次，效果与参考实现逐个读取成员时相同。

## 等价标准

以下各项与参考实现完全一致：引用、顺序、总数、revision、每个有值的属性，以及聚合结果。

缺失值与 null 视为同一个 Ontology 值。参考实现自己会因表达式形态不同，把缺失值写成不存在的键、`undefined` 或 `null`。

## 基准

在本机 Docker 的 PostgreSQL 17 上测量。数据规模：
- Route 和 RideRequest 各 N 个，Place 为 N/10 个；
- 每个请求有一条 `RequestRoute`，每条路线有一条 `RouteOrigin`。

表中取每个用例的第二次运行；"内核"一列包含 HTTP 往返和补读页内对象的时间。

| 用例 | N = 100,000 参考实现 | N = 100,000 内核（引擎） | N = 1,000,000 参考实现 | N = 1,000,000 内核（引擎） |
| --- | --- | --- | --- | --- |
| 过滤 0.5% 后取首页 | 167 ms | 58 ms（6.7） | 8.9 s | 49 ms（9.9） |
| 从 0.5% 的请求走 1 跳 | 121 ms | 43 ms（6.8） | 759 ms | 77 ms（30） |
| 走 2 跳 | 60 ms | 26 ms（6.9） | 889 ms | 77 ms（35） |
| 0.5% 按 lanes 聚合 | 110 ms | 6.7 ms（4.3） | 8.5 s | 14.6 ms（11.5） |
| 全部 Route 按 lanes 聚合 | 20.8 s 后超出 10,000 对象上限 | 12.9 ms（10.8） | 26 分钟后超出上限 | 86 ms（80） |
| 全部 Route 取首页 | 20.5 s 后超出上限 | 44 ms（6.8） | 未运行 | 83 ms（32） |

内核载入耗时与数据量：

| N | 对象 | 边 | 载入耗时 | Arrow 缓冲区 |
| --- | --- | --- | --- | --- |
| 100,000 | 21 万 | 20 万 | 2.2 s | — |
| 1,000,000 | 210 万 | 200 万 | 22 s | 409 MB |

- 409 MB 是按缓冲区容量统计的上限。macOS 上测到的常驻内存受内存压缩影响，偏低且不可信，Linux 上的实测放在 C6。
- 内核端到端时间的大部分花在逐个补读页内对象上，批量补读属于 C4。
