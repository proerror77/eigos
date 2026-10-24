# S1 验证记录

2026-10-24，Asia/Shanghai。以 `d83feb5` 为源码起点，在独立的 `codex/ontology-security-s1` 工作分支实施。说明见 [S1 身份与撤销控制面](../../security-s1.md)，机器摘要见 [summary.json](summary.json)。

本地 `npm run check`、`npm test`（635 项）、`npm run build`、`npm run test:e2e:run`（9 项）、`npm run security:s0 -- --check`、`git diff --check` 全部通过。其中 S1 专项 15 项已包含在全量测试中，CLI 跨进程 E2E 已包含在 9 项进程测试中。

补全持久 mode 缺表检查后，安全／会员／网关／Worker 的 56 项相关回归及 9 项进程 E2E 再次通过，其余未受影响的测试证据沿用。

专项证据来自隔离的 SQLite、合成会员／Agent 安装、显式测试 verifier、实际 HTTP 请求和编译后的会员 CLI。既有 JWT／OIDC 与默认 legacy 业务回归同时运行；没有调用真实身份提供方、供应商、付款或常驻部署。

重点验证了：同 client 的安装区分；禁止 Bearer 自授 grant；会话、Origin 与 CSRF；跨会员／字段越界；双库失败时持久拒绝；旧恢复请求不能覆盖新撤销；资格源不可用／lease 到期／配置缺失时拒绝；唯一发布者；父子授权和请求／输入版本；在途 Worker 中止；迟到事实只入审计；CLI 省略 mode 仍遵守数据库的 foundation 模式。

原始测试输出保留在忽略目录 `output/security-s1/`。测试数据库由 fixture 清理；没有用户凭据或业务数据进入本归档。远端 CI 以对应提交的 GitHub Actions 终态回读为准，不用本地通过代替远端成功。

S1 的 foundation 业务接口保持关闭，默认 legacy 不宣称具有 S2–S4 的细粒度权限。此次没有生产迁移或部署。
