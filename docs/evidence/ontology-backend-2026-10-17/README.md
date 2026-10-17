# 新 Ontology + LLM 后端验证

2026-10-17，Asia/Shanghai。对应实现标识 `ontology-execution-v2`；结构化结果、模型运行收据及合成候选事实见 [verification.json](verification.json)。

## 真实模型运行

通过隔离的 loopback Gateway/Worker 发起真实 Codex 调用，使用新解释器、Resolver、事实规划器、计划校验及本地适配器。原始私有运行输出保留在忽略的 `data/ontology-backend-live/`，本目录只归档已检查的证据。

| 场景 | 结果 | 模型调用数 |
| --- | --- | --- |
| JSON 任务说明 | COMPLETED；独立检查保留输入，底层 execution=not_started | 2 |
| 合成 CSV 全量审计 | 准确模拟授权后 COMPLETED；原始字节与报告独立验收通过 | 2 |
| 真实买咖啡的请求 | REJECTED；没有购买提供方，不改成说明 | 1 |
| 仅 invalid_email 的 CSV 子集请求 | REJECTED；没有静默扩大为五项检查 | 1 |
| 同能力下三个合成提供者比较 | 新计划校验通过，选中满足20杯/500元/截止时间的 fixture.on-time | 1 |

合计7次成功模型调用。提供者比较直接调用同一个真实规划器和计划校验器：便宜候选09:30超出09:00截止时间，另一候选产能未知，选中450元且08:30的20杯候选。该场景只验证规划，测试适配器禁止派发。

## 反例与限制

自动测试另覆盖：同能力多绑定、精确版本、禁用/身份权限、硬条件未知/失败、币种不兼容、过期观察、模型改输入/绑定/动作/revision、来源伪造、旧任务只读、快照损坏、取消和租约丢失后的迟到事实。

本地 `npm run check`、118项 `npm test`、`npm run build` 和 `git diff --check` 通过；模型和供给反例使用夹具，独立于上述7次真实模型调用。远端验证以本提交对应 GitHub Actions 记录为准。

首次真实探针发现 JSON/仅说明条件使用自由文字后无法与程序事实匹配。现已改为本体登记谓词，如 brief.json、execution.none，原文保存在来源引用中；增加回归测试后，上述真实场景通过。没有把未知条件默认判为满足。

这是**真实模型 + 合成数据/供给 + 本地执行**证据。不是 Grok 本次发起、真实商户发现、付款、配送、跨系统恢复或生产部署证据。自然语言抽取还可能遗漏、误解复杂约束；这组单例不能证明通用规划质量或长时间可靠性。

复现需已登录的 Codex CLI，显式执行 `node --import tsx examples/verify-capability-routing.ts --live`。可用 `--providers-only` 单独验证多候选规划。探针建立临时数据库，结束后清理，不修改常驻服务。
