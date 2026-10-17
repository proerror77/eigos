# Grok 按生活服务意图发现与转交：真实验收

2026-10-17（Asia/Shanghai）08:00–08:08，真实 Grok Bot／Monk 使用已连接 Mac 的 Shell 和 A2A 1.0 客户端，完成六类生活需求转交。发给 Grok 的需求没有提及 EIGOS；前提是已配置一次连接并在其技能库保存意图触发规则。

| 需求 | 实际任务编号 |
| --- | --- |
| 800 元以内降噪耳机 | `9d428c27-69c6-424b-81cc-a887042b85f2` |
| 杭州周末酒店两晚 | `f8cb8744-3272-4ca7-a581-38937477c672` |
| 上海至北京机票 | `5dde2024-02e8-4a16-a0c0-76c8c2ae7195` |
| 家至办公室送文件 | `a16f2fe9-a2d5-41e1-b427-dd71b97f9c46` |
| 两人晚餐外送 | `9d85a6e1-c737-4a92-b1dd-f13e6f71c76b` |
| 周末家政保洁 | `10ca3b8c-95e3-47bf-abf8-08a459a498d7` |

Grok 自行发现当前 Card、保存原始英文目标并调用客户端。六份客户端原始请求与回执已核对，任务原话没有改写。实际共有 9 次 SendMessage、6 个不同 messageId；前三个请求各重放一次，仍只有六条任务，没有重复登记。

所有任务保持标准 `TASK_STATE_SUBMITTED` 和应用状态 `waiting_provider`，`execution=not_started`、`businessCompleted=false`、`automaticExecution=false`。Monk 明确解释已收到需求、提供方尚未接入，不会自行下单或开始履约。服务端接收回执是确定性程序，不是 EIGOS 执行模型；本轮验证的是真实 PA 的意图识别、发现和转交。

## 独立回读

- [验证汇总](verification.json)：官方 MCP 客户端、独立 A2A GetTask 与 SQLite 回读一致；重启后再次验证六条原任务。
- [Grok 客户端回执](peer-responses.json)：六份实际返回值及原始响应文件摘要。
- [HTTP 轨迹](http.jsonl)：元数据审计，保留发现、提交与查询，不含认证头、凭据或消息正文。Grok 业务转交走 A2A；MCP 请求来自独立验收客户端。
- [知识问答反例](negative-verification.json)：询问酒店 check-in 含义并明确只解释，Grok 未转交；任务数仍为六。
- [自动恢复](restart-verification.json)：向受管启动器发送 SIGTERM 后，launchd 自动恢复服务；任务和回执保留。
- [实际技能回读](installed-skill.md)与[摘要](skill-readback.json)：从 Grok 的真实技能库导出到 Mac，SHA-256 与其报告一致，包含源码技能原文和已保存连接。不是仅在仓库放了一个未安装的技能文件。
- [源码摘要](source-sha256.json)：最终交付源码，便于区分后续修改。

本地类型检查、107 项全量测试、构建与差异检查通过；自动测试另覆盖中文六类目标、防重、停机恢复、补充、取消、scope、跨用户隔离及伪造完成拒绝。固定客户端测试与本次真实 Grok 验收分别记录。

## 环境修复与边界

Grok 的 Mac Shell 读取 Documents 下文件曾挂起；迁移客户端、profile、输入文件和技能安装文件到 `~/.local/share/eigos/grok-life/` 后，实际 discover 约半秒返回。服务也在该目录以独立构建快照常驻，不修改系统隐私权限、原 `.env`、Auth0、CSV profile 或个人跑腿授权。

Monk 另报告其 STE 风格检查有 9 项错误；本轮按原文保存技能，没有将该风格检查标称通过。实际意图触发和调用已通过。

这证明已配置的 Monk 后续无需点名 EIGOS 即可转交生活需求；不证明陌生 PA 无配置自动发现、任意新账号兼容、Grok 原生内置 A2A、生产会员接入或公网发布。当前为本人 Mac 上的 loopback 开发身份；运行仍依赖 Mac 在线和 Grok 的电脑连接。

真实订单、酒店／航班预订、付款和提供方履约均为零；未启用任何供应商执行。任务记录不代表已接单或已完成服务。原始截图、临时运行输出和凭据保留在忽略目录，未提交。
