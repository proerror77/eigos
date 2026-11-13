# Object Set Service

Object Sets 将本体查询、对象引用和关系导航组合为可复用集合。集合求值和聚合复用 `Objects`，使用调用者当前的实例与属性权限，以及请求选择的正式或 Scenario 视图。

## 集合表达式

| `op` | 字段 | 语义 |
| --- | --- | --- |
| `query` | `query` | 完整读取类型或 Interface 查询的所有分页，支持已有等值条件与关系起点 |
| `refs` | `objects` | 用 `{type,id}` 引用组成静态集合，去重并隐藏缺失或无权读取的实例 |
| `union` | `sets` | 合并多个集合，按对象身份去重 |
| `intersection` | `sets` | 保留所有子集合都有的对象 |
| `difference` | `left`、`right` | 保留左侧有、右侧没有的对象 |
| `traverse` | `set`、`path` | 从集合出发依次导航 Links，每一步可通过 `as` 使用 Interface Link 名称 |
| `saved` | `id` | 求值当前有权使用的已保存集合 |

以下表达式从所有询价请求导航到路线，再通过 `RideEstimatable` Interface 取得出发地点。

```json
{
  "op": "traverse",
  "set": {"op": "query", "query": {"type": "RideRequest"}},
  "path": [{"link": "route"}, {"link": "origin", "as": "RideEstimatable"}]
}
```

`evaluate(access, model, {set, view?, limit?, cursor?})` 返回 `items`、`total` 和可选 `cursor`。`view` 可将结果投影为共同 Interface。输出按对象身份稳定排序，每页最多 100 条。游标绑定调用者、发布、Scenario、表达式及可见对象内容，数据或可见性变化后，继续旧游标会失败，调用者应重新查询。

一次求值在 PostgreSQL repeatable-read 事务中完成。每个中间集合最多 10,000 个对象，表达式最多 16 层组合，整个求值最多 25,000 次表达式或读取操作。超出时整体失败。完整集合确定后才生成分页和聚合结果，结果中的 `total` 始终对应这次完整求值。关系导航使用分页查询，可完整读取超过普通 `follow` 上限的关系。

## 聚合

`aggregate(access, model, {set, view?, groupBy?, metrics})` 支持最多五个分组字段和二十个命名指标。`count` 可统计对象数，指定 `property` 时统计该字段的非空值数。`sum`、`min`、`max`、`avg` 要求指定有限数值属性；空集合或全为空的数值指标返回 `null`。

```json
{
  "set": {"op": "query", "query": {"type": "SchedulePlan"}},
  "groupBy": ["timeZone"],
  "metrics": {
    "plans": {"op": "count"},
    "minutes": {"op": "sum", "property": "durationMinutes"},
    "averageMinutes": {"op": "avg", "property": "durationMinutes"}
  }
}
```

输出为 `{count, items: [{group, metrics}]}`。分组和指标读取经过权限遮罩的值。隐藏属性作为 `null` 参与分组，并从数值计算中排除。数值字符串需要在本体中显式建模或转换后再聚合，溢出会导致请求失败。

## 保存与分享

`save(access, model, input)` 接收 `requestId`、`name`、`mode`、`set` 和可选 `readers`。首次创建生成 UUID。相同 `requestId` 和相同输入可安全重试，改变输入的重复请求会被拒绝。

- `dynamic` 保存表达式，每次使用时根据当前数据重新求值。
- `static` 在保存事务内确定对象引用，后来新出现的对象不会自动加入；引用对象的属性仍按读取时的当前值与权限返回。
- 修改已有集合需提交 `id` 与当前 `revision`。更新会增加 revision。删除同样校验 revision。
- `readers` 是明确获准使用该集合的身份列表。只有创建者可以修改、删除和调整列表。
- 分享后，集合仍使用读取者当前的数据权限与 owner 范围求值。授权集合不会授予创建者的实例数据权限。静态引用在读取者范围内不存在或不可见时被隐藏。
- 共享读取者取得名称、模式和 revision。表达式及读者列表只返回给创建者，静态集合里的原始对象 ID 不会通过共享元数据泄露。
- 动态集合可以引用其他已保存集合；每层引用都检查当前访问权限。循环引用或已删除的依赖会明确失败。

`get`、`list` 返回可访问集合的元数据。`list` 支持 UUID 游标和分页。保存操作使用正式本体，Scenario 可用于求值已有集合和聚合。

## 初始化与权限

管理员执行数据库升级时调用 `initializeObjectSets(db)`。该初始化可以重复执行，创建 `object_sets` 表和索引。运行角色需要此表的 SELECT、INSERT、UPDATE、DELETE 权限。

协议入口按现有 OAuth 读写 scopes 控制。服务层还检查本体定义可见性、集合所有权和读者列表。对象读取继续执行本体的实例、属性与来源相关权限。集合的保存和分享记录独立于业务对象编辑。

## 验证

`tests/11-object-sets.test.ts` 使用隔离的 PostgreSQL，覆盖超过一页的完整集合、多跳关系、Scenario 视图、分组与数值指标、属性遮罩、静态和动态成员变化、跨 owner 分享、撤销共享、并发创建重试、版本冲突和引用循环。

## 定义变更

候选定义在准备和激活时都会检查已保存的动态集合及其引用。删除集合依赖的属性或 Link、改变筛选字段的数据类型，或改动遍历使用的 Link 契约，会阻止发布并指出受影响的集合数量。集合所有者可用现有的 revision 更新集合，再发布新定义。静态集合继续保存对象引用，已删除或不可见的对象在求值时被隐藏。[Palantir 的属性变更说明](https://www.palantir.com/docs/foundry/object-link-types/edit-properties)

Gateway 和任务 Agent 均支持用 `scenarioId` 对集合求值和聚合。Agent 可以直接返回该方案的集合结果或指标。保存操作仍使用正式本体。
