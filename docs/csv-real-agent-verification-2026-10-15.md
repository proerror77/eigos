# 真实 Agent 调用 CSV 模拟试点验证

日期：2026-10-15。成功运行北京时间 16:05:49–16:07:33，约 104 秒。

## 结论

真实 Codex CLI Agent 通过远程 HTTP MCP 和薄工具适配器转发的 A2A 1.0 JSON-RPC，自行发现服务、创建任务、读取报价、确认模拟付款和查询终态。13 次实际工具调用完成三种场景；服务端 HTTP 记录、模型工具结果及独立 SQLite 读回相互对应。

| 场景 | 调用路线 | 读回结果 | 付款/退款次数 |
| --- | --- | --- | --- |
| 正常 | MCP 下单/报价 → A2A 确认 → MCP 结果 | completed / paid / accepted | 1 / 0 |
| 补交 | A2A 下单 → MCP 确认 → A2A 结果 | 首次 rejected，补交 accepted，completed | 1 / 0 |
| 退款 | MCP 下单/确认 → A2A 结果 | failed / paid / rejected / refunded，step=done | 1 / 1 |

付款与退款次数来自独立模拟提供方账本，不只采信模型总结。报告正文摘要匹配。退款场景保留原 paid 事实，不将退款后任务误报为 completed。

## 证据

- [独立核验汇总与真实 taskId/orderId](evidence/csv-real-agent-reviewed-2026-10-15/verification.json)
- [真实 Agent 最终回答](evidence/csv-real-agent-reviewed-2026-10-15/agent-final.md)
- [实际工具调用与回执](evidence/csv-real-agent-reviewed-2026-10-15/agent-events.jsonl)
- [正常场景读回](evidence/csv-real-agent-reviewed-2026-10-15/normal-readback.json)
- [补交场景读回](evidence/csv-real-agent-reviewed-2026-10-15/repair-readback.json)
- [失败退款读回](evidence/csv-real-agent-reviewed-2026-10-15/refund-readback.json)
- [正常报告](evidence/csv-real-agent-reviewed-2026-10-15/normal-report.md)
- [补交后报告](evidence/csv-real-agent-reviewed-2026-10-15/repair-report.md)
- 协议证据：[normal](evidence/csv-real-agent-reviewed-2026-10-15/normal-http.jsonl)、[repair](evidence/csv-real-agent-reviewed-2026-10-15/repair-http.jsonl)、[refund](evidence/csv-real-agent-reviewed-2026-10-15/refund-http.jsonl)。A2A HTTP 请求均返回 200，具体业务结果另由读回验证。

## 真实使用发现的问题

第一轮非交互只读运行的下单工具被客户端拒绝，错误为 MCP 工具需要审批但 approval policy 为 never；服务发现成功，订单数为零。未绕过改走其他接口，保留[失败轮回答](evidence/csv-real-agent-2026-10-15/agent-final.md)。随后使用 CLI 支持的 `--approve-for-me` 受审核执行模式，完成第二轮。未将修改工具标成只读，未使用禁用全部审批选项，未改用户全局设置。

这说明仅有网关测试通过不足以保证真实客户端可用，客户端审批方式也是接入条件。另一个限制是 Codex 此次通过 MCP 工具调用薄适配器后进入 A2A；不能称为 Codex 原生 A2A 能力。

## 实施与范围

新增 `examples/pilot-real-agent.ts` 和 `examples/pilot-a2a-bridge.ts`。createApp 增加仅代码注入的 pilot factory，用于给三个隔离测试网关装配不同模拟故障，不增加用户可提交的故障开关或公网接口。运行 `npm run demo:csv-agent -- output/新目录` 可复现，需要本机 Codex 登录和模型服务，可能消耗真实模型额度。

演示脚本不代模型创建/确认订单；脚本只启动网关、注入预定供应商故障、启动真实客户端，并在结束后独立检查数据库。支付、供应商、数据均为模拟；验收是服务端固定规则与独立 golden 结果，模型负责客户端决策和结果解释。没有支付宝/阿宝接入、真实资金交易、实际客户数据或公网部署。

临时网关、凭证和数据库结束后清理；仅保留脱离凭证的调用证据及报告。类型检查、48 项回归测试、构建通过。此次不是对外部商家、任意 CSV 或无人监督生产执行的认证。
