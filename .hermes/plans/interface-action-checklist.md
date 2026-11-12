# 接口动作约束 + actionMap：全部校验点清单

一次性迁移的前置条件。列出「接口声明动作能力 → 实现者 actionMap 绑定 → 调用」这条链上
**每一个会拒绝输入的检查点**，按执行顺序排列。改这个功能必须一次改完这些点，否则会像前几次一样
「改一层、下一层报错」。

来源：对 `packages/ontology/*.ts` 的机械扫描（119 个与 interface/action/mapping 相关的检查），
下表只保留与「接口动作」直接相关的。

## A. 定义层 schema（`definition-contracts.ts`）

| 位置 | 现行要求 | Palantir 要求 | 处置 |
|---|---|---|---|
| `serializableInterfaceSchema.actions` | `{id, inputs, effects, resultTypes?, optional?, ports?}` 全必填 | `{apiName, description, required, parameters[{apiName,type,required,many}]}`，**无 effects/inputs** | 改为新形状；旧形状仅在 v36 及以前兼容 |
| 同上 `actions[].id` 必填 | 必填 | `apiName` | 字段改名 + 双形状过渡 |
| `interfaceImplementation.actionMap` | `Record<name, {actionId, inputMap, outputMap?}>` | `Dict[InterfaceActionTypeConstraintApiName, ActionTypeApiName]`（**字符串**） | 改为字符串映射（Palantir 形状），若保留对象则必须允许空 `inputMap` |
| `interfaceImplementation.links` | `Record<约束名, 关系名>`（单值） | `Dict[约束名, List[关系名]]` | 允许数组 |

## B. 模型编译校验（`model.ts`，按执行顺序）

| 行 | 错误信息 | 现行条件 | 处置 |
|---|---|---|---|
| 349 | `Invalid interface action constraint` | 要求 `inputs` 非空、`effects` 非空且在白名单内、`resultTypes` 可解析 | 新形状下改为校验 `parameters`（类型在白名单、名字合法）；**不得要求 effects** |
| 353 | `Unknown interface action mapping` | `actionMap` 的 key 必须是已声明的约束名 | 约束名改为 `apiName` 后同步 |
| 357 | `Missing interface action implementation` | required 约束未被映射即报错 | 保留（Palantir 同语义） |
| 359 | `Unresolved interface action implementation` | 映射到的动作必须存在 | 保留 |
| 369 | `Incompatible interface action mapping` | 参数兼容性判定 | **改为按参数形状判定**（约束参数必须是动作参数的子集），不再看 effects |
| 371 | `Interface ports require an explicit action composition contract` | 有 ports 才要求 composition | 保留（与本次无关） |
| 375–388 | 端口映射系列 | ports 相关 | 保留（Palantir 无 ports 概念，属 EIGOS 扩展，标注即可） |
| 460 | `An inherited required interface capability cannot become optional` | 继承规则 | 保留（与 Palantir 一致） |
| 468 | `Conflicting inherited interface action` | 双接口同名能力 | 保留，但**报错须带解法** |
| 646 | `Object does not implement the action interface` | 调用前检查实现 | 保留 |
| 647 | `Unknown interface action constraint` | 约束名解析 | 随改名同步 |
| 649 | `Optional interface action is not implemented by this type` | optional 未映射时的行为 | **保留但只警告不拒绝**（Palantir：optional 可跳过） |
| 650 | `Ambiguous interface action mapping` | 多义映射 | 保留 |

## C. 编译器（`model-compiler.ts`）

| 行 | 错误 | 说明 | 处置 |
|---|---|---|---|
| 324 | `Implemented actions require declared effects` | 动作必须有 effects | **保留**（这是动作层，不是接口层） |
| 325 | `Action effects omit an operation effect` | 同上 | 保留 |
| 122/129 | 受信动作契约解析 | 改动作结构需重登记 | 本次不动动作结构，无需重登记 |

## D. 执行层（`declarative-actions.ts`）

| 行 | 错误 | 说明 |
|---|---|---|
| 44 | `Interface invocation is missing a mapped argument` | 经接口调用时参数映射 |
| 51 | `Interface invocation contains a conflicting concrete argument` | 同上 |
| 55 | `Interface action must bind the exact target object` | 目标必须精确绑定 |

这三条是**运行时**行为，接口约束改成 Palantir 形状后仍然成立，无需改。

## E. 这次迁移的最小闭环（按顺序）

1. `definition-contracts`：接口 `actions` 支持新形状（apiName/required/description/parameters），`actionMap` 允许字符串或空 `inputMap` 对象，`links` 允许数组；
2. `model.ts:349` 校验改为「有 parameters 就按 parameters 校验，不看 effects」；
3. `model.ts:353/357/369/647/649/650` 的约束名解析改读 `apiName ?? id`；369 改为参数形状兼容判定；
4. `palantir-model-kernel.ts`：v37 里把约束重写成新形状，并按「动作参数 ⊇ 约束参数」自动绑定 `actionMap`；
5. 验收：`actionMap` 非零、`constraints` 计数 > 0、`tsc` 0、integrity 全绿、v35/v36 指纹不变。

## F. 已知陷阱（前 7 次失败的具体原因）

| 现象 | 真因 |
|---|---|
| `Unknown interface action mapping` | 约束名 key 与声明不符（改 apiName 后必须同步） |
| `expected object, received string` | `actionMap` 的 EIGOS schema 是对象，Palantir 是字符串 |
| `Cannot convert undefined to object` | 老校验直接读 `constraint.inputs` / `constraint.effects` |
| `Unrecognized keys` | zod `strictObject` 逐个字段枚举，加字段必须改 schema |
| `nameSchema.parse(constraint.id)` | 校验器假定 `id` 存在 |
| `Projection-only ...` | 已于本轮删除 |
| `Incompatible interface property` | 已由子类型判定解决 |
