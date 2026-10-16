# Grok Bot → EIGOS A2A＋Ontology/OAG：CSV 审计实测

2026-10-15，上海时间。两次真实委托均完成，模型判断、业务执行和独立验收均有记录。

## 结果

| 场景 | taskId | 实际结果 |
| --- | --- | --- |
| 首次委托，故意不先提供文件名 | `f98354c7-1ca1-4738-aa7d-1feadad5b757` | 20:05:51 接收 → 模型补问文件名 → Grok 回复 → 计划／报价 → 独立授权 API → 20:06:35 验收通过 |
| 后续独立委托，仅提供用户目标和文件名 | `0eadbc33-213a-4fed-829f-9a410a9a3b5a` | 20:08:33 接收 → 使用已保存的连接 → 无需补问 → 计划／报价 → 授权 → 验收通过 |

第一次有两次、第二次有一次真实 Codex 协调模型调用，各自具备 `codex-exec`、threadId、usage 与输出摘要收据。协调模型读取 `eigos-csv-ontology-v1` 并提出结构化决策；它没有直接执行审计，也没有自行批准计划。

执行和验收使用实际原始 CSV 字节，输入为本次构造的 6 条合成记录，非真实客户数据。独立验收查出：第 5 条缺邮箱；第 2／4 条 ID 重复；第 3 条邮箱和金额非法；第 4 条日期非法。两份客户端 JSON／Markdown 均与对应服务端交付物逐字一致。

每个任务恰有一笔本地模拟付款记录，无真钱。任务的授权、文件哈希、计划摘要与验收结果都能在服务端任务快照中核对。未使用 `/mcp`；业务交互采用 A2A 1.0，授权采用文档化的独立 EIGOS HTTP 接口。

## 可复用配置证据

Grok Bot（Monk）先读取项目内的技能文件，在其云电脑技能库保存到 `/home/box/agent-data/workflows/eigos-delegate/SKILL.md`。技能保存实际运行电脑为用户 Mac，以及脚本／profile 的绝对路径；凭据仅由本地客户端读取。

[installed-skill.md](run1/installed-skill.md) 是 Grok 从其技能库回读的内容。SHA-256：`3df1adf620f392635ddbaab623313de37b79100189bb9a1afc82a73657372acc`。

第二次请求没有再次提供地址、认证引用或调用步骤，Grok 使用同一连接创建新的 taskId 并收到结果。这验证了当前 Monk 的后续独立请求复用；没有声称验证了 Grok 重装、不同账号或全新 Bot 的自动发现。

## 文件

- [verification.json](verification.json)：两次结果、哈希、模型调用数、防重复付款与凭据扫描检查。
- [agent-card.json](agent-card.json)：实测 Card 的规范 JSON。
- [input.csv](input.csv)：合成数据原文件。
- [http-audit.jsonl](http-audit.jsonl)：请求路径、方法、任务／消息标识；不含凭据或正文。
- [run1/server-task.json](run1/server-task.json)、[run2/server-task.json](run2/server-task.json)：完整任务、计划、业务事件、授权、验收与模型收据。
- run1／run2 中的客户端输入输出与原样报告：[第一次报告](run1/report.md)、[第二次报告](run2/report.md)。
- [source-sha256.json](source-sha256.json)：归档时源码摘要，便于区分后续改动。

首次客户端补问回复出现一次未提供 taskId 命令参数的错误，被 argparse 本地拒绝，未发出请求。Grok 纠正后在原任务上续接；失败输出保留在 run1 中。技能回读时产生的用户主目录重复 SKILL.md 经内容摘要匹配后已清理，正式技能与审计副本保留。

## 验证范围

这不是模型替身或预置问答；真实 Grok 读取补问并组织回复，真实协调模型判断能力与缺失信息。审计 producer 和独立 verifier 是确定性程序。自动测试另外覆盖不支持目标、越界动作、计划／输入篡改、授权摘要、防重、补交／模拟退款、阻塞等待和跨 MCP／A2A 读回，当前全套 64 项通过。

不代表 Grok 原生内置 Agent Card 连接器、任意业务已接通、真实支付或生产部署已验证。当前是已连接 Mac 上的 loopback 服务；公网需要 HTTPS 与真实身份／令牌刷新流程。配置可复用不等于服务自动启动。运行与恢复见 [CSV 本体闭环说明](../../csv-ontology-delegation.md)。

归档后最终检查修正了待授权状态下重放原补问回复的幂等边界，已用回归测试验证，64 项测试再次全部通过。source-sha256.json 保留实际联调时的源码摘要；该重试修正不改变上面两次成功路径的交付物。
