# 契约模型重构：从「字段清单 + digest 全等」到「属性类型 + 子类型判定」

## 为什么重构（实测依据）

| 事实 | 数字 |
|---|---|
| `propertyMetadata()` 被调用 | 8 处（`model.ts`） |
| `digest(propertyContract(...))` 全等比较 | 3 处 |
| 加一个 `polymorphic` 语义花的尝试次数 | 8 次（每次卡在不同层） |
| 连带的缺口 | 接口属性 6/14、`propertyMap` 7/129、`actionMap` 0/129、逆向关系 0 对、`to.required` 1/991 |

根因一句话：**属性的语义 = `propertyMetadata` 里那张手写白名单**，兼容性 = **契约 digest 字符串相等**。
于是每加一个 Palantir 已有的概念，都要同时改白名单、改 digest、改校验，并且让全部既有契约失效。

## 目标模型

### 1. 属性类型注册表（替代白名单）

```ts
type PropertyType = {
  id: string;                    // 'string' | 'identity' | 'timestamp' | 'decimal' | ...
  base?: string;                 // 子类型关系：identity.base = 'string'
  accepts?: (actual: Schema, expected: Schema) => boolean;  // 可选的结构性判定
};
```

属性只引用类型 id；**不再把 schema 细节挤进一张扁平清单**。
`polymorphic` 这类特例字段随之消失——「接口身份属性」= 类型 `identity`，实现可以是任意 `identity` 子类型。

### 2. 兼容性 = 子类型判定（替代 digest 全等）

```
compatible(actual, expected) =
  isSubtype(actual.type, expected.type)
  && requiredImplies(actual.required, expected.required)
  && structural(actual.schema, expected.schema)   // 仅同类型内比较，不比跨类型
```

规则：
- 实现类型必须是接口类型的**子类型**（`identity ⊂ string`）；
- 接口 `required` ⇒ 实现必须 required（这条保留，Palantir 也这样）；
- **不再比较 `authority` / `derived` / `restricted`** —— 它们描述「谁写」，不是「什么值合法」（v36 已放宽，继续保持）。

### 3. digest 只管版本冻结，不管兼容性

现在 `propertyContract` 的 digest 同时承担两件事：版本指纹冻结 + 兼容性比较。这是大量痛苦的来源（改任何语义都让旧契约失效）。
重构后：**digest 仅用于 `assertRelease` 的冻结校验**；兼容性一律走子类型判定。

## 明确放宽的门禁（你要求：不要比 Palantir 更严）

| 现有门禁 | Palantir 行为 | 处置 |
|---|---|---|
| 属性契约 digest 必须全等 | 子类型即可 | **删**（本轮核心） |
| `Projection-only interfaces cannot introduce action constraints` | 无此限制 | **删**（EIGOS 自创） |
| 接口属性必须与实现逐字段同形 | 接口声明语义宽度 | **删**，改类型宽度 |
| 关系必须两端都声明侧名 | 单边声明即可 | **放宽**：允许单向声明，反向自动生成 |
| `Implemented actions require declared effects` | effects 可选 | **保留**（这是引擎执行需要，不是建模门槛） |
| 受信 handler digest 精确解析 | 同 | **保留**（安全底线，与建模无关） |

## 实施步骤（每步独立可验收，不动已发布内核）

1. **类型注册表**：新建 `packages/ontology/property-types.ts`，定义 ~8 个基础类型 + 子类型关系；不改现有行为，只提供 `isSubtype()`；
2. **兼容性切换**：`acceptingCompatible` 内部改为走 `isSubtype()`；保留旧分支作为 `structural_v1` 兼容路径；
3. **接口身份属性落地**：`id` 声明为 `identity` 类型，所有实现 `propertyMap.id = primaryKey`；验收 = `Incompatible interface property` 消失 + `concreteTypes()` 仍正确；
4. **接口查询返回属性**：`describeType(interface)` 输出共享属性 + 每个实现的实际映射；
5. **放宽门禁**：删除 projection-only action 限制，关系单边声明自动补反向；
6. **回归**：204 对象 × 1,863 属性的兼容性矩阵全绿；v27–v37 指纹逐字节不变。

## 验收判据

- 接口属性：14/14 接口有共享属性，129/129 实现有 `propertyMap`；
- `actionMap` 绑定：能力声明数 = 实现绑定数；
- 逆向关系：991 条关系里每个有意义的族都有 `inverseOf`；
- **不加严**：任何一项现有测试不得因为「更严格」而失败；放宽的门禁要有测试证明放宽后仍拒绝真正非法的输入。

## 与 Palantir 的对齐结论（重构后预期）

| 层 | 现在 | 重构后 |
|---|---|---|
| 语义层 | 结构在、语义缺（逆向 0、基数 1/991） | 类型系统 + 反向关系 |
| 动能层 | writeback 已补（63） | 保持 + 接口能力绑定 |
| 接口层 | 属性 6/14、映射 7/129 | 属性 14/14、映射 129/129 |
| 治理 | 比 Palantir 严 | 保留指纹冻结，删自创门禁 |
