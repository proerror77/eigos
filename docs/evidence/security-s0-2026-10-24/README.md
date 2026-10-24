# 权限 S0 验证记录

2026-10-24，Asia/Shanghai。源码起点 `6abdb13`；实现说明见 [S0 文档](../../security-s0.md)。

[summary.json](summary.json) 归档模型／字段／出口计数及本机任务库、会员库离线副本的迁移分类汇总。实际 SQLite 副本、完整逐记录报告与临时测试输出在忽略目录，不随提交发布。

源数据库通过只读连接备份，审计只打开副本；两库分别备份，不声称跨库原子性。快照审计前后 SHA-256 一致。没有创建授权、写入生产数据库、调用来源或更新常驻进程。

历史合同／摘要不匹配项须按历史版本处理；直接关联候选仍需来源证据复核。本记录只证明 S0 完成，`migrationReady=false` 与 `enforcement=not_installed` 均是预期状态。

本地 `npm run check`、`npm run build`、`git diff --check` 通过；`npm test` 为 601 项通过，`npm run test:e2e:run` 为 8 项通过。S0 新增 8 项已包含在全量测试中；清单移至独立目录并补上清单摘要后，这 8 项另行复跑通过。`npm run security:s0 -- --check` 通过。

远端 CI 以本次同步提交对应的 GitHub Actions 终态为准，不用本地测试替代远端结论。此阶段没有部署。
