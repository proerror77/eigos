# 架构验证证据

所有业务主体、来源回执与业务副作用均为隔离合成数据。没有真实下单、付款、预约或常驻部署。

- `baseline-review.json`：基线 commit/model、18 个有效案例、7 项夹具校准及逐题两轴判断。
- `baseline-answers.json`：25 次原始尝试及是否计入有效基线；修正后答案不覆盖旧答案。
- `baseline-read-receipts.json`：260 条读取调用，保留输入、对象/关系版本与输出摘要；完整重复 schema 和私有源载荷不归档。
- `baseline-source-manifest.json`：首次架构修改之前的提交和来源文件摘要。
- `retest-review.json`、`retest-answers.json`、`retest-read-receipts.json`：24 个业务问题、30 次复测答案及 349 条读取凭据。S02 答案覆盖仍为部分，未知回答不证明业务能力已贯通。
- `schema-audit.json`：六类服务参数、共享 Data Schema、类型变化与冻结迁移覆盖；类型数量不作为业务完成指标。
- `metadata-performance-check.json`、`aborted-load-run.json`：静态元数据耗时诊断、单次前后对照和未计为通过的中止运行。
- `verification-local.json`：源码摘要、完整本地检查的两个失败、修复后定向回归、Worker 独立复查及 9/9 E2E；远端完整门禁必须以同一提交的 GitHub Checks 为准。
- `ci-migration-repair.json`：首轮 CI 的 835/836、确定性迁移竞争复现、事务边界修复与重新验证；原失败不计作通过。

完整原始查询日志保留在本地忽略目录，文件摘要和字节数写入基线审计。宿主访问令牌、成员凭据和原始源快照不进入证据目录。结果解释见 [架构验证记录](../../ontology-architecture-completion-2026-10-21.md)。

人工非建模者演练尚未进行；新上下文 Agent 演练不能代替该项。
