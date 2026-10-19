# Agent 交易与跨境履约沙箱

代码契约为 `ontology-execution-v9`、`eigos.business@8`，全模型 87 个对象类型、27 个函数、30 个 Action 定义。本扩展的 `commerce.journey.sandbox@1` 使用已有 MCP/A2A 委托入口和真实模型决策循环；业务提供方是独立的合成数据模拟器。它不证明真实商家库存、国际税率、支付清算或实际运输已接通。

## 地址与费用修复

- UCP 地址摘要保留房号/补充地址和收件联系字段；只提供国家不能满足物理配送地址的最低结构要求。
- 标准化结账与订单保留费用明细、完整源费用摘要和商品单价。总额相同但税费构成、责任字段或单价分配改变，不能沿用旧批准方案。
- `checkoutReadiness@2` 只判断协议就绪，明确返回 `purchaseFeasibility: unknown`；跨境任务可行性由新对象及函数按所需阶段核验。
- `CheckoutSession` 定义升级为 2。旧任务/旧对象不自动重新解释。通用旧版地址结构保留，新 `PostalAddress` 用于交易履约上下文，避免改写既有地点及跑腿历史证据。

## 事实与决策

`CommerceTask` 保存目标阶段、需求条件和可为空的商品查询/数量/上下文引用，不预置商家、发货国或收货国。`FulfillmentContext` 从已授权来源返回本任务可用的地址及版本。多个地址没有默认选择时，Agent 实际读取并核验上下文后，才通过原 Task 向 PA 询问；PA 用真实返回的标签补充 destination 条件。

商家注册地、发货仓、商品原产地、收货国分别建模。业务模型同时表达商品、按仓可供数量、履约分组、清关评估、到手总价、购物车、结账、订单观察、付款观察、交付事件和逐包裹承诺。`InventoryReservation` 保留独立语义，本程序未绑定预留动作；可供数量不等于库存已预留。`FactRequirement` 定义缺口结构，运行时缺口由函数返回。

`commerceJourneyStatus` 返回已知事实、缺口和相应信息来源；`commerceObservationStatus` 验证某一观察的来源、所有者、任务版本、有效期及依赖，并返回本阶段 satisfied / unsatisfied / unknown。函数不替模型选商家或动作顺序。每次实际厂商操作均来自模型的版本化动作计划，连接器只调用一个接口。

地址、数量、商品、库存版本、运输分组、费用或责任变化会使相关判定失效。进入订单后，已同意的合同按派发时刻验证；后续订单、付款和物流读回仍要求新鲜来源证据。已过期对象的身份可以用于读取原记录，不能用于新交易。

## 原子动作

| 作用 | 动作 |
| --- | --- |
| 查询 PA 上下文、商家和商品 | ReadCommerceContext / SearchCommerceMerchants / ReadCommerceProduct |
| 查询可供数量与运输方案 | ReadCommerceInventory / ReadCommerceFulfillment |
| 查询清关与完整费用 | ReadCommerceCustoms / QuoteCommerceLandedCost |
| 管理独立草稿购物车 | CreateCommerceCart / ReadCommerceCart / UpdateCommerceCart / CancelCommerceCart |
| 准备及提交准确沙箱方案 | PrepareCommerceCheckout / SubmitCommerceOrder |
| 独立核对原业务结果 | ReadCommerceOrder / ReadCommercePayment / ReadCommerceDelivery |

购物车目标可以跳过地址和跨境查询；报价目标不需要创建任何交易草稿。其余动作由本次目标与新事实决定，没有预设商家调用配方。报价必须实际经过本体计算后才能创建结账；提交订单前，Agent 必须实际核验对应结账。未知写入由宿主故障恢复机制读取原幂等键，不自动重做业务动作。

## 费用与配送条件

费用记录货款、运输、税、关税、清关、保险、其他费用及折扣，并单独记录承担方、支付时点、估算或固定金额、是否被完整买方总额覆盖。卖方明确承担的包税费用可以细项金额未知；买方未知费用不能作为零处理。到手价的买方费用之和必须等于总额，并满足用户币种和预算。

配送方案记录每组商品和数量、仓库、实际发货国、目的地版本、承运服务及运输方式。承诺另有承诺方、到达或发出里程碑、时间区间、时区、条件、有效期、例外与补救条款。每个包裹都必须覆盖；预计时间不能满足硬性到货期限。

清关数据包含商品原产地、HS 归类、目的国、发货国、适用日期、规则版本、进口适用性及责任。模拟器的规则均为 synthetic，不是税务或法律判断来源。真实接入须替换为有授权、明确适用范围和更新机制的来源；不把规则写进 LLM 常识。

## 授权、持久化与恢复

默认关闭；仅本机开发身份、显式 `executionEnvironment: sandbox`、启用的 sandbox 配置与精确计划许可共同满足时才执行写入。创建/修改购物车及准备结账为独立草稿效果；提交订单同时要求 order 和模拟 payment 两类许可。计划固定输入、费用、收款方和幂等范围，每次派发前重查。旧许可不覆盖新计划。

意图与尝试先持久化，再调用来源。调用结果、本体投影和 Agent 状态在当前领取下原子保存。迟到回包不能覆盖取消或新领取；已发生但未确认的作用保留为未知，查询原键至多三次后转人工查证，费用占用不释放。明确的已签名“未应用”拒绝才可释放占用。授权撤销后只允许原操作查证。

标准 PA 客户端增加 `approve_plan` 格式，保留旧 `confirm_simulated_payment`；客户端响应上限调整为 8 MiB 以读取有界多轮计划。所有者、连接来源、凭据引用与服务白名单的语义不变。

## 本机运行

```sh
npm run build
npm run setup:commerce-sandbox
EIGOS_COMMERCE_SANDBOX_URL=http://127.0.0.1:3432 \
EIGOS_COMMERCE_SANDBOX_TOKEN_FILE="$HOME/.local/share/eigos/commerce-sandbox/connector-token" \
npm run setup:pa
```

`setup:commerce-sandbox` 使用独立不可变编译快照、私有 SQLite 和独立签名凭据，管理 `com.eigos.commerce-sandbox`。`setup:pa` 保留已有 Shopify 与跑腿配置。Gateway 构造元数据时不读取模拟器凭据、不启动模型或业务服务。

后续 `setup:pa` 默认保留绑定；显式 `EIGOS_COMMERCE_SANDBOX_URL='' npm run setup:pa` 可关闭该沙箱能力，而不改变既有 Shopify 目录和跑腿查询绑定。

模拟器只有 `127.0.0.1` 入口，没有对外网络调用实现。连接器拒绝非 loopback、跳转、超大或未签名响应；原始响应和 HTTP 绑定证据保存在私有审计目录，凭据不进入模型或回执。

默认演示资料故意让注册地、发货地、原产地和收货地不同，并提供两个 PA 地址、一个缺货候选商家和一个可供货候选商家。它用于验证获取事实和处理分支，不是运行时必须选择的配方。

## 验证与当前范围

本地验证覆盖地址房号、费用责任变化、准确授权、无谓提问、仅购物车目标、国内与跨境分支、未知买方关税、进口限制、只有 ETA、未到账、部分或未来交付、同价不同费用、原操作恢复、取消、撤销、租约更替及持久实例续接。实际 PA + LLM 沙箱验证记录在完成后单独归档；单元测试替身不代替它。

当前模拟器针对一款商品变体的指定件数，支持多商家比较、多个发货仓和分批交付；模拟价格币种为 CNY/USD。多商品联合结算、跨商家统一收款、换汇、真实预留、真实退款及真实报关/物流服务尚未接入。真实 Shopify 连接器继续只读。
