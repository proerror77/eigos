# Grok Bot → EIGOS 真实 A2A 联调

日期：2026-10-15，上海时间 11:57:53–11:59:47；Grok Bot 在 12:00:08 于 Monk 对话中确认收到交付物。

## 结果

同一任务完成 `WORKING → INPUT_REQUIRED → WORKING → COMPLETED`。任务编号：`0da8dda9-04b2-4ae5-9c5f-a50f08461ca5`。

- 请求方：Mac 上的 Grok Bot / Monk，使用其已有的连接电脑能力，在用户 Mac 发出 A2A HTTP 请求。
- 服务方：EIGOS `agent.execute`，后台执行了两次真实 Codex 模型调用。第一轮判断信息缺口并提问，第二轮使用任务历史和真实回复生成交付物。
- 传输：A2A 1.0 JSON-RPC，loopback `127.0.0.1:3417`。发现卡片一次、SendMessage 两次、GetTask 22 次；没有 `/mcp` 请求。
- Grok Bot 收到服务端问题后，自己组织答复并明确标注行业、渠道、AI 经验和分组假设。客户端脚本只负责收发 HTTP；回复内容从 Grok 另行写出的文件读取，没有自动生成固定问答。
- 交付：完整繁体中文《橙灣-47｜AI 客戶諮詢處理工作坊》，含议程、案例、政策卡、练习、交付模板和审核表。
- 客户端保存的交付物与服务端 Artifact 逐字一致，SHA-256 为 `44a71b67ccc5c6a86ab23ab7c60db2c810048bc64bcba4b1453a162ad509b145`。

## 可核对证据

| 文件 | 内容 |
| --- | --- |
| [task.json](task.json) | 服务端任务、完整提问／回复与模型调用收据 |
| [peer-transcript.jsonl](peer-transcript.jsonl) | Grok 侧保存的 50 条请求／响应记录，Authorization 已脱敏 |
| [http.jsonl](http.jsonl) | 服务端协议请求审计，不含凭据或消息正文 |
| [peer-client.py](peer-client.py) | Grok 为本次测试自行编写的 HTTP 客户端，未修改；不含密钥 |
| [deliverable.md](deliverable.md) | EIGOS 返回、Grok 收到的完整交付物 |
| [verification.json](verification.json) | 逐字比对、调用次数、任务编号、时间与议程计算结果 |

议程区间为 0–8、8–20、20–35、35–45、45–65、65–80、80–90 分钟，连续无空档，总计 90 分钟；35–45 为唯一一次 10 分钟休息。交付物明确包含 12 位非技术主管、免费工具、虚构资料与人工审核限制。模型将项目代号中的「湾」转为繁体「灣」，这是字形变化，不是逐字保留标识符的保证。

两次模型调用分别有 CLI turn.completed 收据与 token usage；不是测试夹具或固定回复。第一轮约 14 秒，第二轮约 90 秒。另有一次事先的真实运行时健康验证，不属于此 A2A 任务；这里仅统计该任务内的两次调用。

## 证据范围

本次证明：真实 Grok Bot 能通过其电脑执行能力作为 A2A 调用方，与 EIGOS 的真实模型运行时完成一次澄清与文档交付。它没有证明 Grok Bot 产品内置了独立的原生 A2A 连接器，也没有使用或验证 Your dot。

本次没有 MCP 桥接，没有开放公网、改变网络权限或执行购买、发布。测试服务结束后关闭，临时客户端凭据移除。客户端使用 HTTP 脚本不等于模拟模型回复：实际问题由 EIGOS 模型产生，实际答复由 Grok 读取问题后组织，实际交付物由第二次 EIGOS 模型调用产生。

本次只验证文档规划服务。业务本体、确定性服务验收器、真实业务系统连接器与跨多次任务的稳定性仍待验证；模型 completed 状态不能替代这些验收。
