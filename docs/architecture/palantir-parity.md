# Functions、Scenarios 与 Machinery 的对标计划

2026-11-26 定下的目标：Functions、Scenarios 和 Machinery 达到 Palantir Foundry 的同等能力。查询内核（[路线 C](query-kernel.md)）的 C2 到 C5 是这三项的执行基础，所以对标工作排在内核主线之后，或与它交错进行。

各节的 Palantir 依据来自下列官方文档，每节末尾也列出所用页面：
- [Functions](https://www.palantir.com/docs/foundry/functions/overview/)
- [Ontology scenarios](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario/)
- [Machinery](https://www.palantir.com/docs/foundry/machinery/overview/)

## Functions：差距最大

现状：Function 在发布定义里声明参数、返回值、依赖和可选版本，实现绑定在代码里，多数是供应商连接器和确定性业务逻辑。
- edit Function 只能通过 Action 的编辑上下文提交，这相当于 Function-backed Action。
- 普通 Function 只能读取对象。
- spared 是用 Wasm 插件隔离执行用户代码的一个试点。

| 能力 | Palantir | EIGOS 现状 | 阶段 |
| --- | --- | --- | --- |
| 用户编写、发布、执行函数 | TypeScript v1/v2、Python 在隔离环境运行，有 serverless 和 deployed 两种模式；TS v2 最多可申请 8 vCPU 和 5 GB 内存 | 只有代码内置实现，加上 Wasm 试点 | F1 |
| 版本与发布 | 语义化版本；serverless 可以多个版本并存；Automate 可以选择在兼容版本间自动升级 | 有可选版本字段，没有发布流程 | F1 |
| 函数内的 Ontology API | 按主键读取对象、遍历关系、Object Set 查询与聚合（服务端执行，最多 1 万个分组）、Interface | 只能通过对象读取接口 | F2，在查询内核上执行 |
| 编辑与写后读 | Edits API；staged writes 提供写后读和原子执行；只有 Function-backed Action 会应用编辑 | edit Function 依赖 Action 的编辑上下文 | F2 |
| 外部调用 | 必须先配置 source；受出口策略约束；有 secrets、OAuth 出站应用和 webhook | 供应商连接器写在代码里 | F3 |
| 测试与观测 | 单元测试（对象、搜索和用户都可以做 stub）、Performance 面板、监控、遥测、指标 | 有仓库测试，没有面向函数作者的工具 | F4 |
| 模型与流式 | 调用语言模型、functions on models、流式函数、语义检索向量 | 有 Agent 和嵌入 Function | F5 |

阶段：
- **F1 函数运行时。** 用户函数编写后编译成 Wasm，在 spared 宿主中隔离执行，宿主沿用已有的 spared 试点。每次调用都有 CPU 时间、内存、对象读取量和调用深度的上限。函数先作为定义分支发布，按语义化版本管理，有自己的调用权限，然后经过现有的候选准备和审阅。
- **F2 Ontology API 与编辑。**
  - 函数内的对象、关系、Object Set 和聚合接口通过查询内核执行，可执行性与权限沿用规划层的判断。
  - 编辑接口在函数内提供写后读：同一次调用内暂存编辑，由 Function-backed Action 在一个事务里提交。
- **F3 外部源。** 一个 source 由连接、出口策略和 secrets 组成，可以挂接 OAuth 出站凭据。函数只能调用自己声明的 source。webhook 函数挂在 Action 的副作用上。
- **F4 测试与观测。**
  - 测试框架可以 stub 对象、查询和主体，并能断言函数产生的编辑。
  - 每次调用记录耗时分解（执行、读取对象、遍历关系）、错误和资源用量。
- **F5 模型与流式。** 通过模型别名调用语言模型，受模型出口策略约束。支持流式返回，向量生成函数接入语义检索。

## Scenarios：补模拟与自动同步

现状：
- 临时会话和持久方案。
- `applyScenario` 合并规则限定类型范围，在一个事务里逐步校验。
- 显式 rebase 和同步正式数据，可检测单值关系冲突。
- 跨账号审阅、撤销与补偿、`ScenarioClient`。
- 2 到 6 个方案并排比较（Object Set 聚合和 Function 指标），离线多候选试跑和评估集。
- 排程重规划和自动化规则预演。

| 能力 | Palantir | EIGOS 现状 | 阶段 |
| --- | --- | --- | --- |
| 与正式数据同步 | 每 10 分钟自动 rebase，不能配置 | 只有显式 rebase 或同步 | S1 |
| 按执行上下文区分的提交条件 | 在 Scenario 中可以用更宽松的条件测试 Action | 没有 | S1 |
| 模型与模拟 | functions on models、Function-backed Action 驱动模拟；Vertex 的时间序列输入、覆盖和基线对比 | 没有模型或时间序列 | S2 |
| 方案即对象、审批流程 | 持久方案是实现 Scenario 接口的对象；审批是用状态和提交条件搭的示例流程 | 有方案元数据类型和审阅邀请 | S3 |
| 规模 | 合并受 Action 上限约束；默认 31 天过期 | 有过期清理；视图按引用逐个求值 | S4，依赖内核 C5 |

阶段：
- **S1 自动同步与执行上下文。**
  - 兼容的正式数据变化定期自动带入方案。一旦有冲突就停止同步，并在方案里标出冲突。
  - Action 的提交条件可以区分在 Scenario 中执行和在正式数据上执行。
- **S2 模型与模拟。**
  - 定义一类模型 Function：输入是对象、属性和时间序列，输出是预测属性。
  - 方案里可以覆盖输入、运行模型，并与基线方案比较。
  - 时间序列属性及其窗口与平滑处理随本阶段加入 Ontology 类型系统。
- **S3 方案对象与审批。** 方案元数据实现一个 Scenario 接口，由对象策略和提交条件管理谁能查看、提交审阅、批准或合并。审批与合并可以由同一个受治理的 Action 完成。
- **S4 规模。** Scenario 的编辑作为叠加层由查询内核执行（C5），大方案的查询和比较不再逐个对象求值。

## Machinery：补可配置监控，再做编排扩展

现状：
- 模型：流程模型绑定在已发布的 ProcessLog 类型上，包含状态、停留目标、转换对应的 Action 和子流程。
- 挖掘：按最少案例数、覆盖率和排除项挖掘。
- 一致性与瓶颈：已建模与已观察的一致性对比、偏离实例、P50/P95 瓶颈、路径、停留分布。
- 复盘与提案：下钻子流程、定期复盘、模型提案（生成定义分支）、候选模型对比。
- 日志延迟：提交即可见，比 Palantir 日志流水线约 2 到 5 分钟的延迟更短。

| 能力 | Palantir | EIGOS 现状 | 阶段 |
| --- | --- | --- | --- |
| 指标视图 | 历史与当前的计数和时长四种视图；可自定义节点和边的指标、条件着色、Sankey 流量 | 有固定的指标集合 | M1 |
| 选择输出 | 节点可选"当前处于"或"曾经处于"；边可选"经过"或"最后一次转换"；输出 Object Set 供下游使用 | 可以筛选实例 | M1 |
| 一个类型上的多个状态属性 | 每个状态属性一个容器，容器可以嵌套和链接 | 每个 ProcessLog 只跟踪一个状态属性 | M1 |
| 状态的副作用 | 自动化触发通知；编排多个 AIP 智能体 | 过程规则驱动 Workflow 和 Action | M2 |

阶段：
- **M1 监控对齐。** 可配置的指标视图；节点和边的选择模式及输出 Object Set；同一类型上多个状态属性的流程容器；状态和停留超时时的通知。
- **M2 流程编排**（原 07.1 到 07.4，是 EIGOS 在 Palantir 之外的扩展）：
  - 从 Ontology 与流程定义编译执行结构；
  - 根据业务状态推导合法的 Action；
  - 分析跨流程依赖；
  - 动态分支、组合与汇合。
- **M3 事件驱动与治理**（原 07.5 到 07.7）：
  - 基于 Funnel 05.4 的变化订阅做局部重规划；
  - 挖掘结果转成可审阅的流程改进提案；
  - 流程的版本、审核与发布。

## 顺序

1. **查询内核 C2 到 C4。** 完成后对象集查询走内核，并部署到生产。
2. **F1，可与 C2 到 C4 并行。** 它不依赖内核。
3. **C4 之后：** F2、S1、M1。
4. **C5 之后：** S2、S4、M2，以及原 OSS 03.3 到 03.5。
5. **最后：** F3 到 F5、S3、M3，以及 C6 基准、运行时 06.x、并发 04.3/04.4 和规模化 09.x。

每个阶段一个或多个 PR，各自带上依据链接、实现边界和测试。阶段的验收标准是：在同一类业务用例上，提供与 Palantir 文档所述能力等价的功能和限制说明。Palantir 文档没有给出的限制，由 EIGOS 自行规定并写入文档。

依据页面：
- Functions：[overview](https://www.palantir.com/docs/foundry/functions/overview/) · [language feature support](https://www.palantir.com/docs/foundry/functions/language-feature-support/) · [edits](https://www.palantir.com/docs/foundry/functions/edits-overview/) · [API calls](https://www.palantir.com/docs/foundry/functions/api-calls/) · [performance](https://www.palantir.com/docs/foundry/functions/optimize-performance/) · [use functions](https://www.palantir.com/docs/foundry/functions/use-functions/)
- Scenarios：[overview](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario/) · [temporary](https://www.palantir.com/docs/foundry/ontology/temporary-scenario/) · [persisted](https://www.palantir.com/docs/foundry/ontology/persisted-scenario/) · [merge](https://www.palantir.com/docs/foundry/ontology/merge-scenario/) · [OSDK](https://www.palantir.com/docs/foundry/ontology/osdk-scenario/) · [Vertex scenarios](https://www.palantir.com/docs/foundry/vertex/scenarios-overview/)
- Machinery：[core concepts](https://www.palantir.com/docs/foundry/machinery/core-concepts) · [draw a graph](https://www.palantir.com/docs/foundry/machinery/draw-a-graph/) · [connect data](https://www.palantir.com/docs/foundry/machinery/connect-data/) · [process mining](https://www.palantir.com/docs/foundry/machinery/process-mining/) · [analyze and monitor](https://www.palantir.com/docs/foundry/machinery/analyze-and-monitor/)
