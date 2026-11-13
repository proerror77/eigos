# Ontology 架构

语义层描述领域中的对象、属性、接口、关系、可调用逻辑与业务操作。运行层保存对象，执行查询、来源接入、Functions 和 Actions。两层通过发布的 JSON 定义连接。设计依据是 Palantir 官方的领域建模、复用、扩展和组合原则。[Building principles](https://www.palantir.com/docs/foundry/ontology/ontology-best-practices)

## 五类 Schema

| 类型 | 定义内容 | 当前运行入口 |
| --- | --- | --- |
| Object Type | API 名称、说明、主键、标题属性、属性和 Interface 实现 | `Ontology.object`、`Objects.read`、来源映射 |
| Property | 业务含义、值结构、必需性 | JSON Schema 校验及 Interface 属性投影 |
| Interface | 属性、关系约束、Action 参数约束及具体类型的映射 | 对象集查询、关系导航、`resolveAction` |
| Link Type | 两侧对象、两侧名称、基数 | PostgreSQL 关系表及 `Objects.follow` |
| Action Type | 参数、对象参数类型、提交条件、对象与关系编辑规则 | `Actions.apply` 的单次事务 |

Interface 通过实现映射引用具体 Object Type 的属性、关系与 Action 参数。查询由本体查询服务执行，Function 可以组合查询和计算。Action 表达用户或 Agent 提交的变更。[Interface 实现](https://www.palantir.com/docs/foundry/interfaces/implement-interface)、[Action 参数约束](https://www.palantir.com/docs/foundry/interfaces/interface-action-type-constraints)

关系带有日期、角色或状态等业务信息时，用独立对象保存这些信息，并通过 Link 连接两端。当前来源时间和证据类型保存在 `SourceReceipt` 对象中。[Object-backed links](https://www.palantir.com/docs/foundry/object-link-types/create-link-type)

## 模块边界

```mermaid
flowchart TD
    Agent[Agent / PA] --> Gateway[Gateway MCP / A2A / HTTP]
    Gateway --> Query[Ontology 查询服务]
    Gateway --> Function[Functions]
    Gateway --> Action[Actions]
    Gateway --> Task[任务队列]
    Task --> Worker[Worker]
    Worker --> Model[模型 Agent]
    Model --> Query
    Model --> Function
    Model --> Action
    Definition[发布的 Ontology JSON] --> Query
    Definition --> Function
    Definition --> Action
    Function --> Provider[供应商 MCP]
    Provider --> Ingest[来源映射与入库]
    Query --> DB[(PostgreSQL 对象与关系)]
    Action --> DB
    Ingest --> DB
```

| 模块 | 职责 |
| --- | --- |
| `packages/ontology/schema.ts` | 声明定义的数据结构 |
| `packages/ontology/model.ts` | 解析定义、属性映射、Link 导航、Action 参数映射 |
| `packages/ontology/definitions/ride.json` | 滴滴领域的发布定义及来源字段映射 |
| `packages/runtime/metadata.ts` | 发布定义并按任务引用解析 |
| `packages/runtime/objects.ts` | Owner 范围内的对象集查询、关系查询与存储 |
| `packages/runtime/ingestion.ts` | 将来源行按发布映射写入对象 |
| `packages/runtime/functions.ts` | 参数与返回值校验、函数和来源绑定 |
| `packages/runtime/actions.ts` | 提交条件、编辑规则、幂等事务与操作记录 |
| `packages/runtime/tasks.ts` | 任务状态、领取租约、取消与来源调用记录 |
| `packages/runtime/agent.ts` | 从任务发布版本提供发现与工具调用，返回模型选择的 Function 结果 |
| `packages/runtime/harness.ts` | 独立模型会话与任务专用 Ontology MCP，不保存第二份任务 |
| `packages/runtime/sources.ts` | 执行发布的数据源 Function，把服务端持有的回值交给来源投影 |
| `packages/capabilities/didi/` | 滴滴响应解析、领域 Function 与来源投影 |
| `apps/gateway/`、`apps/worker/` | 协议认证与执行进程 |

这些职责对应 Foundry 的 Metadata、Object databases、Object Set Service、Actions、Object Data Funnel 和 Functions。这里采用单个 PostgreSQL 存储服务，定义解析与来源连接器通过进程内模块实现。[官方运行架构](https://www.palantir.com/docs/foundry/object-backend/overview)

## 滴滴业务链

```mermaid
flowchart LR
    Location[Location Interface] --> Place[Place]
    Route[Route / RideEstimatable] -->|origin / destination| Place
    Decision[RideInquiry.estimate / EstimateRide Action] --> Request[RideRequest]
    Request -->|route| Route
    Estimate[RideEstimate / PriceEstimate] -->|request| Request
    Estimate -->|source| Receipt[SourceReceipt]
    Place -->|sources| Receipt
```

模型接收用户原文与任务发布版本的 Interface、Link、Function、Action 和 data source 目录。Agent 理解需求并选择业务能力，确定性的业务步骤由该能力绑定的 Function 和 Action 执行。运行调度器不包含滴滴步骤或地点名称。[Palantir Agent 工具](https://www.palantir.com/docs/foundry/agent-sdk/customize-agent)

`RideRequest` 实现 `RideInquiry` Interface，其 `estimate` 能力映射到 `EstimateRide` Action。参数是城市、起终点场所名及可选车型。创建能力通过实现类型解析，无需编造一个尚不存在的对象引用。这对应官方 Ticket Interface 将创建能力映射到具体创建 Action 的模式。[Interface Action](https://www.palantir.com/docs/foundry/interfaces/interface-action-type-constraints)

`EstimateRide` 使用 `prepareRideInquiry` edit Function。函数完成以下确定性工作：

1. 并行读取 `DidiPlaces`，来源投影按发布映射写入地点事实及来源 Link。
2. `resolveRideLocations` 通过 `Location.name` 和各自的来源 Link 查询完整名称匹配。唯一匹配直接使用；入口、商铺等不同名称不会造成歧义。同名或没有匹配时返回真实候选及 ObjectRef。用户明确选择后复核其属于对应来源结果，并刷新来源读取。
3. `estimateLocations` 用来源坐标取得真实价格。外部请求全部发生在业务编辑事务之外。
4. Action 在一次事务内创建路线、询价请求、报价及关联 Links。Function 通过 Action 的编辑上下文提交，直接求值 edit Function 会被拒绝。失败的业务编辑整体回滚；已接收的来源事实保持独立。

这些是 Function-backed Action 的实现职责。通用 Action 运行层负责参数、提交条件、事务及幂等记录，没有新增工作流规则语言。[Function-backed Actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview)

Agent 可在一次 `complete_with_action` 调用中选择 Interface Action 与结果 Function，并指定把 Action 返回的对象引用绑定到哪个函数参数。运行层执行 Action 后调用 `readRideEstimates`，后者按 `PriceEstimate` 和 source Links 检查当前来源、有效期和报价，再直接返回真实结果。验收在读取时重新执行，重复 Action 不会使旧的验收标志跳过检查。Agent 不需要在来源读取、对象创建或验收之间继续往返。

普通 Function 仅获得对象读取接口；edit Function 的写入上下文由 Action 提供。来源价格由连接器和字段映射生成，模型不能提供入库价格。取消或租约失效阻止后续提交。

对象集查询示例。

```json
{
  "query": {
    "type": "PriceEstimate",
    "from": {"object": {"type": "RideRequest", "id": "REQUEST_ID"}, "link": "estimates"}
  }
}
```

请求、任务调度和技术调用分别保存在专用运行表。地点和路线具有业务身份，费用估计是一次来源观察，来源凭据保存在运行配置中。标准化过程保留供应商坐标系声明及价格范围。[结构指导](https://www.palantir.com/docs/foundry/ontology/ontology-structural-guidance)

## 执行与数据访问

Gateway 校验 JWT 的签名、issuer、audience、有效期和 scopes。对象、关系、任务及 Action 记录都按当前 owner 查询。来源绑定限定 owner，并在调用与入库时检查是否仍有效。

Action 的对象和关系编辑与操作记录共用事务。相同 requestId 的重复请求返回原结果，参数冲突会被拒绝。数据库约束执行关系基数，失败事务回滚编辑。Provider 请求在数据库事务外进行，返回结果通过来源映射提交。[Action 语义](https://www.palantir.com/docs/foundry/action-types/overview)

Worker 使用 PostgreSQL 通知唤醒，行锁领取单个任务，并在执行期间续租。取消或租约失效使后续提交失败。已完成的来源调用可以在原任务内复用，结果未知的原调用会保留失败状态。

## 当前支持范围

对象查询支持类型或 Interface、等值筛选、字段选择和游标。关系支持双向导航与一对多基数。Action 支持声明式对象与关系编辑，以及 Function-backed Action 的原子提交。Function 具有独立参数与返回契约，已接入外部来源读取和对象计算。

第一条实现的领域用例是滴滴估价。模型解释自然语言并使用发布的业务能力，PA 也可提供结构化参数。通用调度器的跨定义行为有工程回归，真实业务验收范围仍是本次滴滴路线。完整 Foundry 产品的界面、其他业务领域的真实验收、属性 reducer、媒体类型、跨组织共享和通用删除规则尚未在本版实现。

验收使用实际业务问题从入口走到结果，并记录耗时、路径和歧义。合成回归保持可重复，真实 MCP 验收另存私有记录。[官方验证方法](https://www.palantir.com/docs/foundry/ontology/ontology-design-validation)
