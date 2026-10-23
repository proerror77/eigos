# Grok → EIGOS → 原生 Ontology MCP 当次验收

2026-10-23 的新任务 `4605b6ed-27df-4a79-ad4f-881fcb0087ee` 已完成并通过验收。Grok Bot 桌面版使用原生 MCP 创建任务，用 A2A 补充同一任务，再通过两种协议读回相同文档。证据来自此次主实例运行，没有复用旧实例或内部演练的成功记录。

## 实际部署

| 部件 | 位置与关系 |
| --- | --- |
| 主入口 | `https://eigos.mandonothing.com`；原生 MCP 为 `/mcp`，A2A 为 `/a2a` |
| Gateway 与 EIGOS Agent | 当前 Mac 的 `invite-beta` 服务；Gateway 和 Worker 是两个进程，使用同一不可变发布和 `tasks.sqlite`；Worker 承载 Agent 执行循环 |
| 模型运行 | Worker 启动实际 `codex-exec` 会话；模型推理使用已配置的服务 |
| Ontology MCP | Worker 为每个决策会话启动独立的 loopback Streamable HTTP MCP；模型通过原生客户端调用当前任务的本体工具 |
| 对外认证 | Grok 原生 MCP 的 Auth0 PKCE 授权；A2A 的 AgentConnector 设备授权及轮换刷新；两者能够访问同一归属任务 |
| 发布 | 代码提交 `69d5ed23466d04c0a98c5015a1b2bc9db388dde6`；运行契约 `ontology-execution-v18` |
| 发布摘要 | `55f2f8b5284f316ad7b9b013de8a029f378a032db88b990a82ea577a5a032a02`；部署文件、工作区构建和公开健康信息一致 |

Ontology MCP 的任务专属地址不作为 PA 公网入口。Grok 调用 Gateway 的 MCP/A2A，EIGOS 模型调用 Worker 提供的 Ontology MCP。两层的调用证据分别保留。

## 同一个 taskId 的全过程

所有时间为北京时间（UTC+8），日期均为 2026-10-23。

| 时间 | 当前链路观察 |
| --- | --- |
| 13:16:15 | Grok 原生 MCP `submit_task` 创建上述新任务；幂等 requestId 只对应一个服务端任务 |
| 13:16:51 | Agent 请求会议时长，任务进入 `input-required` |
| 13:17:16 | Grok 的 A2A `GetTask` 读到相同 taskId、contextId 和 revision 1 |
| 13:17:30 | A2A `SendMessage` 携带 `expectedRevision=1` 补充总时长 45 分钟、三个主题各 15 分钟；原任务升至 revision 2 |
| 13:20:16 | Worker 完成文档，独立验收 `accepted=true`，任务 `completed`，阶段 `accepted` |
| 13:20:30 | Grok 保存原生 MCP 最终回执；其长轮询请求到达时间为 13:20:06 |
| 13:20:48 | Grok 的 A2A 再次读取同一 completed 任务并保存结果 |

HTTP 审计的 `at` 是请求到达时间。`get_task` 支持最长 30 秒等待，所以 13:20:06 的请求可以返回 13:20:16 完成的任务；不能把该时间当成响应完成时间。

Worker 记录了 **6 次真实模型运行**。其中 **5 次决策会话、27 条原生 MCP 客户端事件、22 条成功的本体读取回执**，均关联上述 taskId。每次决策都有客户端实际完成的 `submit_decision`，读取摘要与持久本体记录相符。另一次模型运行负责生成文档，不附带工具。

服务端制品、MCP 响应、A2A 响应、Grok 保存的两份 Markdown 文件，原始 UTF-8 字节 SHA-256 全部相同：

```text
6e4e2ad075fd2009d6580a85a7e55aabe569cc453fbbdd4cc53b7dee9c92a696
```

交付物为 [《青禾联调验收》会议议程](document.md)，共 2440 字节，含三段各 15 分钟的议程、准备材料与结束检查清单。额外的操作端 A2A 回读也得到同样结果；它单独记录，不代替 Grok 的上述验收。

## 证据与验证

- [verification.json](verification.json)：发布、任务、认证、摘要比较和运行边界。
- [protocol-readbacks.json](protocol-readbacks.json)：两种协议的当次提交、补问、回复与最终验收字段；排除了会员累计用量。
- [native-ontology-runs.json](native-ontology-runs.json)：当前任务的实际客户端工具事件、会话绑定与读取摘要；没有原始模型推理或令牌。
- [http-audit.jsonl](http-audit.jsonl)：仅包含此 taskId／requestId 在本次 Grok 验收期间的服务端审计。

本地类型检查、构建、针对原生 MCP 的 48 项检查、修复回归的 21 项检查、条件解释的 41 项检查以及 9 项进程端到端检查通过。较早一次完整本地测试为 986 通过、3 项旧断言失败；已修复并重新验证这三项。最终完整套件以本目录所在交付提交的 GitHub Actions CI 为准，不把较早失败运行标作全绿。

后续 CI 中，并行测试超过了整体 10 秒时限，MCP 测试在密集轮询时连接中断。并行断言改为从真实请求开始计时，保留慢分支未释放时下游须继续的检查；MCP 测试使用正式的有界等待接口。相关 7 项回归、类型检查和构建通过。这些调整仅涉及测试，已验收部署的业务代码和发布摘要保持一致。

## 旧实例与边界

已备份并停用空闲的 `member-network`（3210）和旧单进程入口（3000）；3210 的自动启动也已停用。数据库与恢复配置保留在本机私有备份目录。`grok-life`（3430）仍有另一项并发开发和非终态任务，因此保留为独立开发实例；`commerce-sandbox` 是供应商沙盒，也保留。Grok 的主技能和 A2A 配置已指向上述 HTTPS 实例。

这次证明的是实际文档服务的完整执行，输入为合成测试资料。主实例公开能力为 `brief.prepare` 和 `document.compose`；未把其他开发实例的滴滴或美团能力宣称为已迁入主实例。本次没有安排真实会议、对外发送、下单、叫车或付款。

服务仍部署在当前 Mac，通过既有 Cloudflare Tunnel 对外提供 HTTPS；Mac 关机或服务停止会使入口不可用。部署统一不等于已迁到独立云服务器。
