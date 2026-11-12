# 对齐 Palantir Ontology 容器（v38 重构）

原则：**先按 Palantir 的容器放字段，再谈我们自己的需求**。凡是我们自创的顶层字段，
一律迁到 `extensions` 命名空间下，或改成 Palantir 已有的承载方式。不允许为了少改代码
而新造容器。

## 一、Palantir 的容器（唯一合法位置）

| 概念 | 容器 | 必填字段 |
|---|---|---|
| Object Type | `objects[]` | `apiName` `displayName` `primaryKey` `titleProperty` `properties[]` `datasource` `interfaces[]` |
| Property | `objects[].properties[]` | `apiName` `type` `required` `enum`（如有） |
| Link Type | `links[]` | `apiName` `source` `target` `cardinality` `join{sourceProperty,targetProperty}` `properties[]` |
| Action Type | `actions[]` | `apiName` `parameters` `submissionCriteria` `writeback{target,mode,returns}` `rules` |
| Function | `functions[]` | `apiName` `returns` `implementation` |
| Interface | `interfaces[]` | `properties[]`（共享）`links[]`（接口→类型/接口）`actions[]`（能力） |
| Interface 实现 | `objects[].interfaces[]` | `propertyMap` `linkMap` `actionMap` |

`datasource` 是**结构化对象**，不是字符串：`{type:'api'|'dataset'|'store'|'function', …}`。
计算型对象 = `datasource.type='function'`，**不是** `derived: true`。

## 二、当前偏差清单（逐项，带实测）

| # | 我们的现状 | Palantir 的位置 | 处置 |
|---|---|---|---|
| 1 | `document.writebacks`（63 条，文档级映射） | `actions[].writeback` | **迁回 action**；需一次性重登记 110 个受信动作契约 |
| 2 | `objects[].datasource` 是 URI 字符串（136 条） | 结构化 `{type,...,path}` | 改成对象 |
| 3 | `objects[].derived: true`（68 条） | `datasource.type='function'` | 删除该字段，改写成 datasource |
| 4 | `links[].roles`（125/93/124 条） | Palantir 无此字段；语义由 Link Type 表达 | 迁到 `extensions.roles`，或拆成独立 link type（待定） |
| 5 | `actions[].criteriaBindings` / `effects` | —— | **不迁**：`effects` 是编译器强制字段（无它直接拒绝已实现动作）；`criteriaBindings` 是 name→binding 记录，Palantir 的 `submissionCriteria` 是有序条件列表，改名等于谎报形状。实测见 commit 说明 |
| 6 | 接口属性 6/14、`propertyMap` 7/129 | 每个接口都有共享属性 + 全部实现有映射 | 根接口声明 + 实现映射（`accepting_v1`） |
| 7 | 接口 action 约束 1 条、`actionMap` 0 条 | 能力声明 + 实现侧绑定 | 先补基础关系，再绑定 |

已知硬约束（实测，不许绕）：

- 改 `actions[]` 内部结构 → 110 个 trusted 契约 digest 变化 → 必须重登记（`registry.registerAction`，按解析器期望形状，去掉 `resourceId`/`implementation`）；
- 接口属性联合 schema 不能带 `validatorRef`；带 `pattern`/`format` 的字段不能进 `anyOf`；
- 一个类型实现两个接口时，同名属性契约必须一致，否则 `Conflicting inherited property` ——
  所以接口属性**只在根接口声明**，子接口继承。

## 三、执行顺序（每步独立可验收）

1. **受信契约重登记**：把动作定义改成 Palantir 形状（含 `writeback`），重登记 110 个 handler，
   并断言「重登记条数 === 110」；
2. **datasource 结构化**：136 条 URI → `{type,path}`；68 条 `derived` → `{type:'function'}`；
3. **扩展字段归位**：`roles` / `criteriaBindings` / `effects` 进 `extensions`（或按需拆分）；
4. **接口属性**：根接口声明 `id` + 共享属性，实现侧 `propertyMap`，用 `accepting_v1`；
5. **接口关系约束**：从 5 条扩到可证明的族（证据/请求/时间）；
6. **接口 action 能力 + `actionMap`**：先 `MergeIdentity`，再 `AttachEvidence`；
7. 全链验证：接口查询 → 关系导航 → 动作解析并执行，三步各有断言。

每步都是新内核层或对未发布层的修改；**已发布的 v27–v37 一律不改**。

## 四、验收判据

- 任意对象类型：逐个比对 v37 与重构后版本的 `properties` / `primaryKey` **逐字节相同**；
- `tsc --noEmit` 0；`ontology-integrity` 全绿（含新层指纹）；
- 接口查询能返回属性（不是只有类型集合）；
- 关系导航能读回边属性；
- 动作能经接口解析出具体 action 并执行一次。

## 五、接口身份属性：实测结论（2026-11-13）

试了三轮，每轮撞到不同的门禁，按顺序记录：

1. `Unknown optional interface property` —— 我先用 `iface.properties = {id}` **整块覆盖**，
   把已有接口的 `optionalProperties` 引用全部打空。改为**合并**后此错消失；
2. `Conflicting inherited property` —— 一个类型实现两个接口、两者都声明同名属性时契约必须一致；
3. `Incompatible interface property: Place.id` —— 最终挡住的地方：接口声明 `id`，实现侧是
   `placeId`（uuid/pattern 类 schema），结构性兼容检查判定不兼容。

第 3 条是**模型缺口**，不是数据问题：`acceptingCompatible()`（`accepting_v1`）能接受「更窄的实现」，
但这条检查走的是结构全等路径，且在 `propertyCompatibility` 生效之前执行。要让接口声明身份属性，
必须先让这条检查认识 `accepting_v1`，否则任何 `X.id ← placeId` 的映射都会被判不兼容。

未做，不谎报完成。

### 根因已定位到函数级（`model.ts:157 acceptingCompatible`）

| 行 | 规则 | 对接口身份的影响 |
|---|---|---|
| 160 | `if (actual.kind !== expected.kind && !timestampView) return false` | 接口只有**一个** kind，实现者主键 kind 不同就一定失败 —— 所以「允许不同 kind」在现有实现里做不到 |
| 167 | `Object.keys(x).some(key => !scalar.has(key))` → false | `anyOf` 不在 scalar 白名单 → 联合 schema 一律判不兼容 |

结论：要让接口声明身份属性，必须扩展 `acceptingCompatible`：
- 期望侧 schema 为 `anyOf` 时，逐个成员递归判定（任一成员接受即通过）；
- kind 检查在联合场景下改为「成员之一 kind 相符」。

这是**一个函数的改动**，不是模型层能绕过的。改动前需要保证 `tests/interface-property-acceptance.test.ts` 6 条断言仍全绿，并补两条联合 schema 用例。
