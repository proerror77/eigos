# 关系属性写入 + 接口链路打通（v37）

## 为什么需要这一层

v36 在 125 条证据关系上声明了四个属性（`evidenceLevel` / `observedAt` /
`confidence` / `sourceRevision`），但写入契约只接受 `{type, from, to}` —— 声明的契约
写不进去，等于说谎。要么撤掉声明，要么把写入路径补齐。本文是补齐的完整改法。

链路目标：**接口查询 → 关系导航 → 动作执行**，三者都要在真实存储上跑通。

## 现状（已证明的部分）

| 环节 | 状态 | 证据 |
|---|---|---|
| 接口查询 | ✅ | `concreteTypes('CitableObject')` = 102 个类型 |
| 关系约束强制 | ✅ | 篡改端点 → `Unresolved interface link on Parcel` |
| 关系角色 | ✅ | 125 EvidenceOf / 93 Observation / 124 Scope |
| 关系属性**声明** | ✅ | 125 条证据边带 4 个属性定义 |
| 关系属性**写入** | ❌ | `ontology-links` 表无 properties 列；`batchSchema.links` 只收 type/from/to |
| 动作映射 | ⚠️ | 1 条 optional 能力声明，0 个实现者绑定具体 action |
| 动作执行 | ⚠️ | 运行时可用，但没有经接口解析的动作可调用 |

## 改动清单（按依赖顺序，每步可独立验收）

### 1. 模型层：关系也可以有属性

- `packages/ontology/model.ts`：`LinkDefinition` 增加 `properties?: Record<string, PropertyDefinition>`。
- 校验：`ObjectTypeDefinition.links[]` 声明的属性必须被模型接受（复用 propertySchema 编译）。
- 验收：`tsc` + 一个只读断言（v36 的 125 条证据边能解析出属性定义）。

### 2. 写入契约：允许并校验关系属性

- `packages/ontology/object-store.ts:62` `batchSchema.links` → `{ type, from, to, properties?: record }`。
- 写入时：按该 link 的 `properties` 定义逐字段 `safeParse`；未声明的字段 → **拒绝**（fail-closed），不能静默丢弃。
- `LinkWrite` 类型同步加 `properties?`。
- 验收：单测 —— 合法属性写入成功；未知字段被拒；类型不符被拒。

### 3. PostgreSQL 表结构

- `packages/postgres/business-schema.ts`：`ontology_links` / `ontology_scoped_links` 增加
  `properties JSONB`（可空，存量行为 null，不回填）。
- 迁移必须是 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，不重建表、不改主键。
- 验收：在 `of-pg`（5433）上建表两次（幂等）+ 插入带属性的边 + 读回。

### 4. 关系读取路径

- `packages/postgres/business-snapshot.ts`、`planning-read-graph.ts`、`projection-graph.ts`
  的链接查询 SELECT 加 `properties`，并在返回结构中暴露。
- 关系导航（`related()` / `query({from, link})`）返回的每条边带属性。
- 验收：写入带 `observedAt` 的边 → 导航读回同一个 `observedAt`。

### 5. 动作能力落地（让接口真的能调用动作）

- 为 1–2 个真实类型各建一个具体 action，绑定到 `AttachEvidence`：
  - `packages/ontology/<domain>.ts` 里新增 action 定义；
  - 实现侧 `interfaces[].actionMap = { AttachEvidence: { actionId, inputMap } }`。
- `resolveInterfaceAction(type, interfaceId, 'AttachEvidence')` 必须解析出具体 action + 输入映射。
- 验收：解析器返回 action；`describeType(type).interfaces[].actionMap` 可见。

### 6. 端到端验证脚本（这一步定义「通」）

`tests/interface-chain.test.ts`：

1. 建两个对象（一个 `Place`、一个 `SourceReceipt`）；
2. 用带属性的证据边连接它们（`evidenceLevel: 'primary'`、`observedAt`）；
3. **接口查询**：`concreteTypes('CitableObject')` 包含该类型；
4. **关系导航**：从对象沿 `EvidenceOf` 角色找到回执，属性完整；
5. **动作执行**：经 `resolveInterfaceAction` 拿到具体 action，跑一次真实执行并写回属性；
6. 反向守门：未知属性字段被拒绝、无证据关系的地点复用被拒绝。

### 7. 发布与门禁

- `packages/postgres/definition-store.ts:81` 接受 v36/v37；
- `packages/security/model-review.ts:12` 走正常复审（不是绕过）；
- `security:s0` 基线刷新并写明每个变更面的原因。

## 顺序与回滚

1 → 2 → 3 → 4 → 6（先证明通）→ 5 → 6（补动作）→ 7。

每一步单独提交，任何一步红了就回退该步，不回退整条链：
表结构改动（第 3 步）是唯一不可轻退的一步，故放在校验与写入契约之后。

## 明确不做

- 不为了让接口编译而改写任何对象的属性契约（v36 的教训）；
- 不在没有证据链的情况下复用已知地点；
- 不把 link 属性当作对象属性来读（导航返回的边属性必须来自边本身）。
