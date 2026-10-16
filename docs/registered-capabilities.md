# 可注册能力：CSV 审计与 brief.prepare

2026-10-15 实现状态。`eigos.delegate` 现在通过同一协调器选择注册能力，不再绑定 CSV。

## 当前职责

| 模块 | 职责 |
| --- | --- |
| `packages/core/capabilities.ts` | 能力契约与注册表；按身份提供候选、固定版本／提供者、生成委托服务的 Card 描述 |
| `packages/core/delegation.ts` | 通用路由决策、计划与验收记录；不再包含必填 CSV 文件名／检查项 |
| `packages/coordinator/coordinator.ts` | 向真实模型提供当前候选、本体和输入契约；选择、补问或拒绝；校验选择确实注册且可用，再调用能力包 |
| `packages/capabilities/brief.ts` | 任务说明的输入、生成与验收；始终明确 `execution=not_started` |
| `packages/capabilities/pilot/capability.ts` | CSV 文件检查、计划、模拟报价授权、执行衔接与取消；复用独立审计验收和补救 |
| `packages/capabilities/registry.ts` | 组合入口；默认注册 brief，启用 CSV pilot 且配置目录后注册 CSV |
| Worker | 领取协调工作并调用通用后台维护回调，不导入 CsvCoordinator 或 AuditPilot |

模型的输出是 `ask_user / select_capability / unsupported`，包含 capabilityId、说明及按候选输入契约生成的 inputJson。JSON 文本只用于模型传输；能力包负责解析和校验。选择不存在或不对当前身份开放的能力会失败，不能回退到 brief。

“为 CSV 审计写任务说明”和“实际执行 CSV 审计”即使都包含 CSV 这个词，也应分别选择 brief 与 CSV。购买咖啡等无匹配执行能力的目标应拒绝，不能悄悄改成写计划。

## 能力包契约

每个 `RegisteredCapability` 提供：

- `definition`：能力 ID／版本、提供者 ID、本体版本、对外说明、输入 schema、本体。
- `available(owner)`：对经过认证的任务所有者是否可用。本轮 CSV 限本地开发身份；brief 可用于其他正常授权身份。
- `prepare(job, input)`：校验领域输入并取得必要事实；返回需要补问，或规范化输入、计划详情及内部准备数据。
- `start(job, prepared)`：在带领取校验的任务事务内启动领域流程。短的无外部副作用操作可以直接完成；完成时必须有 artifact 与验收通过记录。
- 可选 `authorize(job, input)`：能力自己的授权输入与校验。共用任务核心只负责身份、任务状态和幂等。
- 可选 `cancel(job)`：能力自己的取消语义。
- 可选 `tick()`：本轮同步、本地持久后台流程的推进；Worker 通过统一维护回调调用它。

能力包是受信任的代码，不从外部 Card 下载或执行任意脚本。prepare/start/tick 当前都是同步契约；不可在数据库事务里塞长时间网络调用。接入真正异步外部 A2A 提供者前，需要明确发起／查询／恢复的持久工作项接口，而不是照搬同步 tick。

## 两个注册能力的区别

| 项目 | brief.prepare | data.quality.audit.simulated |
| --- | --- | --- |
| 用户要的结果 | 一份目标／交付要求的任务说明 | 对实际 CSV 数据的审计报告 |
| 主要输入 | goal、deliverable | fileName、checks |
| 本体 | eigos-brief-v1 | eigos-csv-ontology-v1 |
| 提供者 | local-brief-builder | local-csv-auditor |
| 执行与验收 | 校验说明保留目标和交付要求，且明确未执行底层业务 | 独立解析字节、重算规则、核对哈希／订单／Markdown |
| 付款和授权 | 不创建报价／模拟账本 | 保留绑定计划的模拟授权与补交／退款 |
| 完成含义 | 任务说明已生成 | 规则范围内的报告已验收，不代表原始业务数据绝对真实 |

新委托任务在 `metadata.delegation.capabilityId`、capabilityVersion、providerId 中记录选择。通用计划保留 input 和 details；CSV 特有字段位于 plan.details。统一验收结果在 `metadata.delegation.acceptance`，CSV 同时保留原有 pilot 验收证据。

## 新增第三项能力

1. 定义能力的输入 schema、本体、输出、前置条件和验收方法。
2. 实现 RegisteredCapability，把具体执行、授权与恢复逻辑留在能力包里。
3. 在 `createCapabilityRegistry` 中注册实例，提供实际配置和依赖。
4. 验证相似措辞选路、缺信息补问、不支持／不可用、授权、失败以及验收。

在现有同步／本地流程语义内，不需要修改 Gateway、Coordinator、Worker、通用授权分支或领取 SQL。测试中的第三能力仅通过注册即完成调用，以检验这个边界。全新执行语义仍需扩展运行时接口；本轮没有实现通用 DAG、在线安装能力、全网 Agent 搜索或同一能力的多供应商竞价。

## 兼容与调度

原有显式 `service: brief.prepare` 和 CSV pilot 接口保留。任务核心中的这部分是历史直调兼容路径，不属于新协调器；本轮没有声称将所有既有跑腿／文档入口都改成插件。

调度通过通用 `executionMode` 区分 worker 工作与能力自身的后台流程，不再在领取 SQL 中判断是否存在 pilot。启动组合时对旧 CSV 任务进行明确迁移，保持原报价／摘要不变。CSV 适配器可按其声明的旧本体版本识别历史计划，完成任务仍可读。缺失或改变已选版本时拒绝替换提供者。

授权请求幂等比较忽略 JSON 对象键顺序，保留数组和字段值语义，避免从旧的定长授权 schema 迁移到按能力授权后，同一请求因字段顺序变化而冲突。

## 验证

- 全套 70 项自动测试通过；既有 CSV 补问、授权、输入／计划篡改、验收失败补交／退款、跨协议读回保留。
- 新测试覆盖：同一入口两种能力、没有 CSV 配置时的 brief、补问续接、不可用／不存在能力、第三能力仅注册、旧计划授权与领取迁移。
- 真实协调模型通过 A2A 完成三路验证：CSV 任务说明 → brief.prepare；实际 CSV 审计 → CSV 能力并验收；真实买咖啡 → REJECTED。每例一次真实模型调用，付款仅本地模拟。
- 本轮真实三路调用由固定验证客户端发出，不冒称三次都由 Grok 发起。Grok 保存的技能另行同步，连接引用和权限不变。

重复真实验证会产生模型调用和新的模拟任务，需显式运行：

```sh
node --env-file=data/grok-oag/server.env --import tsx examples/verify-capability-routing.ts
```

真实证据见 [注册能力选路验证](evidence/registered-capabilities-2026-10-15/README.md)。
