# CSV：新后端委托与独立验收

2026-10-17。当前实现见 [Ontology + LLM 后端](registered-capabilities.md)。新后端不兼容旧执行架构；此前 Grok 的 [v1 实测](evidence/grok-oag-2026-10-15/README.md)保留为历史记录。

## 当前范围

开启 `EIGOS_COORDINATOR=codex` 后，A2A 文本或显式 `eigos.delegate` 进入新后端。LLM 解释实际目标及相关本体，Resolver 读取已配置提供者，LLM 根据候选事实提出计划，程序校验，Worker 在事务外执行并独立验收。

CSV 能力须同时开启 `EIGOS_CSV_PILOT=true` 并配置 `EIGOS_CSV_INPUT_DIR`。只接受本地开发身份及配置目录下 UTF-8 文件 basename；1–1000条记录、最多1 MiB/32列，必需列为 record_id、email、amount_cny、event_date。原始快照固定、私有存储；原始内容不发送给模型。

CSV 的新契约是**全量审计**：missing_required_values、duplicate_record_id、invalid_email、invalid_amount_cny、invalid_event_date 五项检查全部必需且不能重复。子集请求不被扩大为全量；应拒绝或说明范围后补问。额外列只解析，不审计；不修复数据或判断现实业务真假。

## 配置与状态

```dotenv
EIGOS_AUTH_MODE=development
HOST=127.0.0.1
EIGOS_COORDINATOR=codex
EIGOS_CSV_PILOT=true
EIGOS_CSV_INPUT_DIR=/absolute/path/to/dedicated-inputs
```

Gateway 与 Worker 使用同一个本地数据库和一致能力配置；Worker 使用已登录 Codex CLI。启动见 [Gateway/Worker](gateway-worker.md)。本轮不重启现有实例或部署。

新任务先 SUBMITTED，领取后 WORKING；必要缺项进入 INPUT_REQUIRED；有效 CSV 方案进入 AUTH_REQUIRED。`metadata.delegation.request` 保存需求与来源，`resolution` 保存候选及检查，`plan` 固定需求、输入、提供者和本体版本。报价在 `metadata.delegation.plan.quote`。新委托不产生 `metadata.pilot`。

## 确认本地模拟方案

```text
POST /tasks/{taskId}/authorize
Authorization: Bearer <同一任务身份的令牌>
```

```json
{
  "action": "confirm_simulated_payment",
  "requestId": "stable-approval-id",
  "quoteId": "plan.quote.id",
  "quoteDigest": "plan.quote.digest"
}
```

路径和参数可继续由现有 Personal Agent Python 客户端使用。该动作只批准准确绑定的本地模拟方案；没有实际扣款、真实付款回执或模拟退款账本。聊天“yes”不是授权，错误/过期报价、变更计划和跨用户对象均拒绝。幂等重试保持相同 requestId 与内容。

授权后持久排队，派发意图先落盘。适配器使用固定快照生成 JSON/Markdown；独立程序重新解析原始字节、复算检查并验证输入摘要、计划引用和 Markdown。只有独立验收及硬条件都通过才完成；失败不交付“已完成”报告。新运行时尚无自动补交/退款，失败保留观察待查证；这些属于第三阶段。

取消或租约丢失不能撤销已经开始的计算，但迟到观察会保存，任务不会因此被覆盖成完成。旧委托只读，不自动领取或迁移；独立旧 CSV pilot 的模拟补交/退款不算新后端的售后能力。

## 验证口径

自动测试以模型替身验证状态、约束、精确授权、输入/计划损坏和跨协议读回。现有 Python Agent 客户端的发现、重试、授权与取回测试保留。真实模型单独用 `examples/verify-capability-routing.ts --live` 检查；模型真实运行、数据合成、执行本地和无真钱分别说明，不能扩大为真实商家履约。
