# CSV 审计已统一到 Ontology 后端

原独立 CSV pilot 入口、模拟账本和启动命令已退役。当前 PA 通过 `eigos.delegate` 请求完整 CSV 审计，由 `data.quality.audit.simulated@2` 能力执行；读取、报告生产和独立验收程序位于 packages/capabilities/csv/。

配置 `EIGOS_CSV_PILOT=true` 与绝对路径 `EIGOS_CSV_INPUT_DIR` 只启用这一新架构能力，不选择旧运行模式。它仍只允许本人 loopback 开发身份，完整五项审计，拒绝子集或重复检查。模拟报价经独立授权 API 确认，不移动真实资金。

历史试点证据保留其原记录，不作为当前入口说明。当前契约见 [注册能力](registered-capabilities.md) 和 [接入指南](integration.md)。
