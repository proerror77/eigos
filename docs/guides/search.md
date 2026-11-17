# 本体查询、派生属性与语义检索

普通对象查询继续接受 `type`、`where`、`from`、`select`、`limit` 和 `cursor`。`filter` 增加组合条件，`orderBy` 指定多个排序字段。对象集中的查询表达式复用这些字段。

## 条件和排序

```json
{
  "type": "SchedulePlan",
  "filter": {
    "op": "all",
    "predicates": [
      {"op": "gte", "property": "durationMinutes", "value": 30},
      {"op": "text", "property": "name", "value": "project review"}
    ]
  },
  "orderBy": [{"property": "durationMinutes", "direction": "desc"}],
  "limit": 20
}
```

| 操作 | 参数与行为 |
| --- | --- |
| `eq`、`ne` | `property` 与标量 `value`，严格比较类型和值 |
| `gt`、`gte`、`lt`、`lte` | 比较同类型的数字或字符串，空值不满足比较 |
| `in` | `property` 与 `values` 标量数组 |
| `contains` | 字符串子串匹配，或数组中的标量元素匹配 |
| `text` | Unicode NFKC 规范化后忽略大小写，空格分隔的所有词都须作为子串出现 |
| `regex` | `value` 是 Unicode JavaScript 正则表达式，最多 256 个字符 |
| `all`、`any` | `predicates` 子条件数组 |
| `not` | 一个 `predicate` 子条件 |

属性路径支持 `coordinates.lat`、嵌套 Struct 和带数字下标的数组路径。过滤、字段选择和排序都可以使用路径。只有实际存在的自身属性会被访问。属性级权限遮罩先执行，隐藏字段表现为 `null`，每个条件只处理遮罩后的值。

`orderBy` 最多五个字段，支持 `asc` 和 `desc`，空值固定放在最后。同值对象按稳定身份排序。存储属性的标量等值、数值范围、集合包含和布尔组合在 PostgreSQL 中过滤，数值和布尔排序也在库内完成。权限遮罩先于筛选和排序，最多返回 10,000 个匹配对象供完整快照分页。派生条件、Unicode 文本、正则和字符串范围沿用应用层求值，最多读取 10,000 个可见候选对象。字符串排序保留原有 Unicode 比较语义。扩展查询使用 repeatable-read 事务，游标绑定表达式、调用者、发布、Scenario 和可见结果内容。

正则求值在独立 Worker 中执行，整个正则步骤有一秒期限。超时终止 Worker，服务器事件循环继续处理其他工作。单个待匹配字符串最多 65,536 字符，一次最多 50,000 个不同正则比较。

## 派生属性

对象属性可声明 `derived`，值在读取时计算。属性的 `schema` 校验非空计算结果。实例创建、编辑和来源映射拒绝写入派生字段。

```json
{
  "totalMinutes": {
    "description": "Total minutes assigned to the resource",
    "schema": {"type": "number"},
    "required": false,
    "derived": {
      "op": "linked",
      "path": [{"link": "activities"}],
      "aggregate": "sum",
      "property": "minutes"
    }
  },
  "doubleMinutes": {
    "description": "Twice the assigned minutes",
    "schema": {"type": "number"},
    "required": false,
    "derived": {
      "op": "multiply",
      "left": {"op": "property", "property": "totalMinutes"},
      "right": {"op": "literal", "value": 2}
    }
  }
}
```

`linked.path` 可连续导航多条 Link，每步支持 `as` Interface 名称。`aggregate` 支持 `count`、`sum`、`min`、`max`、`avg` 和 `select`。除了 `count`，其他聚合需要 `property`。`select` 要求最多一个可见目标对象。数值聚合排除空值，全为空时返回 `null`。

`property` 引用本对象的存储或派生属性，支持嵌套路径。`literal` 提供数值常量。`add`、`subtract`、`multiply` 和 `divide` 组合左右表达式。空值和除以零返回 `null`，非有限数值被拒绝。

普通 `read`、对象查询和关系导航会返回计算值。这些值也可用于 `where`、`filter`、`orderBy`、`select` 和 Object Set 聚合。计算沿用当前 Scenario，逐级检查对象和属性权限，读取依赖会进入结果权限记录。每个关系步骤最多 10,000 个可见对象，每次派生求值最多 50,000 个计算或读取步骤；循环依赖和超过十六层的递归会失败。

## 语义索引

语义检索由已发布的版本化 Function 生成嵌入向量。Function 接收 `{text: string}` 并返回固定维度的有限 `number[]`。运行服务校验发布绑定、模型版本、维度和非零范数。自定义模型使用现有受信任 Function 扩展机制。

管理员通过 `SemanticSearch.configure` 定义索引。内置 `embedTextLocal` 使用固定版本的多语言 MiniLM，返回 384 维向量。

```json
{
  "name": "RouteDescriptions",
  "type": "Route",
  "property": "name",
  "embeddingFunction": "embedTextLocal",
  "dimensions": 384
}
```

`npm run embeddings:warm` 将 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` 的固定 revision `2c4055b12046f11709e9df2c122e59ffbdc2f900` 下载到 `EIGOS_EMBEDDING_CACHE`，默认 `~/.cache/eigos/embeddings`。首次调用也会下载；生产可以在运行前预热同一缓存。推理使用 CPU 和 q8 权重，文本留在运行进程。输入最多 4,000 字符，长文本分段后平均并归一化；队列最多容纳 16 次调用。下载失败、模型不可用或队列已满会返回明确错误，不生成替代向量。

索引配置在一个发布内不可变。新增配置使用新的索引名称。存储层保存模型版本、Function 绑定、对象 revision、文本摘要和规范化向量。

准备发布和候选追赶会把兼容的索引配置及向量复制到候选发布，包括不同 owner 的独立向量；不会在发布事务中调用模型。索引的存储属性、版本化嵌入 Function 和绑定必须仍兼容，否则准备阶段拒绝，当前发布继续服务。已有索引的破坏性属性或模型变更需要单独迁移，不能借重新发布静默丢弃旧索引。

配置和向量内容纳入来源及候选指纹。准备后新增索引或重建向量需要先追赶候选并重新审阅；候选中的向量被修改也会阻止激活。JSONB 与可选 pgvector 使用同一复制路径。对象迁移改变文本或修订号后，旧向量仍会被新视图的鲜度检查排除；通过 `semantic_status` 检查覆盖并用 `semantic_index` 重新索引这些对象。发布本身不扩大读取、属性或模型权限。此处沿用 [Funnel 替换发布](https://www.palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines) 的准备与切换职责。

`SemanticSearch.index` 接收 `{name, objects: [{type,id}]}`，每次最多一百个对象。服务只把有权限读取的文本交给嵌入 Function。模型调用发生在业务写锁之外，写入向量前在事务中重新验证对象 revision、文本摘要及权限。每个对象单独提交，批次中途失败后可重新提交同一组对象。

`SemanticSearch.search` 接收 `{name,text,limit,from?}`。服务先调用同一版本的嵌入 Function，将查询文本变成向量，然后从当前有权限读取的对象中选取仍有效的向量并计算余弦相似度。文档切片索引可通过 `from` 沿已发布的 Link 限定到具体业务对象。范围和权限都在选取前 K 项之前应用。对象已更新、已删除、文本属性被隐藏或模型绑定变化时，旧向量被排除。更新对象后重新调用 `index` 即可补充向量。 [按业务对象检索文档](document-versions.md)

精确余弦检索最多扫描 10,000 个授权对象。响应保留 `search: "exact_cosine"`，并用 `backend` 报告 `jsonb` 或 `pgvector`。`status` 返回当前视图中具有有效向量的授权对象数量、模型版本、绑定和维度。HTTP、MCP 和工作台可用 `scenarioId` 查询方案。方案只使用与当前视图的对象修订和可见文本匹配的向量。

### 启用 pgvector

普通 PostgreSQL 保持使用 JSONB 向量。安装 pgvector 的 PostgreSQL 实例可以在 schema 升级后，由具备扩展安装权限和表权限的数据库管理员执行 `npm run db:enable-pgvector`。也支持管理员预先将扩展安装在独立 schema 中。运行角色需要已有 `semantic_vectors` 的权限和扩展 schema 的 `USAGE`。

启用命令在一个事务中添加原始 JSONB 的持久生成列，自动转换现有向量。新写入和重索引会同步生成该列。转换失败会回滚，原向量仍可使用。迁移期间 PostgreSQL 会锁定向量表。可用 `semantic_status` 确认查询使用 `pgvector`。

查询先按对象、文档父版本、模型出境权限、owner、发布、绑定、维度、修订和文本摘要筛选候选，再由 PostgreSQL 用 `<=>` 计算精确余弦距离并返回排名。向量本身留在数据库。pgvector 使用单精度向量，分数在浮点精度范围内可能和 JSONB 路径不同。分数相同时按稳定对象标识排序。 [pgvector 精确近邻](https://github.com/pgvector/pgvector#querying) · [PostgreSQL 生成列](https://www.postgresql.org/docs/17/ddl-generated-columns.html)

数据库升级调用 `initializeSemantic(db)`，创建索引配置和向量表。配置变更需要本体管理权限，构建和检索需要对象读取与对应 Function 执行权限。HTTP/MCP 的入口还执行当前读写 scopes。

## 验证

`tests/18-search.test.ts` 覆盖完整分页后的过滤排序、嵌套字段、隐藏字段、正则超时、关联聚合、算术、Scenario、只读派生属性以及从发布 Function 到语义排名的调用链。CI 使用普通 PostgreSQL 和安装 pgvector 的 PostgreSQL，验证向量转换与回滚、跨 owner 隔离、按业务对象检索、文档父版本和模型权限。测试使用可重复的合成嵌入 Function。内置真实模型已另外验证中文机场与咖啡语义检索。
