# 接口属性：设计与失败记录

目的：让「接口声明属性、实现映射属性」在 EIGOS 里成立，且**不靠试错**。
本文件记录 6 次失败撞到的每一道门禁，以及唯一可行的设计方向。

## 一、Palantir 的模型（对照基准）

- 接口**声明**属性（apiName + type + 是否必需）；
- 每个实现**映射**自己的字段到接口属性（`propertyMap`）；
- 接口属性的类型是**声明宽度**，实现只能更窄，不能更宽；
- 一个类型可以同时实现多个接口，同名接口属性必须一致（否则该类型无法同时满足）。

关键点：**Palantir 的接口属性类型是「多态」的** —— 它允许一个接口身份属性在不同实现上
取不同底层类型（如 uuid / 业务编号），接口本身描述的是语义（"这是该对象的稳定标识"），
不是某一种字符串约束。

## 二、6 次失败的门禁（按撞到的顺序，全部实测）

| # | 层次 | 报错 | 根因 |
|---|---|---|---|
| 1 | 模型层 | `A trusted validator does not match the declared schema` | 把实现侧属性的 `validatorRef` 一起复制到接口属性上；受信校验器绑定的是**某一实现的 schema**，接口无法复用 |
| 2 | 模型层 | `Patterns require a bounded string and a simple expression with at most one quantifier` | 把带 `pattern` 的 ID 属性塞进 `anyOf`，schema 守卫直接拒绝 |
| 3 | 模型层 | `Unknown optional interface property` | 用 `iface.properties = {id}` **整块覆盖**，打空了既有 `optionalProperties` 引用的名字 |
| 4 | 模型层 | `Conflicting inherited property` | 一个类型实现两个接口、两者都声明同名属性；契约必须逐字一致 |
| 5 | 编译器 | `Incompatible interface property: Place.id` | `acceptingCompatible` 第 160 行要求 `actual.kind === expected.kind`，接口只有一个 kind，混合 kind 必然失败 |
| 6 | 编译器 | 同上（改了 `required:false`、单一基线、只映射同签名实现者后仍失败） | 第 167 行的 scalar 白名单把 `anyOf` 直接否掉；加联合分支后**分支从不执行**，因为 `validationSchema()` 归一化后 `anyOf` 不保留 |

第 6 条需要更正：复查 `model.ts:134 validationSchema()` 后确认它**保留** `anyOf`（第 140 行显式处理）。
所以当初「归一化把 `anyOf` 丢了」的判断不成立，联合分支没被触发另有原因 —— 最可能是
`propertyMetadata(expected).schema` 已经是编译后的 zod 对象，`validationSchema()` 对非普通对象原样返回，
于是读不到 `anyOf`。下一次应当先打印 `propertyMetadata()` 的返回值确认，而不是继续改规则。

结论仍然是：**用 `anyOf` 表达接口属性收益低**（第 167 行白名单 + 归一化路径双重不确定），
显式多态字段是更稳的方向。

## 三、唯一可行的设计

### 3.1 接口属性要显式表达「多态」

不要在属性 schema 里塞 `anyOf`。给接口属性加一个**判别字段**：

```
InterfaceProperty = {
  name, kind,                // 语义宽度：'identity' | 'string' | 'timestamp' | ...
  polymorphic?: true,        // 声明：允许各实现取不同底层 schema
  accepts?: string[]         // 允许的实现侧 schema 签名（可选，留空=只校验语义宽度）
}
```

`acceptingCompatible(actual, expected)` 增加一条优先规则：

```
if (expected.polymorphic) return actual.kind !== undefined && satisfiesSemanticWidth(actual, expected)
```

即：**多态属性只校验语义宽度，不校验具体 schema**。这是 Palantir 的做法（接口描述语义），
也是唯一不与现有 scalar 白名单冲突的做法 —— 不需要 `anyOf`，不需要改归一化。

### 3.2 `propertyMap` 的解析必须先于兼容检查

第 5 次失败暴露的一个实现细节：`propertyName(objectId, interfaceId, alias)` 决定「实现侧
哪个字段承担这个接口属性」。设计上应保证：

- `propertyMap` 存在 → 用它；
- 不存在 → 同名字段；
- 都没有 → 若接口属性 `polymorphic` 且指向 primaryKey，则**自动映射到 primaryKey**。

否则「接口 id ← placeId」永远解析不到，兼容检查拿不到 actual，直接判不兼容。

### 3.3 同名接口属性的冲突要**编译期报错并给出解法**

第 4 次的错是对的，但信息不够。应报成：

```
Type X implements A and B, both declare `status` with different contracts;
either unify the declarations or give one of them a different apiName.
```

## 三点五、第 7 次失败：归一化会吞掉新字段

按 3.1 实现 `polymorphic` 后，规则写好、编译通过、原有断言全绿，但两条新断言 fail：

```
not ok - a polymorphic interface property accepts an implementation with a different schema
not ok - a polymorphic interface property still rejects a restricted implementation
```

原因：`propertyMetadata()` 把属性归一化成**它认识的字段集合**，`polymorphic` 被丢掉，规则永远读到 `undefined`。
这与第 6 次（`validationSchema()` 丢 `anyOf`）是**同一类问题**：模型里有两层归一化，
任何新字段/新结构都必须先在这两层登记，否则写再多规则也不会被触发。

## 四、实施顺序（每步可独立验收）

0. **先改两层归一化**（这是前置，不做则后面全部无效）：
   - `propertyMetadata()` 的白名单加入 `polymorphic`；
   - `validationSchema()` 对未识别结构**不再静默丢弃**，改为保留或显式报错 —— 静默丢字段是前面 3 次失败的共同根因；
1. `InterfaceProperty` 增加 `polymorphic` 字段（schema + 类型 + `describeType()` 投影）；
2. `acceptingCompatible` 增加多态优先规则 + 单测（多态接受、非多态仍严格）；
3. `propertyName` 增加 primaryKey 自动映射 + 单测；
4. 接口身份属性落地：`polymorphic: true` 的 `id`，所有实现者 `propertyMap.id = primaryKey`；
5. 接口查询回归：`concreteTypes('CitableObject')` 与属性读取同时成立。

## 五、不做的事

- 不用 `anyOf` 表达接口属性（会被守卫与归一化两处打掉）；
- 不把实现侧 `validatorRef` 抄到接口上（受信校验器是实现的私事）；
- 不为通过检查而放宽 `required`（会让接口约束失去意义，第 5/6 次已证明这样做也过不了）。
