# CSV 文件输入与真实 Agent 验证

2026-10-15 完成。用户未指定业务文件，明确允许使用新生成的 CSV 验证方式。输入是本次生成的 5089 字节、64 条数据记录的真实磁盘文件，含随机 ID、重排表头、额外列、BOM、CRLF、引号转义、逗号和多行字段；不是三个预置数据集，也不是实际客户数据。

## 结果

真实 Codex Agent 于北京时间 16:19:11–16:20:14 执行 12 次工具调用，跨 MCP 与实际 A2A HTTP 入口完成：

| 场景 | 验收记录 | 终态 | 模拟付款/退款次数 |
| --- | --- | --- | --- |
| 正常 | true | completed | 1 / 0 |
| 首次错误行号 | false → true | 补交后 completed | 1 / 0 |
| 持续错误行号 | false → false | failed，refunded | 1 / 1 |

Agent 使用 `fileName` 下单，没有 datasetId。原始文件字节摘要、报价摘要绑定、最终报告摘要均已独立读回验证。错误注入保留记录数与问题数量，但改动问题行号，证明验收不是只检查数量。验收器从输入原始快照重新解析并计算，不调用供应商解析/计算/渲染函数，不使用固定 golden 结果。

- [独立验证汇总](evidence/csv-file-real-agent-2026-10-15/verification.json)
- [输入来源记录](evidence/csv-file-real-agent-2026-10-15/input-manifest.json)
- [临时生成测试 CSV](evidence/csv-file-real-agent-2026-10-15/generated-test-input.csv)
- [真实 Agent 总结](evidence/csv-file-real-agent-2026-10-15/agent-final.md)
- [实际工具调用记录](evidence/csv-file-real-agent-2026-10-15/agent-events.jsonl)
- [正常报告](evidence/csv-file-real-agent-2026-10-15/normal-report.md)
- [补交报告](evidence/csv-file-real-agent-2026-10-15/repair-report.md)
- [补交完整状态](evidence/csv-file-real-agent-2026-10-15/repair-readback.json)
- [失败退款状态](evidence/csv-file-real-agent-2026-10-15/refund-readback.json)

## 实现与限制

新增真实文件导入、供应商文件报告和独立验收模块，位于 packages/capabilities/pilot。当前工作区架构已迁移为 Gateway/Worker，共享任务入口、数据库与权限行为继续复用，保留其他在途改动。

新增 csv-parse 7.0.3 用于供应商端标准 CSV 解析；验收端使用独立字符状态机和规则实现。支持专用目录、UTF-8、1 MiB、1–1000 条记录、最多32列；四个必需列 record_id/email/amount_cny/event_date，可重排，额外列只解析。禁止任意路径、符号链接和外部 URL。输入快照保留本地，不把原始单元格发送模型；报告只返回规则和问题行号。

`npm run check`、全套57项测试及`npm run build`通过。新增测试覆盖30轮随机文件、解析边界、错误行号、畸形/超限/无效UTF-8、路径限制、原文件改动、重启恢复、输入快照损坏后退款。临时运行网关、凭证与数据库已清理。

付款仍为模拟；A2A 经薄 MCP 工具适配器转发，不代表 Codex 原生 A2A；没有支付宝/阿宝接入或真实客户业务验证。运行方式与输入约定见[试点说明](csv-audit-pilot.md#真实-csv-文件输入付款仍为模拟)。
