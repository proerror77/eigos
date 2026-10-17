# Ontology + LLM 后端

2026-10-17。通用委托主路径已改用 `ontology-execution-v2`；旧 `CapabilityRegistry`、同步 `start(job)` 和旧计划迁移已移除。阶段目标和未完成条件见 [实施目标](backend-implementation-goals.md)。前端 Personal Agent、MCP/A2A 协议、认证及会员接入保持现有接口。

## 业务契约与职责

| 模块 | 当前职责 |
| --- | --- |
| `packages/ontology/execution.ts` | 版本化 ServiceCapability、ProviderBinding、ServiceRequest、Requirement、ExecutionPlan |
| `packages/core/catalog.ts` | 分开登记能力、多个提供者及受控适配器；精确版本与身份检查 |
| `packages/coordinator/requirements.ts` | 从已认证 PA 的原文引用补充约束；拒绝来源不明或覆盖既有条件的模型解释 |
| `packages/coordinator/resolver.ts` | 询问已配置适配器，逐条件 pass/fail/unknown；身份可用性与业务事实分开 |
| `packages/coordinator/plan.ts` | 校验候选、固定输入、动作、版本、约束、依赖、报价及有效期 |
| `packages/coordinator/coordinator.ts` | LLM 解释需求 → Resolver → LLM 基于事实提议计划；不接受模型授权或完成声明 |
| `packages/coordinator/runtime.ts` | 持久意图、事务外异步调用、独立验收、迟到事实记录及 fenced 结果写回 |
| `packages/capabilities/catalog.ts` | 当前能力、绑定和适配器的组合入口 |

同一业务能力允许多个提供者。同版本重复定义、重复绑定、悬空实现均拒绝。新计划固定 capability、binding、ontology、verifier 版本和需求摘要，不静默换供应方。当前只有本地 Brief 与 CSV 提供者；多提供者比较使用明确标记的测试供给，不能宣称已有两家真实商户。

## 任务与推理

`eigos.delegate` 保留自然语言 `goal`。PA 可选传入 `requirements`，字段由入口 schema 验证，来源由服务器写入：

```json
{
  "service": "eigos.delegate",
  "goal": "20杯咖啡，预算500元",
  "requestId": "unique-request-id",
  "requirements": [
    {"id":"cups","kind":"quantity","strength":"hard","expected":{"amount":"20","unit":"杯"}},
    {"id":"budget","kind":"budget","strength":"hard","expected":{"minor":"50000","currency":"CNY"}}
  ]
}
```

此例展示输入契约，当前没有咖啡购买能力，会如实拒绝。也支持 deadline、location 和 condition；金额使用整数字符串，deadline 保存明确时区时间和原表述。condition.expected.predicate 使用已登记谓词，如 brief.json、execution.none；自由文字/未登记条件保持 unknown。原文与结构化来源共存，模型抽取另标 `quoted_text`，不能冒充 PA 的结构化事实。自然语言解释仍可能遗漏或误解要求，不能把保存原文和单例实测当成通用理解质量保证。

第一轮模型看到有界能力摘要和输入 schema，输出 clarify / resolve / unsupported。程序取得选定领域的实际候选后，第二轮模型读取该本体、固定需求和候选观察，输出 propose_plan / clarify / no_feasible_plan。完整目录不无限塞入上下文：最多16项能力摘要、每能力8个绑定；超限需缩小检索范围，现阶段尚无大型目录检索器。

逐条件检查由程序执行。硬条件 fail 或 unknown、币种不兼容、观察过期均阻止计划执行。模型不能修改已准备输入、使用其他绑定、引入不存在的动作或复用旧需求 revision。当前只执行单项业务动作，再运行独立验收；组合步骤和动态重规划尚待第二阶段。

## 适配器与执行

`ExecutionAdapter` 提供异步 `prepare`、异步 `execute` 和独立 `verify`。适配器不直接修改 Job；只有运行时依据验证结果推进任务。`prepare`、模型调用和 `execute` 都在数据库事务外。Gateway 只建立目录及接受提交，不启动这些调用。

准备数据有公开事实和私有载荷两部分。原始 CSV 快照只保存到按 owner 隔离的 `execution_intents`，不进入模型上下文或任务 metadata。派发前意图落盘；适配器返回后先保存 Observation，再用当前领取令牌、revision、租约和任务状态写回结果。取消或租约丢失后的观察保留，但不会把任务改成完成。

第一阶段只开放 local/read 动作；order/payment/cancel/refund 等真实业务副作用尚未开放。已开始但结果不明的动作不自动重放。目前没有远端 reconcile、预算预留、售后恢复或外部 exactly-once 保证；它们属于第三阶段。

## 当前两个适配器

| 业务能力 | 新绑定 | 交付与验收 |
| --- | --- | --- |
| `brief.prepare@2` | `local-brief@2` | 独立核对目标/交付要求，artifact 明确底层 `execution=not_started` |
| `data.quality.audit.simulated@2` | `local-csv@2` | 本地身份、配置文件快照、准确模拟授权、报告原始字节独立复算；无真钱 |

CSV 选择**仅支持全量审计**的契约：五项检查必须完整且无重复，子集明确拒绝，不能静默扩大。新后端没有复用旧 pilot 的付款、补交或退款状态机；独立的旧模拟服务仍保留其测试用途，后续迁入新架构时另行验证。

## 读回、旧记录与扩展

新任务的 `metadata.delegation` 包含 backendVersion、request、resolution、reasoning、plan、intentId 和 acceptance。报价在 `plan.quote`，不再在 `metadata.pilot`。原有 `/tasks/{id}/authorize` 路径及确认参数保留，含义仅为本地模拟授权。Python Personal Agent 客户端无需改代码即可发送、补问、授权和读回。

新后端启用后只发现 eigos.delegate 和可选 intake-only life.request，拒绝旧专用服务直调；Worker 不启动旧文档/跑腿执行器或 pilot 后台循环。旧原型仅保留在独立原型模式，等待后续适配，不作执行 fallback。旧记录保留查询，回复/授权/取消不继续执行；没有兼容适配器、隐式迁移或旧摘要 fallback。不要在同一数据库同时运行新旧 Worker；更新既有实例前停止旧进程并备份数据，本轮未更新任何常驻实例。

新增业务能力：定义 ServiceCapability → 分别登记 ProviderBinding → 实现受控 ExecutionAdapter → 加入组合入口 → 验证硬条件、授权与独立验收。不改变通用协调器来识别业务名称。接入新外部副作用前还须完成对应运行时及授权里程碑。

项目检查覆盖真实协议、合成模型/提供者、双 Worker 领取、取消/租约迟到结果、私有快照损坏和旧记录拒绝执行。真实模型探针单独运行，不计入自动测试：

```sh
node --import tsx examples/verify-capability-routing.ts --live
```

该探针启动隔离的 loopback 实例，使用合成 CSV，无商家、真钱或部署。历史 v1 的 [注册选路证据](evidence/registered-capabilities-2026-10-15/README.md)及 [Grok OAG 证据](evidence/grok-oag-2026-10-15/README.md)只证明当时版本。

新版本已完成7次真实模型调用，含合成多提供者规划；见 [本轮证据与限制](evidence/ontology-backend-2026-10-17/README.md)。
