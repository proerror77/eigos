# 注册能力的真实模型选路验证

2026-10-15，上海时间约 21:41–21:43。固定验证客户端通过本机 A2A 1.0 调用 EIGOS；协调器每次从注册表获得 brief.prepare 和 CSV 审计两个候选，真实 Codex 模型选择结果。

| 用户任务 | 实际选择 | 结果 |
| --- | --- | --- |
| 为 CSV 审计写任务说明，明确不读取文件、不执行审计 | brief.prepare | COMPLETED；保留 execution=not_started，无 pilot／模拟付款 |
| 实际审计指定 CSV，交付审计报告 | data.quality.audit.simulated | 计划／模拟授权／执行／独立验收全部通过 |
| 实际购买并配送咖啡，明确不要建议或计划 | 无匹配能力 | REJECTED，无交付物、无模拟付款，未回退到 brief |

任务编号：

- brief：`01933074-e897-4dde-8fb2-f8fbbfb5e73e`
- csv：`c765e195-cf76-4f06-88b7-82b7d75d311e`
- unsupported：`0427f4e4-3566-4103-a7a2-c6fa031a8cd9`

每个案例各有一次真实模型调用收据，含 threadId、usage 和输出摘要。验证脚本不替模型挑选能力，只对真实返回值断言预期。第一例特意含有 CSV 关键词，验证“写任务说明”与“实际审计”的结果差别。

## 证据

- [verification.json](verification.json)：实际请求／响应和汇总，未保存认证头。
- [brief.json](brief.json)、[csv.json](csv.json)、[unsupported.json](unsupported.json)：原始目标与最终 A2A 结果。
- `*-server-task.json`：各任务的服务端快照及模型收据。
- [agent-card.json](agent-card.json)：注册表生成的能力说明。
- [source-sha256.json](source-sha256.json)：归档时源码摘要。
- [test-summary.txt](test-summary.txt)：70 项自动测试通过。

Grok 的既有 eigos-delegate 技能已另行同步到新版本，并执行 discover 核对；连接电脑、客户端、profile、凭据和权限保持原配置。[技能回读](grok-installed-skill.md)及其 [SHA-256](installed-skill-sha256.txt)已保存。Grok 本轮只同步技能，没有发出上述三个任务；不能把固定验证客户端的结果写成三次 Grok 委托。

CSV 输入仍为合成数据，付款为本地模拟；没有实际购买咖啡。当前验证范围是两个已注册本地能力的单能力选路，不代表通用多步骤编排、外部 A2A 提供者发现或生产部署已经完成。扩展接口见 [实现说明](../../registered-capabilities.md)。
