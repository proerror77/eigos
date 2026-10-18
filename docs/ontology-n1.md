# N1：可查询的业务对象模型

2026-10-18。实现范围：本地 TypeScript／Zod 定义、同一 SQLite 内的对象与关系、受认证保护的只读查询、来源投影和三个场景的合成验证。建模基线见 [对象目录](ontology-model-catalog-v0.2-2026-10-18.md)。此实现不依赖 Foundry，也没有执行真实订单、付款或预订。

## 构件与身份

- 28 个具体 Object Type，包括 Parcel、DeliveryRoute、DeliveryQuote、ProductOffer、OrderLine、DeliveryAllocation、ReservationSlot、Reservation、Payment 和 SourceReceipt。
- Offer 是接口，由 DeliveryQuote、ProductOffer、ReservationOffer 实现，继承 EvidenceBacked。接口只返回共用属性；对象引用仍保留实际类型。DeliveryQuote 的 `quoteId` 映射为接口的 `offerId`。
- 类型登记主键、标题、中文名称／别名、属性 schema／来源／权限、关系两侧名称和基数。实例按认证 owner、类型和 id 隔离，具有 revision、createdAt 和来源记录。
- 定义以 `eigos.business@1` 及摘要固定；对象及关系分别保存定义摘要。定义漂移被拒绝，不把历史值按新定义静默重解。历史执行后端没有兼容分支或自动回填。
- ServiceRequest.conditions 是有 schema 的组合值，固定对象／角色、predicateRef、阶段、操作符、类型化预期和原文依据。登记十种条件语义；缺失信息不补造。N2 才把新的条件结构接到模型解释／规划，现有通用 requirements 不会被自动改写。

Money 保存整数 minor 文本和明确币种；当前登记 CNY、USD、EUR，均为两位精度，未知币种拒绝。Quantity 支持最多六位小数；杯／件／人数须整数，包裹重量只允许 kg／g。时区须为有效 IANA 名称，坐标声明 degree 与已知参考系或 unknown。

## 查询接口

MCP 工具与 HTTP POST 使用相同输入、认证、会员资格和 owner。HTTP 返回结果对象；MCP 包装在 `structuredContent.result`。

| MCP | HTTP | scope |
| --- | --- | --- |
| `describe_ontology` | `/ontology/describe` | `services:read` |
| `query_ontology` | `/ontology/query` | `tasks:read` |
| `evaluate_ontology` | `/ontology/evaluate` | `tasks:read` |

发现定义：

```json
{"search":"报价","limit":3}
```

定义结果包含属性、schema、继承接口、双向关系、登记函数及两个仅供描述的 Action。可用 `after` 接着读；每页最多 5 个类型。技术租约、执行尝试和原始 RPC 不进入这个业务目录。

查询具体类型或接口的对象集：

```json
{"type":"Offer","select":["offerId","priceKind","isFresh"],"limit":10}
```

沿一个关系导航：

```json
{"from":{"type":"ServiceRequest","id":"任务UUID"},"link":"offers","limit":10}
```

上例按 Offer 接口返回共用字段。取得具体报价引用后，按该类型及主键查询领域属性：

```json
{"type":"DeliveryQuote","where":[{"property":"quoteId","op":"eq","value":"报价ID"}],"select":["quoteId","quotedWeight","serviceLevel","pricingTerms"]}
```

查询只支持登记字段、最多 8 个过滤条件、20 个选择字段和 50 个结果；单次最多检查 200 行，另取 1 行判断后续，结果项合计最多 60,000 字节。不会返回未完成扫描的总数。`items=[]` 仍可能有 `page.hasMore=true`，必须保留原参数和 cursor 继续查询；不能据此声称没有候选。游标固定 owner、查询、模型摘要和数据 revision；变化后返回 CONFLICT，需重新查询。计算最多读取 1,000 单位工作量，每次关系读取最多 50 个对象；超过范围保留 unknown 或明确拒绝，不能用截断结果算“全部”。

私有联系信息、地址源 ID 和回执原始载荷不进入查询。选择或过滤受限字段也被拒绝，反向关系、派生值及函数同样按 owner 检查。三个入口均没有写入能力。

## 登记函数与证据

`offerFreshness`、`deliveryQuoteMatches`、`withinBudget`、`productOfferMatches`、`remainingQuantity`、`actualArrival`、`slotAvailability`、`reservationStatus`、`reservationMatches` 为只读函数。输入契约由 MCP schema 暴露，业务说明和版本由定义目录返回。例如：

```json
{"function":"remainingQuantity","object":{"type":"OrderLine","id":"订单项ID"}}
```

结果有 known／unknown、值／原因、functionRef、模型摘要及证据引用与等级。`isFresh`、`remainingQuantity`、`actualArrivalAt`、`effectiveStatus` 是可显式选择的派生属性，不能写入。金额范围不完整、报价过期、错误证据范围、缺失来源或不匹配的版本均不能被推断成通过。

SourceReceipt 固定规范化对象属性和出向业务关系的摘要。改变交付数量、报价归属或对象版本后，旧回执不再支持新值；SourceReceipt 关系本身不参与该摘要。交付数量按已接受的分配计算，检查事件去重、规格、单位、订单／批次归属。订金与预订确认独立判断。合成证据及所有派生结果仍标记 synthetic。

RequestDeliveryQuote 和 SelectOffer 已有变更路径、输入类型及提交条件的**定义**；编译时检查变更路径存在、不能写派生值。返回 `execution=definition_only`，没有新的 Action 执行接口。模型驱动查询演练属于 N2，领域动作及整体结果聚合属于 N4。

## 当前任务的来源投影

JobStore 与对象库共用 SQLite 连接，任务保存和投影原子提交；重复保存相同结果不增加对象或数据 revision。写入仅供受信内部映射使用，支持显式 revision、端点归属、基数与批次回滚检查。

- 仅当前 `ontology-execution-v3` 的 `eigos.delegate` 在保存时投影 ServiceRequest；不扫描、迁移或自动恢复历史任务。
- 有完整且与固定计划关联的 Ontology MCP 回执时，`geo.search` 映射为 Place＋SourceReceipt，保持公开地点语义，不产生商家或 Offer。来源无原生 id 时使用回执内快照身份。
- 完成的 `delivery.quote` 回执映射为 Parcel、DeliveryRoute、DeliveryQuote、Provider、Channel、SourceReceipt。区分请求申报重量和实际计价重量；保留估价性质、未知费用范围及明确的五分钟本地刷新上限。该上限不是提供者承诺。
- 核对回执 schema、固定输入摘要、结果摘要、工具、来源调用及只读标记。投影覆盖为 request_only／typed_result／invalid_source；无效来源不产生部分业务对象，也不破坏已有独立任务记录。数据库冲突则使整个保存回滚。
- 本人完整地址簿仍由现有私有流程保存；N1 不把联系人、手机号和原生地址 ID 自动复制进对象查询。商品／预订对象目前只由合成数据验证。

## 验证和后续边界

合成数据由 [ontology-objects.ts](../tests/fixtures/ontology-objects.ts) 导出，不注入本人常驻数据库。查询／函数／权限／投影测试可复现：

```sh
npx tsx --test tests/ontology-objects.test.ts tests/ontology-scenarios.test.ts tests/ontology-projection.test.ts tests/ontology-query-gateway.test.ts
```

[验收记录](evidence/ontology-n1-2026-10-18/README.md) 区分模型规则验证、现有 PA 协议回归、工程 E2E 和远端 CI。九道业务题已有可用对象、导航和合成反例；**非建模者与新上下文 Agent 的独立演练尚未运行**。本轮没有调用真实来源／模型、更新常驻部署或产生现实业务副作用。
