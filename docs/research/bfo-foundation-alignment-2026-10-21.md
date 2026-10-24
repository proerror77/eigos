# BFO 通用本体与 EIGOS 领域模型对照

研究日期：2026-10-21。范围：BFO、CCO、IAO、PROV-O 官方规范与发布工件，以及当前工作区的领域模型。本次只作研究与参考映射；没有导入 OWL、生成 RDF、运行本体推理机或改变执行存储。文中的“建议／推断”是 EIGOS 设计判断，不是上游标准对本项目的认证。

## 1. 结论与采用范围

**建议以 BFO 检查概念边界，以 CCO／IAO 补充人、组织和信息内容的通用模式，以 PROV-O 表达来源链；酒店、商品、跑腿的字段和完成条件仍由 EIGOS 领域模型负责。** 当前最有收益的工作是澄清每个对象究竟指称现实主体、规格、计划还是记录，随后维护一份版本固定的映射。没有必要为此重建数据库，或给每个对象再加一张通用 `Entity` 表。（项目推断；依据见下文。）

现有模型已分开稳定资源与不可变来源观察、用户要求与供应方条款、计划与执行尝试、回执接纳与业务完成。这些边界应保留。需要修正的是术语解释和未来对外映射的歧义，不能仅凭 `Entity`、`Role`、`Function`、`Observation` 的名称建立逻辑等价。

## 2. 已核实的官方基线

| 来源 | 本次核验的版本与精确工件 | 能用于本项目的事实 |
| --- | --- | --- |
| BFO 2020 | 官方 README 把 `21838-2/owl/bfo-core.owl` 列为当前发布入口。本次固定仓库提交 `bd1fb61c5fa4e358fc9690f0d214b1ac63fae594`（2026-10-06），读取同目录 Turtle 工件；其 `owl:versionIRI` 为 `http://purl.obolibrary.org/obo/bfo/2020/bfo-core.ttl`。[当前入口](https://github.com/BFO-ontology/BFO-2020#current-release) · [固定工件](https://github.com/BFO-ontology/BFO-2020/blob/bd1fb61c5fa4e358fc9690f0d214b1ac63fae594/21838-2/owl/bfo-core.ttl) | 提供跨领域顶层类别与关系；不提供完整的酒店或商品业务契约。[官方范围说明](https://github.com/BFO-ontology/BFO-2020#basic-formal-ontology) |
| CCO | 当前正式版本为 `v2.2`，2026-08-14 发布，提交 `0bc7d33e1bc09fd4693366119ab4e03cb0340042`；模块内部版本 IRI 使用 `2026-08-13`。例如 `https://www.commoncoreontologies.org/2026-08-13/AgentOntology`。[发布记录](https://github.com/CommonCoreOntology/CommonCoreOntologies/releases/tag/v2.2) · [固定模块](https://github.com/CommonCoreOntology/CommonCoreOntologies/blob/v2.2/src/cco-modules/AgentOntology.ttl) | BFO 之上的中层通用词汇，涵盖主体、信息、事件等；2.2 模块显式导入 BFO 2020。默认 `develop` 上的 3.0／4.0 规划不能当作已发布功能。[官方说明](https://github.com/CommonCoreOntology/CommonCoreOntologies#what-is-cco) · [路线说明](https://github.com/CommonCoreOntology/CommonCoreOntologies#recent-news) |
| IAO | `v2026-03-30`，2026-04-10 发布；工件版本 IRI 为 `http://purl.obolibrary.org/obo/iao/2026-03-30/iao.owl`。[发布记录](https://github.com/information-artifact-ontology/IAO/releases/tag/v2026-03-30) · [固定工件](https://github.com/information-artifact-ontology/IAO/blob/v2026-03-30/iao.owl) | 区分信息内容、数据和计划规范；发布文件与开发文件分别提供，不能混用。[官方入口](https://github.com/information-artifact-ontology/IAO#files) |
| PROV-O | W3C Recommendation，2013-04-30；命名空间 `http://www.w3.org/ns/prov#`。[固定规范](https://www.w3.org/TR/2013/REC-prov-o-20130430/) | 用实体、活动、责任主体及生成／使用／派生关系表达来源信息，不定义 EIGOS 的业务授权或验收规则。[起点模型](https://www.w3.org/TR/prov-o/#description-starting-point-terms) |

版本复现注意：上面固定的 CCO 发布工件才是本次基线。本次抽检 [Person](https://www.commoncoreontologies.org/ont00001262)、[信息内容](https://www.commoncoreontologies.org/ont00000958)、[计划](https://www.commoncoreontologies.org/ont00000974) 三个 CCO 术语 IRI 均返回 HTTP 200，但重定向至 `develop` 分支；因此“IRI 可访问”不等于“读到指定发布版本”。BFO／IAO 的抽检术语 PURL 也可解析，但定义核验仍以固定官方工件为准。

### BFO 的必要区分

下列类别、继承及不相交约束均见[固定 BFO 核心定义](https://github.com/BFO-ontology/BFO-2020/blob/bd1fb61c5fa4e358fc9690f0d214b1ac63fae594/21838-2/owl/bfo-core.ttl)。这里只保留本项目需要的分类：

| 通用概念 | 精确 IRI | 关键含义 |
| --- | --- | --- |
| 实体 | [BFO_0000001](http://purl.obolibrary.org/obo/BFO_0000001) | 顶层范围不限于物理对象。 |
| 持续体／发生体 | [BFO_0000002](http://purl.obolibrary.org/obo/BFO_0000002) ／ [BFO_0000003](http://purl.obolibrary.org/obo/BFO_0000003) | 前者跨时间保持身份；后者在时间中展开等；两类不相交。 |
| 物质实体 | [BFO_0000040](http://purl.obolibrary.org/obo/BFO_0000040) | 有物质部分的独立持续体。 |
| 过程 | [BFO_0000015](http://purl.obolibrary.org/obo/BFO_0000015) | 有时间部分、并有物质实体参与的发生体。 |
| 质量 | [BFO_0000019](http://purl.obolibrary.org/obo/BFO_0000019) | 依赖特定承载者；与角色、倾向的实现方式不同。 |
| 角色 | [BFO_0000023](http://purl.obolibrary.org/obo/BFO_0000023) | 由承载者所在情境成立的可实现实体。 |
| 倾向／功能 | [BFO_0000016](http://purl.obolibrary.org/obo/BFO_0000016) ／ [BFO_0000034](http://purl.obolibrary.org/obo/BFO_0000034) | 倾向依赖承载者的物理构成；功能是与演化或设计有关的倾向子类。角色与倾向不相交。 |
| 通用依赖持续体 | [BFO_0000031](http://purl.obolibrary.org/obo/BFO_0000031) | 可由多个载体副本承载的共同内容或模式。 |

### 中层信息与来源词汇

- **CCO** 的 [Person](https://www.commoncoreontologies.org/ont00001262)、[Organization](https://www.commoncoreontologies.org/ont00001180)、[Plan](https://www.commoncoreontologies.org/ont00000974) 可作为主体与计划的候选参考。其 [Agent](https://www.commoncoreontologies.org/ont00001017) 被定义在物质实体之下，不能仅因为 EIGOS 使用“Agent”一词，就把软件配置或发布档案等同为该类。[2.2 Agent 模块](https://github.com/CommonCoreOntology/CommonCoreOntologies/blob/v2.2/src/cco-modules/AgentOntology.ttl)
- **CCO 信息模块**区分信息内容、描述性内容、规范性内容、测量内容，分别为 [ont00000958](https://www.commoncoreontologies.org/ont00000958)、[ont00000853](https://www.commoncoreontologies.org/ont00000853)、[ont00000965](https://www.commoncoreontologies.org/ont00000965)、[ont00001163](https://www.commoncoreontologies.org/ont00001163)。2.2 中规范性内容的正式标签为 `Prescriptive Information Content Entity`；不要从旧示例拼造 `cco:DirectiveInformationContentEntity` 作为当前 IRI。[2.2 信息模块](https://github.com/CommonCoreOntology/CommonCoreOntologies/blob/v2.2/src/cco-modules/InformationEntityOntology.ttl)
- **IAO** 的信息内容 [IAO_0000030](http://purl.obolibrary.org/obo/IAO_0000030) 是关于某物的通用依赖持续体；计划规范 [IAO_0000104](http://purl.obolibrary.org/obo/IAO_0000104) 包括动作与目标规范；关于关系为 [IAO_0000136](http://purl.obolibrary.org/obo/IAO_0000136)。当前 [IAO_0000027](http://purl.obolibrary.org/obo/IAO_0000027) 标签为 `data entity`，其定义还有可靠获取方法的条件，不能把任意未核实文本自动提升为该类。[IAO 固定定义](https://github.com/information-artifact-ontology/IAO/blob/v2026-03-30/iao.owl)
- **PROV-O** 提供 [Entity](http://www.w3.org/ns/prov#Entity)、[Activity](http://www.w3.org/ns/prov#Activity)、[Agent](http://www.w3.org/ns/prov#Agent)、[SoftwareAgent](http://www.w3.org/ns/prov#SoftwareAgent)，以及 [wasGeneratedBy](http://www.w3.org/ns/prov#wasGeneratedBy)、[wasDerivedFrom](http://www.w3.org/ns/prov#wasDerivedFrom)、[wasAttributedTo](http://www.w3.org/ns/prov#wasAttributedTo)。`prov:Entity` 允许数字、概念甚至想象对象，因此不应与 BFO 顶层实体作未经论证的全局等价。[官方定义](https://www.w3.org/TR/prov-o/#cross-reference-starting-point-terms)

**项目推断：**先选 CCO 或 IAO 的信息内容模式作为主映射，另一套保留参考关系；不要因定义相近便同时导入并声明类等价。正式采用时还需检查完整依赖、公理及版本兼容性。

## 3. 逐组对照现有模型

本节是依据代码与上文定义作出的**参考映射与设计推断**，不声称现有 TypeScript 类型已经是 BFO／OWL 类。数据库有一条记录，不决定其对外 IRI 指称记录内容还是被描述的现实对象；正式导出前必须写清楚。

| 现有概念与代码依据 | 推荐指称／候选映射 | 已有正确边界与待澄清点 |
| --- | --- | --- |
| `Provider`、`HotelProperty`、`TransportVehicle`：[业务模型](../../packages/ontology/business-model.ts)、[服务领域](../../packages/ontology/service-domains.ts) | 有确切依据时分别指称人／组织、酒店设施、具体车辆；这些对象的记录内容另作信息内容。 | `Provider` 未限定自然人或组织；`HotelProperty` 的经营主体与物理物业不宜自动等同。车辆来源引用已区别于车型等级。不要把所有此类记录统一声明为物质实体。 |
| `ProductVariant`、`RoomType`、`VehicleClass`：[商品属性](../../packages/ontology/product-attributes.ts)、[服务领域](../../packages/ontology/service-domains.ts) | 来源商品变体身份／规格、房型、车型分类；适合信息规范或标识模式。 | `ProductVariant` 表达商家命名空间中的规格身份，不是一件有序列号的实物。价格库存已经分离；如未来核验具体实物，再按实际需要增加实物身份，不能把当前变体 ID 直接用作实物 IRI。 |
| `SourceReceipt`、`*Observation`、`CommerceProduct`：[业务模型](../../packages/ontology/business-model.ts)、[来源观察](../../packages/ontology/service-domains.ts)、[商品链接](../../packages/ontology/product-attributes.ts) | 信息内容／`prov:Entity`；观察、查询、标准化活动才是独立的过程／`prov:Activity` 候选。 | 不可变观察、来源版本、摘要和稳定资源链接已经存在。`Observation` 在这里是观察记录，不能直接映射成观测活动；回执生成时间也不自动等于业务发生时间。 |
| `TransportDriver`、`TransportAssignment`：[服务领域](../../packages/ontology/service-domains.ts) | 前者是来源限定的驾驶人引用；实际人可候选映射到 CCO Person。驾驶角色由该人承载；派车分配是关于人、车和业务范围的分配记录。 | 已区分自驾顾客资格和提供方司机，并保留实际派车关系。不要把 `TransportDriver` 整体映射为 BFO role；名字、联系方式和派车记录各自不证明已送达。 |
| `TransactionPartyRole`、`ChannelParticipation`：[跑腿模型](../../packages/ontology/errand-model.ts)、[业务模型](../../packages/ontology/business-model.ts) | 角色分配／参与关系的证据记录；真正的角色实例另需明确承载者、情境与有效时间。 | 当前 `TransactionPartyRole.assignment` 固定范围、版本、签发方、期限和撤销链，适合作为信息记录。收发方指向 `SavedAddress`，地址不是角色承载者本人；因此不能直接声明该记录为 BFO role。无需为此制造未经核实的 Person。 |
| `typedAttributes`、`declaredWeight`、`parcelDetails`、`handlingRequirements`：[商品属性](../../packages/ontology/product-attributes.ts)、[跑腿模型](../../packages/ontology/errand-model.ts) | 区分实际属性、来源声明值、实测数据、用户要求。字段值本身不等于 BFO quality；只有确为测量所得时才候选使用测量内容模式。 | 已声明包裹质量是用户申报、外观等是来源规格；配送核验的 `physicalAttributes` 保持 `unknown`。应保留该边界，不能从目录颜色或容量推断实物已验收。属性还包含标识、类别和条件，不宜整体归为质量。 |
| `HotelRatePlan`、`RoomInventory`、`ProductOffer`、`DeliveryQuote`：[服务领域](../../packages/ontology/service-domains.ts)、[业务模型](../../packages/ontology/business-model.ts) | 套餐／报价的条款内容、特定时间范围的可用性陈述。 | 房型、套餐、库存和报价已分开。早餐、儿童、取消、报价期限等属于 EIGOS 领域契约；BFO 不会替项目补齐这些字段。 |
| `ServiceCapability`、`RegisteredCapability`、`NetworkListing`：[目录](../../packages/ontology/capability-catalog.ts)、[网络模型](../../packages/ontology/network-model.ts)、[术语](../../CONTEXT.md) | 能力定义、配置或来源声明是信息内容；真实能力需要具体承载者与实现条件的证据，不能直接等同 BFO disposition。 | 注册可见性、表示关系、执行绑定和权限已分别表达。`CapabilityClaim` 是术语中的声明概念，不能把它说成已实现的独立持久类型。 |
| `ExecutionPlan`、`ExecutionStep`、`RequestConstraint`：[执行模型](../../packages/ontology/execution-model.ts) | 计划／动作意图／约束的信息规范；计划可候选参考 IAO 计划规范或 CCO Plan。 | 已固定计划摘要、依赖、请求版本和输入；有计划不意味着已存在一次实际执行过程。正式计划映射还需表达其动作与目标组成。 |
| `ExecutionAttempt`：[执行模型](../../packages/ontology/execution-model.ts) | 持久节点是调用／核对尝试的记录；其所描述的实际调用可投影为过程／`prov:Activity`。 | `dispatch`、`observe`、`reconcile`、`resume` 已区分。不能把一次查询调用认作供应方履约过程，也不能把本地开始记账时间直接当成供应方过程起点。 |
| `ExecutionResult`、`OutcomeAssessment`、`RideTrip`、`DeliveryEvent`：[执行模型](../../packages/ontology/execution-model.ts)、[业务模型](../../packages/ontology/business-model.ts)、[服务领域](../../packages/ontology/service-domains.ts) | 结果／评估／来源事件记录是信息内容；实际旅程、配送等过程另有指称。 | 已区分验证、账本接纳、任务应用及业务完成。`RideTrip` 包含 `requested`／`unknown` 等状态，不能将所有该类型实例无条件映射为已发生的乘车过程。 |
| `FunctionDefinition`、`ActionDefinition`：[元模型](../../packages/ontology/model.ts) | 应用函数和动作契约；如要交换其内容，可描述为软件／动作规范。 | 程序计算函数不等于 BFO function；动作类型定义不等于一次实际动作，更不自动授予执行权限。 |
| `NetworkProfile`、`NetworkPublication`、`NetworkRepresentation`：[网络模型](../../packages/ontology/network-model.ts) | 公开档案、发布内容、表示关系的受控视图／信息记录。 | 代码已声明档案不是销售或履约法律主体，发布可见性不是授权。不要用 CCO Person／Organization 自动给一个档案背书。 |

实质问题集中在**指称容易混用**，而不是现有记录分层失效：`CONTEXT.md` 的“Entity 是具有持续身份的业务对象”是应用层用法，比 BFO 顶层 `entity` 窄；`Function` 是程序用法；`TransactionPartyRole` 的名字隐藏了“分配证据记录”；`RideTrip` 等结果名容易被误读为实际过程。最小修正是补充这些语义说明，而非立刻重命名持久类型或迁移已有 ID。（项目推断；[当前术语](../../CONTEXT.md)）

## 4. 推荐分层与最小改动顺序

建议分为四层：

1. **通用语义参考**：BFO 提供类别边界，选择性参考 CCO／IAO 的人、组织、计划和信息内容。
2. **EIGOS 领域契约**：保留商品、报价、酒店套餐、派车、跑腿、验收的类型与字段；为每类写清指称、来源、身份和生命周期。
3. **证据与来源**：现有观察、回执、版本、摘要和有效期作为事实依据；若需互通，再映射到 PROV-O。
4. **执行与权限**：继续由现有任务、绑定、授权、租约、重试、取消和验收规则控制；本体归类不授予权限。

以上为项目设计推断，按收益建议依次推进：

| 顺序 | 最小交付 | 可证伪的验收点 | 是否改执行存储 |
| --- | --- | --- | --- |
| 1 | 更新术语与各类型说明：明确实物／规格、主体／角色／角色记录、声明／实测、计划／过程／结果记录。以本表作为审查清单。 | 同一案例中，目录规格与实际送达实物、司机与派车分配、计划与实际尝试能被分别指出；来源不足保留未知。 | 不需要。 |
| 2 | 有消费者需要时增加独立映射清单，记录本地类型、指称说明、候选 IRI、上游版本、映射状态与适用条件。默认只用“参考／待核实”，不写无依据的类等价。 | `ProductVariant` 不被归为具体实物，`TransactionPartyRole` 不被归为角色本身，程序 `Function` 不被归为 BFO function。 | 不需要；可先用文档或独立元数据。 |
| 3 | 明确交换需求后做单向 RDF 导出试点：仅选一条有来源的商品或打车链；记录内容与被描述主体使用不同语义 IRI，复用已有 ID、版本和链接。 | RDF 可解析；每条派生关系能回溯现有来源；不导出私密字段或撤销后不可见的网络关系；不凭记录凭空制造人、实物或履约事实。 | 通常不需要；先做只读投影。 |
| 4 | 确需逻辑互操作时，选择兼容的固定导入集合并加入经审查的子类／关系公理；单独运行推理与约束验证。 | 推理机检查一致性、不可满足类与预期分类；反例能捕获“同一实例既是角色又是倾向”“同一实例既是计划内容又是过程”等错误。 | 不以此为前提；另评估实际需求。 |

四种交付不能互相替代：**参考映射**只说明如何理解；**正式逻辑对齐**增加可推理公理；**RDF 导出**只证明输出了相应图；**推理机验证**只证明给定公理和数据满足所测逻辑条件。当前 TypeScript／Zod 的字段校验也不能称为已完成上述任何后续步骤。OWL 采用开放世界语义，缺少某事实并不自动判假；SHACL 则按形状约束验证 RDF 数据图，可用于明确要求的字段、类型和数量检查。[OWL 2 Primer](https://www.w3.org/TR/owl2-primer/#What_is_OWL_2.3F) · [SHACL 规范](https://www.w3.org/TR/shacl/)

因此，EIGOS 的“证据缺失则 `unknown` 并阻止所需操作”、实时授权与版本核对继续由现有运行规则承担。逻辑一致、图结构合格、供应方声明和真实服务完成是不同验收结论。（项目推断。）

## 5. 业务 schema 与完成证据仍需独立建设

BFO 的顶层范围不能替代套餐早餐数量、儿童年龄、取消费用、包裹保温要求、司机资格、上车／送达时间等业务约定。即使采用 CCO，也仍需本项目明确这些含义、来源和验收条件。（基于[官方 BFO 范围](https://github.com/BFO-ontology/BFO-2020#basic-formal-ontology)和[CCO 中层定位](https://github.com/CommonCoreOntology/CommonCoreOntologies#what-is-cco)的项目推断。）

若后续需要网页或商家数据交换，可另参考 Schema.org 的 [ProductGroup](https://schema.org/ProductGroup) 与 [Hotel](https://schema.org/Hotel)。它们提供商品变体分组、住宿等业务词汇；本次页面标注为开发版，未纳入固定导入基线。`ProductGroup` 是变体分组，不是每个 `ProductVariant` 的直接等价项；这类外部映射仍需保留 EIGOS 的来源、报价、权限和完成条件。（前两项是官方页面事实，后两项是项目推断。）

**本轮 BFO 采用的建议端点是术语澄清与参考映射，不因采用 BFO 改写已有效的执行账本，也不机械增加通用实体表。** 要证明酒店已确认、包裹已送达或退款已到账，仍须取得对应来源证据并核对本次用户约定；BFO／CCO／IAO／PROV-O 的类别、导出或推理结果本身不能给出该业务结论。

## 6. 本次核验边界

- 已读取上述官方版本、相关定义和精确 IRI；已检查核心模型与术语的实际含义，未仅按类型名称匹配。
- 代码审查范围为 `business-model.ts`、`service-domains.ts`、`execution-model.ts`、`product-attributes.ts`、`errand-model.ts`、`network-model.ts`、`capability-catalog.ts`、`model.ts` 与 `CONTEXT.md` 的当前工作区内容。
- 当前审查范围没有 BFO／IAO／CCO／PROV 的正式类公理、RDF 导出或推理集成；本报告不声称完成正式对齐或 ISO 符合性检查。
- 仅新增本研究文件；没有运行供应方操作、真实下单付款、迁移或部署。文档验证不替代主任务代码与 CI 验证。
