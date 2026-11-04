# 任务需求与服务合同规划

Worker 的任务专属 Ontology MCP 提供只读 `plan_services`。结构化执行器也可通过同一工具调用。它在当前 owner、任务 revision、发布和权限范围内，把明确的需求展开为需求图，再按已发布动作的输出类型、业务阶段和具名端口生成有界候选依赖图。

这是合同规划提案，不查询供应商、不创建 program scope 或 Intent、不下单、不付款，也不代替最终目标合同和独立验收。普通任务的自然语言解释及最终动作选择仍有模型决策回执；本工具不伪造模型运行，也不开放新的供应商执行来源。

## 使用位置

1. 模型通过 `read_task_context` 读取当前任务和原指令。
2. 将明确需求整理为 `goal.kind=needs`，或将明确的往返旅行范围整理为 `round_trip`，调用 `plan_services`。
3. 检查需求、候选、缺口、分页覆盖和未知适配条件。读取准确 action schema，以现有机制准备组件上下文。
4. 由原决策路径选择实际动作；来源调用、具名输出绑定、当前授权、派发和独立验收继续由 Worker 检查。

规则和搜索不需要模型调用；模型仍负责把开放文本解释为结构化输入。本阶段没有“任意自然语言目标无需 LLM 完整执行”的承诺。

## 合同与实例的职责

`packages/ontology/service-planning.ts` 定义版本为 1 的需求及规划工具合同。返回的 ServicePlanningContract 是现有不可变 ActionDefinition、composition 端口、Pipeline 声明及配置绑定的投影，保留准确 release 和 binding pin。它不创建另一份可变本体，不改变或重标旧 v28 及历史任务的业务定义。

| 内容 | 来源与含义 |
| --- | --- |
| 输入、输出类型、业务阶段、端口角色及证据要求 | 已发布 action.composition |
| requiredArguments、submissionCriteria、sourceDependencies | 已发布 action 与 MCP requires；保留来源校验和显式纯派生要求 |
| contextInputSchema | 当前配置 program 的输入合同；还没有建立组件上下文 |
| declaredConditions | Pipeline 原始地区、粗粒度支付路径和操作员需求声明；不证明真实可用性 |
| binding、readiness、reason | 当前任务重新发现的准确绑定与状态；下一次调用重新鉴权 |
| 需求 role、target、phase、dependsOn | 当前任务的结构化需求提案；source 必须引用当前任务的准确 messageId／quote |

输入引用原话只能证明出处，不能证明模型对原话的语义解释正确。原有目标范围 review 仍然需要；规划提案不能自动替换用户固定目标。显式需要两个接送时保留两个 need，不能只保留一个业务 predicate。

## 东京往返示例

以下是任务 MCP 的工具参数，不是 `submit_task` 的新增字段。messageId 与 quote 必须换成当前 `read_task_context` 实际返回的原指令。目的地是用户给定目标，不是已选择机场、酒店地址或供应商原生地点。

```json
{
  "goal": {
    "kind": "round_trip",
    "source": { "messageId": "actual-message-id", "quote": "安排东京往返，包含酒店、双向机场接送和餐厅，先查方案" },
    "origin": "上海",
    "destination": "东京",
    "originRegion": "CN",
    "destinationRegion": "JP",
    "participants": 2,
    "phase": "quote",
    "lodging": true,
    "arrivalTransfer": true,
    "departureTransfer": true,
    "dining": true,
    "budget": { "minor": "500000", "currency": "JPY" }
  },
  "maxDiscoveryPages": 8,
  "maxAlternatives": 2
}
```

`travel.round_trip@1` 展开去程航班、返程航班，以及显式选择的酒店、到达接送、离境接送和餐厅。两个接送分别依赖相应航班及所选酒店；餐厅依赖所选酒店时保留关联。规则只记录需求依赖，不猜测酒店地址、机场、行车时间、入境缓冲或付款方式，也不把这些依赖转换成“必须先付款”的固定流程。只选择往返航班时，不新增酒店、接送或餐厅。

原生 goal 路径可以为同一 program 准备不同 context。规划器为两个接送生成不同 need 与 step 身份，不合并其路线或业务结果。消费候选时仍须创建各自正确的上下文、执行操作及独立结果校验。

`phase=quote` 需要真正的报价阶段输出；`commitment` 需要承诺阶段输出。参考价、外卖和行程制品不能自动匹配酒店确认、餐厅订位或出票。当前没有允许的 FlightOffer／FlightReservation、DiningOffer／DiningReservation 定义时，会返回 `definition_missing`；这些名称表达所需结果，不会自动创建类型或供应商绑定。没有配置绑定时保留 `binding_unavailable`；不声称市场上不存在供给。

JPY 可作为本规划合同的预算币种，minor 沿用通用 Money 的最小单位整数，不按小数金额猜测缩放。根预算保留在 plan.totalBudget，不复制为每项服务独占的额度；当前没有读取完整报价、汇率、费用和结算证据，因此 budgetStatus=unknown。现有领域沙箱的 CNY／USD／EUR 限制没有被此工具改写；要以 JPY 执行该领域，仍须单独发布兼容的新业务合同和适配器。

## 通用需求与来源依赖

`kind=needs` 接受最多 16 项需求，每项有唯一 id、role、source、output.type、output.phase、可选 output.role／cardinality、target 和 dependsOn。输出 cardinality 默认为 one，不能用集合输出冒充准确的单个结果。可选 serviceConditions 传给既有发现筛选；可选 payment 明确具体工具和币种，但尚无商家实时受理证明时保持 unknown。target 可记录实际起终点、资源、时区、人数及时窗，不构成供应商事实或执行授权。计划还保留准确 requestDigest；原任务约束仍由现有执行与验收机制检查，不能由规划输入覆盖。

候选动作必须有兼容的具名对象输出端口及准确业务阶段。对 `read.mcp.requires`，规划器在同一 program 里查找声明的来源动作，再按端口语义绑定 observationInput，并保留 evaluate、selectionInput 与 derive.function/path。例如现有滴滴估价合同会产生两个独立的 SearchDidiPlaces，再连接 EstimateDidiRide；两个查询分别保留 origin／destination 角色，未知地点选择仍由来源观察核实。

scope、关键词等尚未确定的参数列在 unresolvedArguments，不制造 ObjectRef 或未来来源 ID。未来输出的 derive 只有在原动作实际执行、来源输出被接收后才能由现有受信函数计算。规划器不会执行 derive 或据此跳过地点歧义补问。

## 边界、权限与未知

- 输出始终有 `execution=not_started`、`executionAllowed=false`、`availabilityProof=false`、`businessCompletion=false` 和 `authorization=per_action_required`。
- `coverage=complete` 仅说明本次需求使用的目录检索已完整读取，绝不表示需求已满足、服务有货或世界市场已覆盖。最多读取 8 个发现页，每页最多 10 个 binding 行，每项保留最多 3 个替代方案，来源依赖深度最多 6、每个替代图最多 16 步。预算不足返回 incomplete，不能拿有限检索证明不存在。
- 地区按每项实际履约范围筛选；用户当前所在地不能代替目标服务地区。Pipeline 国家级声明不证明机场、商家或路线支持。精确地点、时段与实时供给保持 unknown。
- 指定钱包名称和币种不证明商家受理、用户工具可用或付款授权。查询、预订、付款和履约分别核验。
- 每次重新检查当前任务、revision、准确发布、source／resource 权限和活动回调；权限不会从上一份规划结果继承。Foundation 的类型存在性来自当前允许的定义视图。
- 只有成功提交并实际返回的规划读取会记入 actionBindings receipt；超出上下文预算或落账失败时，不给后续决策提供 pins。模型仍须读取实际输入对象，原执行授权和验收机制不变。
- 本阶段规划器只消耗静态合同与当前绑定状态，未使用报价或库存，因此没有可以当作实时供给缓存的结果。实际观察的过期、撤权、原操作恢复和迟到保护仍走原路径。

此阶段不包含独立 trusted_planner 执行来源、通用跨币种换算、全局最优旅行组合、真实航班出票、餐厅订位连接器或有偿旅行执行。后续工作应保持原任务与发布，按独立合同与接入验收交付。
