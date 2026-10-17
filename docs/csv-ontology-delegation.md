# CSV：v3 委托与独立验收

2026-10-17。通用后端为 `ontology-execution-v3`，架构及其他能力见 [后端说明](registered-capabilities.md)。历史 [Grok v1 实测](evidence/grok-oag-2026-10-15/README.md)与 [v2 内核证据](evidence/ontology-backend-2026-10-17/README.md)只证明对应当时版本，不自动迁移旧计划。

开启 EIGOS_COORDINATOR=codex、EIGOS_CSV_PILOT=true、EIGOS_CSV_INPUT_DIR 后，PA 可通过 MCP/A2A 发送自然语言审计目标。只允许本地开发身份、配置目录的 UTF-8 文件 basename、1–1000条记录、最多1 MiB/32列。必需列 record_id/email/amount_cny/event_date，额外列只解析不审计。

服务只支持完整五项：missing_required_values、duplicate_record_id、invalid_email、invalid_amount_cny、invalid_event_date。子集明确拒绝或补问，不能静默扩大成全量。它不修复数据，也不判断现实业务真假。

LLM 解释目标 → 程序读取并固定快照 → LLM 提议计划 → 程序核对输入/定义/提供者/约束 → AUTH_REQUIRED。原始字节只在私有 action_intents，不发送给模型。报价同时绑定需求摘要、提供方、输入和准备详情；重算计划摘要不能让旧报价批准新输入。

```text
POST /tasks/{taskId}/authorize
Authorization: Bearer <同一任务身份>
```

```json
{
  "action": "confirm_simulated_payment",
  "requestId": "stable-approval-id",
  "quoteId": "metadata.delegation.plan.quote.id",
  "quoteDigest": "metadata.delegation.plan.quote.digest"
}
```

此接口只批准准确的本地模拟方案，无扣款/真实支付/退款。现有 PA Python 客户端可继续使用。普通聊天不是许可；错误/过期报价、计划变更和跨用户对象拒绝。撤回用 cancel_task；授权撤销有独立入口。

授权后 Worker 先记动作意图与尝试，在事务外生成报告；独立程序重新解析原始字节、计算规则、检查引用/哈希与 Markdown，全部通过才交付。输入损坏在派发前拒绝。取消/租约丢失的迟到观察不覆盖 Task。独立历史 pilot 的模拟付款/补交/退款不是此新 CSV 适配器的执行路径。

新 metadata.delegation 保存 request、successCriteria、resolution、plan、actions、outcome、acceptance；不再使用 metadata.pilot。Brief 的说明完成仍明确 underlying execution=not_started。开发同步、模型运行、报告验收和现实商家履约分别核验。
