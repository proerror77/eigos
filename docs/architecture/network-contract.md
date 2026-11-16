# 网络契约草案

二期让用户的 PA、EIGOS 和商户 agent 用同一套 Ontology 契约协作。对话可以用自然语言，承诺必须是 Interface Action，带类型化参数并返回回执。第一版草案定义在 `packages/ontology/network-contract.ts`，作为独立的 `EigosNetwork` v1 文档发布。业务定义尚未导入它，当前发布的定义和运行行为不变。

## 依据

- Interface 描述对象类型的形状和能力。工作流面向 Interface 编写，不依赖具体实现。[Interface 概览](https://www.palantir.com/docs/foundry/interfaces/interface-overview)
- Interface 声明 Action 约束，每个实现类型把约束映射到自己类型上的具体 Action。例如 Ticket 的“创建工单”约束由 Bug 类型的“创建 Bug”满足。必需约束每个实现都要映射，可选约束可以跳过，约束沿 Interface 继承传递。约束本身不能直接调用，要先按实现映射解析，再执行具体 Action。[Interface Action 约束](https://www.palantir.com/docs/foundry/interfaces/interface-action-type-constraints)

## 契约内容

| Interface | 属性 | Action |
| --- | --- | --- |
| `Commitment` | `state`、`termsDigest`、`expiresAt`（可选）、`receipts` | `hold`（可选）、`confirm`、`cancel`、`reconcile` |
| `TableReservation`，继承 `Commitment` | `restaurant`、`city`、`branch`（可选）、`date`、`time`、`partySize`（1–20）、`seating`（可选） | 全部继承 |

- `state` 的取值为 `offered`、`held`、`confirmed`、`fulfilled`、`canceled`、`expired`、`unknown`。报价、保留和确认是同一对象的不同状态，不是三种对象。
- `termsDigest` 是确切条款的摘要，用户批准（`approval.termsDigest`）和每张回执都绑定它。商户要改条款，只能给出新的 `offered` 对象。
- `confirm` 需要 `approval`（批准的条款摘要和批准时间）和 `contact`。联系方式只在确认时披露，可以是 EIGOS 的转接号码。三期把 `approval` 换成 AP2 的封闭式 Checkout Mandate。
- `reconcile` 用于回复丢失之后，按原单查回结果，不重新提交。
- 回执分两种：
  - `merchant_signed`：必须带签名，验签公钥随商户的 Agent Card 发布；
  - `merchant_confirmed`、`connector_receipt`、`pa_reported`、`synthetic`：EIGOS 观察到的结果，不带签名。

  两种回执用 `anyOf` 组合，实现方可以只声明自己会产生的那一种，例如订位试点只产生 `synthetic`。发布校验无法证明对象之间 `oneOf` 互斥，所以没有用 `oneOf`。
- 可订时段查询暂不放进契约。现有两个查询 Function 的参数不同（网页渠道没有门店参数），统一的查询参数和返回结构与 A2A 扩展一起确定。

## 引用方式

导入方通过现有的 `imports` 固定版本和摘要，并指定命名空间：

```ts
imports: [{ ontology: 'EigosNetwork', version: '1', digest, namespace: 'Net', document: networkContract }]
```

导入后，内部名称变为 `NetCommitment` 和 `NetTableReservation`，继承关系和 Action 约束里的对象参数类型也一起改名。摘要不符或命名空间重复时，拒绝加载。

## 同一契约的多个实现

调用方只使用 `NetTableReservation.confirm`，由 `Actions.resolve` 按对象类型选择映射到的具体 Action：

| 供给方 | 实现类型 | `confirm` 执行什么 | 回执 |
| --- | --- | --- | --- |
| 商户有自己的 agent | 新增类型，例如 `MerchantAgentBooking` | 经 A2A 发给商户 agent | `merchant_signed` |
| 只有官网订位页或小程序 | 现有的 `DiningReservation` | `SubmitDiningTestReservation` | 试点为 `synthetic`；上线后为 `connector_receipt` 或 `pa_reported` |
| 都没有 | 指向 EIGOS 托管 agent 的预订类型 | 店员在托管后台确认 | `merchant_confirmed` |

为此，发布校验调整了一条规则。

- **原规则**：Interface Action 的每个对象参数都要接受该 Interface 的全部实现类型。一旦加入第二个实现，各自只接受本类型对象的 Action 就无法发布。
- **新规则**：约束中如果只有一个参数能放入实现对象本身，这个参数只需接受该实现类型；其他对象参数仍须接受全部实现。如果有两个这样的参数，无法判断哪个是选中的对象，仍按原规则检查。

执行时，`Actions.checkInput` 仍会核对每个对象引用的类型。通过实现类型调用时，如果传入其他类型的对象，调用会被拒绝。

## 订位试点的差距

`tests/36-network-contract.test.ts` 逐项验证。现有 `DiningReservation` 补齐以下四处后能通过发布校验，缺任何一处都会失败：

1. 条款字段（餐厅、城市、门店、日期、时间、人数）和 `termsDigest`、`receipts` 成为可映射的顶层属性。现在条款放在一个 `terms` 结构里。
2. `state` 对齐契约的枚举：`prepared` 改为 `offered`，并增加 `canceled`。
3. 增加取消 Action，映射到 `cancel`。
4. `SubmitDiningTestReservation` 接收 `approval` 和 `contact`。

试点现有的字段约束（名称长度、`HH:MM` 时间格式、最多 8 人）已经在契约范围内，不需要改。`hold` 是可选约束，试点不实现。

## 边界与后续

这一版只包括契约和发布校验，以下内容都没有做：

- A2A 客户端和 Ontology 契约扩展；
- 消息格式和回执验签；
- 条款摘要的规范化方式；
- 商户注册表；
- 授权凭证。

后续顺序：

1. 订位试点补齐上述四处，定义升版，迁移 synthetic 数据。
2. 做 A2A 扩展：Agent Card 声明契约摘要和实现的 Interface，消息的数据部件携带 Interface Action 调用，EIGOS 校验签名和条款摘要。
3. 商户注册时，用 synthetic 数据把 `hold`、`confirm`、`cancel`、`reconcile` 跑一遍。回包通过契约校验、回执能验签，才能上架。
