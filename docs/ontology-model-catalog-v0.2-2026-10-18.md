# Ontology v0.2 对象目录：按 Palantir 官方指南建模

日期：2026-10-18。本文是 [主规格](ontology-spec-v0.2-2026-10-18.md) 的对象、属性、关系、接口和数据映射目录，替代初稿中只有概念清单和流程箭头的部分。所有新增类型均为待实现设计；本文不是 Foundry 部署、SDK 兼容或正式认证声明。

## 1. 建模依据与本项目的选择

Palantir 的设计指导先确立领域实体，再考虑复用、扩展及组合；对象模型要服务实际业务问题。下表右侧是 EIGOS 的设计决策，不是官方提供的生活服务模板。[官方设计原则](https://www.palantir.com/docs/foundry/ontology/ontology-best-practices)

| 原则 | EIGOS 的采用方式 | 本轮修正 |
| --- | --- | --- |
| 业务实体优先 | 先确定包裹、报价、订单项、交付、餐厅时段和预订的意义，再映射源字段 | 执行日志不再占据业务对象图的中心 |
| 共享概念保持统一 | ServiceRequest 表示同一类委托，保留一个精简对象；同一 Provider 的不同角色通过关系表达 | 不为每个渠道复制一套主体与业务对象 |
| 稳定核心、明确扩展 | 新领域增加具体对象及接口实现，不持续给核心 Request 填充各领域可空字段 | 商品、配送、预订使用具体报价对象 |
| 组合复用 | 报价共性通过 Offer 接口表达，领域计算按具体类型实现 | 不以一个包含全部业务字段的 Offer 对象作为模型中心 |

### 1.1 基本构件

| 构件 | 在本规格中的含义 | 例子 |
| --- | --- | --- |
| Object Type | 一种有明确身份和业务意义的实体或事件的定义 | Parcel、OrderLine、Reservation |
| Object | 某次实际或明确合成的实例 | 某件包裹、某笔预订，不等于类型定义 |
| Property | 对象的有类型属性及业务含义 | declaredWeight、partySize、confirmedAt |
| Link Type | 两种对象间可从两侧导航的语义关系 | Order 的 lines，OrderLine 的 order |
| Interface | 多种具体对象共享的属性、关系及行为约束；不直接创建接口实例 | Offer 由三个具体报价类型实现 |
| Function／Object Set | 可复用计算及按条件选出的对象集合 | 可用报价集合、某订单尚欠交付数量 |
| Action Type | 用户或 Agent 决策触发的受控对象／属性／关系变更，带提交条件及规定副作用 | SelectOffer、RequestReservation |

构件依据：[对象](https://www.palantir.com/docs/foundry/object-link-types/object-types-overview)、[属性](https://www.palantir.com/docs/foundry/object-link-types/properties-overview)、[关系](https://www.palantir.com/docs/foundry/object-link-types/link-types-overview)、[接口](https://www.palantir.com/docs/foundry/interfaces/interface-overview)、[Functions](https://www.palantir.com/docs/foundry/functions/overview)、[Actions](https://www.palantir.com/docs/foundry/action-types/overview)。EIGOS 沿用本地运行栈承载这些语义；实际 Foundry 的资源配置及特性支持不据此视为已接入。

## 2. 对象类型目录

每个具体类型必须登记中文名称、复数名称、稳定 API 名、业务说明／别名、主键、展示标题、属性 schema、数据来源、可编辑范围、关系和责任维护者。主键表示稳定身份，标题可改变；不得用名称、地址字符串或当前价格作身份。[官方对象创建与键配置](https://www.palantir.com/docs/foundry/object-link-types/create-object-type)

下面的主键均为 EIGOS 的稳定本地 id；外部映射另外保存 namespace 和原生 id。来源不给对象 id 时，可保存绑定查询／回执的本地快照身份，但不得因此声称跨来源是同一对象。

| Object Type／title key | 主键 | 最小业务属性 | 来源／修改责任 | 必须支持的问题 |
| --- | --- | --- | --- | --- |
| ServiceRequest／`originalGoal` | requestId | originalGoal、revision、requestedOutcome、progress、createdAt | PA 原文＋受控需求变更；只保留共用委托属性 | 用户究竟要查价、送达还是确认预订？ |
| Proposal／`displayTitle` | proposalId | requestRevision、selectedAt、termsVersion、decisionReason | SelectOffer 等受控决策形成，链接具体报价 | 当前选中了哪份条款，是否仍适用原需求？ |
| Authorization／`displayTitle` | authorizationId | actor、allowedActions、dataScope、limits、expiresAt、revoked | 受信任批准通道；模型不能直接生成批准事实 | 哪项业务对象和动作已经获准？ |
| OutcomeAssessment／`displayTitle` | assessmentId | requestRevision、judgment、criterionResults、assessedAt | 登记验收函数及必要的人工确认，保留历史版本 | 为什么整体完成、未满足或仍未知？ |
| Provider／`name` | providerId | name、verifiedIdentityRefs | 已接入渠道／经核实主体资料；角色见关系 | 谁销售、谁履约、谁只是入口？ |
| Channel／`name` | channelId | name、accessScope、supportedOperationRefs | 受控接入配置与访问核验 | 当前身份能通过哪个入口做什么？ |
| ChannelParticipation／`displayTitle` | participationId | role、validFrom、validUntil、verificationRef | 核实的渠道关系；连接 Provider 和 Channel | 同一主体在此渠道以什么身份参与？ |
| ServiceEngagement／`displayTitle` | engagementId | progress、startedAt、waitingQuestion、remoteReference | 本次委托与提供者交互记录 | 哪个来源仍在等待、失败或要求补充？ |
| Place／`name` | placeId | name、address、coordinates、coordinateUnit、coordinateSystem | 公开地点来源的规范化映射 | 这是哪个公开地点？有哪些可核对位置属性？ |
| SavedAddress／`displayTitle` | savedAddressId | label、address、contactInstructions、sourceReference | 本人地址簿及明确选择；字段受限 | 此用户实际选了哪条地址记录？ |
| Parcel／`displayTitle` | parcelId | contentsCategory、declaredWeight、declaredContents | 用户申报；实际计费／称重另有观察 | 本次按什么包裹条件查价？ |
| DeliveryRoute／`displayTitle` | routeId | originSnapshot、destinationSnapshot、selectedAt | 已确认的地址选择；发生实质变化建立新版本 | 报价到底适用于哪条路线？ |
| DeliveryQuote／`displayTitle` | quoteId | serviceLevel、quotedWeight、estimatedArrival、pricingTerms | 只读配送报价回执；实现 Offer | 这份报价对应哪个包裹、路线和服务？ |
| ProductVariant／`name` | variantId | sourceProductRef、name、specification、specificationRevision | 经规范化的商品目录；不按同名合并 | 两个候选是否同规格或允许替代？ |
| ProductOffer／`displayTitle` | offerId | offeredQuantity、pricingTerms、capacityObservationRef、deliveryCommitment | 商品报价／可用性来源；实现 Offer | 在何种规格、数量和交付条件下可选？ |
| Order／`displayTitle` | orderId | providerOrderReference、orderState、createdAt | 供应方订单观察；本地意图不生成假订单号 | 真实建立了哪笔订单？ |
| OrderLine／`displayTitle` | orderLineId | quantityOrdered、agreedSpecificationRef、agreedPriceRef | 订单／选定方案的历史版本引用 | 这单具体要求交付什么、多少？ |
| Shipment／`displayTitle` | shipmentId | providerReference、shipmentState、actualArrivalAt | 供应方或任务约定的交付来源 | 哪一批实际送达、何时送达？ |
| DeliveryEvent／`displayTitle` | eventId | occurredAt、observedAt、sourceVersion、eventKind | 可追溯的交付观察；原生事件键去重 | 哪条观察支持本次交付数量或时间？ |
| DeliveryAllocation／`displayTitle` | allocationId | deliveredQuantity、acceptedSpecificationRef、verificationState、evidenceRef | 经验证的交付观察，连接 Shipment 和 OrderLine | 这批交付抵扣哪一项的多少数量？ |
| Venue／`name` | venueId | name、address、timeZone | 餐厅／目录资料，链接经营 Provider | 预订的是哪个实际场所？ |
| ReservationSlot／`displayTitle` | slotId | startsAt、timeZone、partySizeEligibility、availabilityObservedAt、expiresAt | 时段／席位查询来源 | 该时段是否适用于本次人数？ |
| ReservationOffer／`displayTitle` | offerId | depositTerms、cancellationTerms、holdTerms | 预订渠道条款；实现 Offer | 什么费用和生效条件适用于该时段？ |
| Reservation／`displayTitle` | reservationId | providerReference、reservationState、partySize、confirmedAt、holdExpiresAt | 预订渠道／餐厅观察 | 是占位、待确认还是已生效？ |
| Payment／`displayTitle` | paymentId | providerReference、purpose、amount、paymentState、observedAt | 支付侧可核查结果，链接相应订单或预订 | 订金或货款是否实际支付、支付给谁？ |
| Refund／`displayTitle` | refundId | providerReference、amount、refundState、observedAt | 原支付关联的退款回执 | 受理和实际到账分别到哪一步？ |
| AfterSalesCase／`displayTitle` | caseId | requestedRemedy、progress、originalBusinessReference | 用户请求和后续业务观察 | 补救针对原业务的哪一项、是否解决？ |
| SourceReceipt／`safeSummary` | receiptId | sourceIdentity、sourceEventId、observedAt、evidenceLevel、contentDigest、safeSummary | 受控来源读取与验证；原始私人载荷单独受限 | 具体业务属性和状态由哪份回执支持？ |

`displayTitle` 是 String 展示属性，由本对象稳定字段生成；不参与身份、匹配或业务验收，可按登记格式重新生成。未取得供应商确认号时，标题不能写成已确认订单／预订。表中的业务属性另加各类型必要的 owner、revision 和来源元数据。

Place 与 SavedAddress 的区别是业务身份：一个是被识别的地点，一个是用户保存的联系／送达记录；不是为公共和私人数据复制同一个类型。没有可靠身份映射时不强行将地址簿条目与 POI 合并。

Proposal、Authorization、OutcomeAssessment 是需要追溯的业务决策／审核记录；Requirement 使用有 schema 的条件结构。ActionIntent、ExecutionAttempt、租约、RPC 收据和适配器配置是技术支持记录，默认不进入给业务用户／Agent 导航的对象目录；需要审计视图时按技术类型受限暴露。Fact 是属性／事件的语义及证据视图，不要求把每个属性拆成通用三元组对象。

## 3. Offer 接口与属性定义卡

Offer 接口约定 `offerId`、`observedAt`、`expiresAt`、`validityBasis`、`priceKind`、`pricingCompleteness`，以及 provider、channel、request 关系约束。DeliveryQuote、ProductOffer、ReservationOffer 分别实现；接口本身没有独立数据集或实例。商品数量、包裹重量、订金和餐厅人数不混成一个通用 quantity／total 字段。[官方接口定义](https://www.palantir.com/docs/foundry/interfaces/interface-overview)

EvidenceBacked 是第二个聚焦接口，只约定可追溯到 SourceReceipt 的 `sourceReceipts` 关系及权限检查。Offer 继承该接口；Order、Payment、Reservation、DeliveryEvent 等需要业务证据的具体类型可实现它。SourceReceipt 是可理解的来源回执对象，原始 RPC 日志仍为隐藏技术记录。

相同报价的跨请求复用必须重新判断适用范围和权限；本人报价默认归属原请求。ServiceRequest 的核心含义一致，因此先保留精简具体类型，领域信息通过关联对象和类型化条件表达。新增抽象须有实际共同语义，不为套用接口而创造空泛父类。

| 属性卡 | 类型／单位／缺失含义 | 权威来源／可编辑性 | 派生或更新规则 |
| --- | --- | --- | --- |
| Parcel.declaredWeight | 精确十进制＋质量单位；未提供为 unknown | 用户／PA 申报，可通过有权限需求变更修改 | 修改导致旧报价适用性重查；不是实测重量 |
| DeliveryQuote.quotedWeight | 来源计价口径下的重量 | 报价回执；用户不能直接修改 | 与申报或计费规则比较，明确差异 |
| DeliveryQuote.pricingTerms | 类型化费用项、性质、币种、覆盖范围 | 提供方报价 | estimate 不派生出最终费用承诺 |
| OrderLine.quantityOrdered | 整数计数及单位／允许的精确数量 | 已选订单项或明确变更版本 | 不随实际少送而降低 |
| OrderLine.remainingQuantity | 只读派生值 | 函数读取该订单项和有效 DeliveryAllocation | ordered 减去已验收分配；拒绝重计同一交付事件 |
| Reservation.reservationState | 有限领域枚举 | 预订回执映射 | paid 不可直接写成 confirmed；看实际确认及生效条件 |
| Payment.paymentState | 有限支付枚举 | 支付侧回执 | 用户备注／模型判断不能覆盖 paid／unknown 等事实 |
| SavedAddress.contactInstructions | 结构化地址补充／联系人字段 | 本人记录及明确修改 | 只向必要的获准执行边界披露；模型及无关查询不可读 |

属性需要业务说明、API 名、基础类型及展示元数据，不能只复制供应方字段名。[官方属性元数据](https://www.palantir.com/docs/foundry/object-link-types/property-metadata)

Shipment.actualArrivalAt 从被接受的 DeliveryEvent 派生，DeliveryAllocation 只统计 verificationState=accepted 且未撤销的分配，同一来源事件不能重复抵扣。

当前值在其语义所属对象维护；`isFresh(asOf)`、已收数量和预算差额通过受控函数／派生视图计算。已经批准的报价与地址版本是历史决策快照，保留时点和来源，不作为另一份需要同步更新的当前值。若缓存派生结果，必须登记权威输入、失效与重建规则。[官方派生属性说明](https://www.palantir.com/docs/foundry/ontology/derived-properties)

## 4. Link Type 目录

关系具有两侧名称和明确基数；反向导航属于同一关系定义。下面每个 `a / b` 是正反向名称，不能靠任意 foreign key 猜测关系。[官方关系方向说明](https://www.palantir.com/docs/foundry/object-link-types/link-types-overview)

| 两端及关系名 | 基数 | 业务含义／映射 |
| --- | --- | --- |
| ServiceRequest.engagements / ServiceEngagement.request | 1 : 0..N | 一个需求询问多个提供者，每次沟通只属一个需求 |
| ServiceEngagement.provider / Provider.engagements | N : 1 | 该次沟通的实际提供者 |
| Provider.participations / ChannelParticipation.provider；Channel.participations / ChannelParticipation.channel | 两条 1 : N | 通过 ChannelParticipation 表达 N:M 关系及角色、时间、证据 |
| ServiceRequest.parcels / Parcel.request | 1 : 0..N | 配送需求的包裹；初版场景只有一个 |
| ServiceRequest.routes / DeliveryRoute.request | 1 : 0..N | 路线版本的归属；历史报价继续引用历史路线 |
| ServiceRequest.selectedRoute / DeliveryRoute.selectedForRequest | 0..1 : 0..1 | 当前选择关系，与历史归属关系不同；变更由 Action 控制 |
| DeliveryRoute.originAddress / SavedAddress.originRoutes；DeliveryRoute.destinationAddress / SavedAddress.destinationRoutes | 两条 N : 0..1 | 分别追溯保存地址；无保存条目时用已确认地址快照，不猜关联 |
| DeliveryQuote.parcel / Parcel.quotes | N : 1 | 报价按哪个包裹版本 |
| DeliveryQuote.route / DeliveryRoute.quotes | N : 1 | 报价适用路线，不用搜索区域推导 |
| Offer.request / ServiceRequest.offers | N : 1 | 三个具体报价类型遵守此接口关系约束 |
| Proposal.request / ServiceRequest.proposals；Proposal.selectedOffer / Offer.proposals | 两条 N : 1 | 当前原型每个方案选择一份报价；不同方案版本各自保留 |
| ServiceRequest.selectedProposal / Proposal.selectedForRequest | 0..1 : 0..1 | 当前采用哪个方案，不删除旧方案历史 |
| Authorization.proposal / Proposal.authorizations；OutcomeAssessment.request / ServiceRequest.assessments | 两条 N : 1 | 批准绑定准确方案，验收对应准确需求版本 |
| Offer.provider / Provider.offers；Offer.channel / Channel.offers | 两条 N : 1 | 报价提供主体与查询入口分别可查 |
| EvidenceBacked.sourceReceipts / SourceReceipt 的各具体类型反向关系 | N : M | 对每个实现类型登记具体反向名称，如 deliveryQuotes、reservations、payments；接口约束不替代具体链接映射 |
| ProductOffer.productVariant / ProductVariant.offers | N : 1 | 商品报价对应的准确规格 |
| Order.lines / OrderLine.order | 1 : 1..N | 订单粒度与订单项粒度分别可查 |
| Order.request / ServiceRequest.orders | N : 1 | 本笔订单源自哪项委托 |
| Order.shipments / Shipment.order | 1 : 0..N | 一笔订单可分多批交付；首版不跨订单合并批次 |
| OrderLine.productVariant / ProductVariant.orderLines | N : 1 | 商品实体引用，历史约定规格另固定版本 |
| Shipment.allocations / DeliveryAllocation.shipment；OrderLine.allocations / DeliveryAllocation.orderLine | 两条 1 : N | 交付批次与订单项的 N:M 分配，保留数量与验收证据 |
| DeliveryAllocation.deliveryEvent / DeliveryEvent.allocations；DeliveryEvent.shipment / Shipment.deliveryEvents | 两条 N : 1 | 分配可导航到来源事件及批次，同一事件不重复计数 |
| Venue.slots / ReservationSlot.venue | 1 : 0..N | 场所与可订时段 |
| ReservationOffer.slot / ReservationSlot.offers | N : 1 | 此份条款适用的时段 |
| Reservation.slot / ReservationSlot.reservations | N : 1 | 预订依赖准确时段及人数条件 |
| Reservation.request / ServiceRequest.reservations | N : 1 | 确认必须属于原委托 |
| Venue.provider / Provider.venues | N : 1 | 实际餐厅与经营主体关联 |
| Reservation.depositPayments / Payment.reservation | 1 : 0..N；支付侧 0..1 | 关联订金记录；货款支付使用 Order 的独立对应关系 |
| Order.payments / Payment.order | 1 : 0..N；支付侧 0..1 | 每笔支付绑定一个明确订单或预订，不能同时归给两者 |
| Payment.refunds / Refund.originalPayment；AfterSalesCase.refunds / Refund.case | 两条 1 : 0..N | 退款可追到原支付和售后需求，退款到账不重写原购买结果 |
| AfterSalesCase.order / Order.afterSalesCases；AfterSalesCase.reservation / Reservation.afterSalesCases | 两条 N : 0..1 | 初版售后必须且只能关联一个原订单或预订，保留准确业务身份 |

ChannelParticipation 和 DeliveryAllocation 因关系自身具有角色、期限或数量等属性，使用对象承载关系；它们有独立主键和证据，不能把多条关系的信息塞在父对象的一组字段上。[官方结构指导](https://www.palantir.com/docs/foundry/ontology/ontology-structural-guidance)

## 5. 数据映射、来源权威与变更

先从业务问题确定对象和关系，再确定下表映射。EIGOS 的私有持久记录与获准来源回执承担本地 backing data 的作用；不表示已经部署 Foundry 数据集或索引服务。只由受控 Action 产生的业务记录也要有明确创建规则和身份。[官方对象与来源说明](https://www.palantir.com/docs/foundry/object-link-types/object-types-overview)

| 来源 | 规范化目标 | 关键映射／生命周期 | 现状 |
| --- | --- | --- | --- |
| PA 的原始消息与明确选择 | ServiceRequest、条件、Parcel、DeliveryRoute | 保留原文／revision；地址角色和申报重量明确；修改由受控动作形成新版本 | 已有任务与地址流程，待本体化投影 |
| 美团公开地点读取 | Place＋来源观察 | 原生 id 带 namespace；微度转换为度发生在摘要前；不派生成 Merchant／Offer | 已有真实读取；仅授权公开查询组合 |
| 本人保存地址读取 | SavedAddress、所选路线快照 | 私人地址／联系人与公开 Place 不因字符串相似合并；字段权限先于模型展示 | 已有本人流程，类型目录待实现 |
| 美团配送报价回执 | DeliveryQuote，实现 Offer | 关联准确路线、物品、重量、服务及输入摘要；保留估价性质／缺失费用，不猜来源承诺 | 已有真实查价；完整 Offer 映射待实现 |
| 商品目录、报价、订单与交付来源 | ProductVariant／ProductOffer／Order／OrderLine／Shipment／DeliveryAllocation | 分开实体身份与观察；交付事件去重后形成数量分配 | 正式来源契约待取得；当前只有合成场景 |
| 餐厅时段、预订及订金来源 | Venue／ReservationSlot／ReservationOffer／Reservation／Payment | held、确认、生效条件及付款分别映射 | 正式来源契约待取得；当前只有合成场景 |

每条映射登记源版本、转换函数、目标属性／链接、缺失与冲突处理、幂等键、删除／撤销语义、保留策略和维护责任。源 schema 改变应在边界拒绝或形成待审核版本，不直接污染业务对象。

用户可改需求，不能改来源付款状态；提供方更新报价，不能改用户原预算；派生属性不能直接写。数据源更新和决策编辑必须有显式冲突策略；EIGOS 采用属性权威与源事件版本规则，而非按消息到达顺序覆盖。[官方编辑与来源冲突说明](https://www.palantir.com/docs/foundry/object-edits/how-edits-applied)

## 6. Query、Function、Action 与数据同步

| 类别 | EIGOS 例子 | 允许改变什么 |
| --- | --- | --- |
| Object Set 查询 | 当前请求的有效 DeliveryQuote；尚未满足的订单项 | 只读对象与关系，受权限及范围过滤 |
| 只读 Function | compareDeliveryQuotes、remainingQuantity、assessReservation | 计算与解释，返回结果和证据引用，不写付款／订单事实 |
| 来源读取与映射管线 | Ontology MCP 读取后解析、去重、投影来源对象／观察 | 由来源规则更新规范化对象；不是模型任意编辑 |
| Ontology Action Type | SelectOffer、AmendRequest、RequestReservation、RequestRefund | 经提交条件批准的一组对象／属性／关系变更及规定外部调用意图 |
| 技术执行操作 | RPC、search_poi、delivery_preview、重试／查证 | 由受控适配器执行；名称本身不定义业务本体 |

Actions 和 Functions 的依据见 [Action 类型](https://www.palantir.com/docs/foundry/action-types/overview) 与 [Function 的本体读取及逻辑](https://www.palantir.com/docs/foundry/functions/overview)。EIGOS 继续用写前意图与事务外 I/O：本地对象编辑可原子提交，不承诺本地事务与外部订单／付款共同原子成功。

当前 Ontology MCP 主要提供定义读取和供应方查询边界；它不能单独代替本规格的对象目录、关系查询与受控变更层。这些语义及接口需要在后续阶段补齐，而非把现有工具改名后即认为完成。

### 6.1 两个具体 Action 定义卡

| 定义卡 | RequestDeliveryQuote | SelectOffer |
| --- | --- | --- |
| 业务决策 | 为已明确包裹和路线请求新报价 | 为本需求选定具体报价／条款 |
| 参数 | request、parcel、route、serviceLevel 引用及 revision | request、具体 Offer 引用、报价 revision |
| 提交条件 | 身份及读取范围允许；引用归属一致；输入完整；查询组合在受控范围内 | 同一 owner／需求；前置硬条件通过；报价新鲜；需求 revision 未变 |
| 对象／关系变更 | Request 进入 awaiting_quote；关联准确 Parcel／Route；追加操作意图 | 建立 Proposal 与 selectedOffer 关系，固定条款及需求版本 |
| 不可直接写的属性 | 报价金额、来源承诺、订单／付款状态 | 来源报价、库存、授权已批准或交付成功 |
| 后续事实 | Worker 只读操作获得回执后，由映射管线产生 DeliveryQuote | 仅表示选择；实际业务动作另外检查授权 |
| 审计 | actor、参数、变更集、规则版本、关联运行意图 | actor、选中对象／版本、变更集、拒绝理由 |

RequestOrder、RequestReservation、RequestRefund 同样要列出变更集和权限；仅生成待处理业务意图不会产生“已建立订单”“已付”“已确认预订”等事实。其真实副作用在当前运行策略下继续禁止。提交条件与对象编辑权限分别检查。[官方提交条件](https://www.palantir.com/docs/foundry/action-types/submission-criteria)

## 7. 业务权限和可发现性

对象可见性、属性可见性、关系导航、Action 可用性分别登记。本人地址的联系字段不因允许查询 Place 或查看报价而公开。函数、派生值、结果集计数和反向关系同样不能绕过权限。新增关系必须复查它是否提供了到私人对象的新路径。

读权限不自动授予写权限；Action 的提交条件与写入输出的保护要求必须单独实施，不能只在界面隐藏按钮。该设计借鉴官方权限划分，具体本地策略由 EIGOS 实现并测试。[官方 Action 权限](https://www.palantir.com/docs/foundry/action-types/permissions)

每个类型、属性和关系提供业务名称、别名和说明。默认业务目录隐藏租约、Attempt、原始 RPC 记录等技术内容；必要证据仍可通过有权限的审计视图追溯，不为方便排障把所有内部结构交给 LLM。

## 8. 结构检查与独立业务问题演练

本目录的作者结构走查只确认定义是否自洽，不能证明新用户或 Agent 能独立使用。正式演练要提供问题和有权限的对象目录／数据，让非建模者与 Agent 分别查找、导航、计算并解释；不给定答案路径，记录正确性、耗时、所走关系及求助情况。[官方验证方法](https://www.palantir.com/docs/foundry/ontology/ontology-design-validation)

本轮状态：官方来源已核对、目录与结构走查已写出；独立人／Agent 演练未运行，因为本体对象查询接口与三领域数据模型尚未实现。演练题目见 [独立问题集](ontology-drill-questions-v0.2-2026-10-18.md)，主持人参考及既有 23 个反例见 [场景文件](ontology-scenarios-v0.2-2026-10-18.md)。不得把 CI 或作者按固定流程走查标成这项演练已通过。
