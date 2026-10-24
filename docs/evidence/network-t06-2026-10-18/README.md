# T06 身份与发布权限：工程验证

2026-10-18。基础提交 `204cfee`；本记录随 T06 实现提交。开发目录为独立 worktree，原目录 N2 在途源码保持不变。未部署、未修改实际身份平台权限或常驻配置，未执行现实交易。

## 验证结果

- TypeScript 检查通过。
- 全量常规/集成测试 256 项通过；在 N1 的 235 项之上新增 21 项 T06 用例。
- 构建通过。
- 8 项进程 E2E 通过，包括新增的离线会员 CLI 撤销持久 fence 测试。
- 会员页导航补充后，最近相关会员与网络 HTTP/MCP 测试重新执行；最终远端 CI 以本提交 SHA 为准。
- 文档引用/空白检查及 git diff --check 通过。

以上为本地工程证据；远端 CI 完成链接在交付回读中给出，不以基础提交的 CI 替代当前提交。

## 可否证结果

| 场景 | 观察结果 |
| --- | --- |
| 同 owner 另一安装冒用 profile | ACTOR_NOT_BOUND；原同 owner Task 读回仍可用 |
| tasks:write 或 bearer 直接批准 | 无法替代会员会话、同源与 CSRF |
| 改稿/改批准摘要/使用他人审批 | REVIEW_STALE 或 NOT_FOUND；没有 grant |
| 两个 HTTP 请求同时消费同一许可 | 一个提交成功，另一个冲突；一份 publication |
| 事件写入故障 | publication、grant 消耗和命令回执整体回滚；原键可重试 |
| 发布后撤销再重放 | 接收者无法读取；原命令只回读不可用引用，不回放正文 |
| 接收者不在批准集合/成员停用 | 无访问权；新增/其他成员不扩大旧受众 |
| 同键不同内容 | IDEMPOTENCY_CONFLICT |
| member/client/installation 停用 | 写入持久 deny fence；恢复会员/client 状态不恢复网络许可 |
| 会员库停用写入失败 | 第一阶段 fence 仍在，继续拒绝网络操作 |
| 另一 Gateway 获取活跃网络租约 | NETWORK_GATEWAY_ALREADY_ACTIVE |
| 草稿查询改数据/伪造游标 | CURSOR_STALE；查询按数量与字节有界 |
| 未知/未准入接收者 | 相同 INVALID_AUDIENCE，不泄露会员存在性 |
| 控制页面含脚本样式内容 | HTML 转义，准确展示受众与期限，无可执行注入 |
| 网络默认关闭 | 不广告网络 MCP 工具/scopes，HTTP 拒绝；无隐式身份/业务权限扩张 |
| 离线 CLI suspend → approve | 会员可恢复 active，网络仍保持拒绝；跨进程持久有效 |

## 证据入口

- [权限、事务与恢复](../../../tests/network-permissions.test.ts)
- [本地 HTTP/MCP/控制会话](../../../tests/network-gateway.test.ts)
- [跨进程 CLI 撤销](../../../tests/e2e/network-lifecycle.test.ts)
- [实现与范围](../../network-t06.md)

这些测试使用生成的本地签名密钥、合成账号与数据，不是实际 Auth0 用户授权、生产浏览器会话、商家交易或长期多用户运行证据。没有运行真实模型业务，也没有将旧 PA 实测算作本功能验收。

## N2 并行工作

核对到原聊天“建立阶段目标并开始修正”仍在执行 N2：对象查询/条件接入规划，并运行隔离独立 Agent 演练。T06 不复制在途 planning-session/reasoning-loop/conditions，不更改业务本体版本和规划快照；共同文件只在独立分支增加最小 Gateway/JobStore 接缝。
