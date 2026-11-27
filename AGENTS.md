# EIGOS 项目

按任务查阅：架构与设计依据见 [Ontology 架构](docs/architecture/ontology.md)，启动与协议入口见 [README](README.md)，各专题的协议与边界见 `docs/guides/` 下的对应指南。修改品牌内容时阅读 [品牌说明](docs/brand-brief.md)。

## 架构

- 语义定义集中在 `packages/ontology/`，运行层在 `packages/runtime/`，来源连接器在 `packages/capabilities/`。Gateway、Worker 和 Indexer 共用同一个 PostgreSQL schema，按发布定义解释对象与操作；供应商的业务步骤写在连接器和已发布的 Function、Action 里。
- 改变 Ontology、Interface、Action、Machinery、Scenario、动态排程或自动化的语义或契约前，先读架构文档的对应小节和它引用的 Palantir 官方文档，再映射到现有实现。EIGOS 按 Palantir 的同名概念实现这些语义，所以在 PR 描述里写明依据链接和实现边界。不改变语义或契约的修复不需要重新查阅。
- 复用发布模型、调用契约、权限和 Action 执行，不新增平行引擎或领域专用运行协议。单项能力直接调用 Function 或 Action；跨服务依赖由 Agent 或已发布逻辑协调，有时间或资源取舍时用排程，需要比较或审阅拟议编辑时才用 Scenario。

## 授权边界

- 开发与验收默认只做只读的真实查询和 `synthetic` 执行（合成供应商、本机测试商家），这两类不需要逐次确认。会在供应商或用户账户产生真实变更的调用需要用户对该次任务的明确授权，包括预订或订座、报名、下单或叫车、付款、取消或退改、写入外部日历；供应商沙箱或测试账户（例如 Stripe 沙箱）里的写入也一样。连接器配置、具体业务授权和供应商履约分别验证。
- 合并、发布镜像（Release images）和部署各自需要用户授权，创建 PR 不包含这些授权。
- 凭据、数据库、真实供应商响应和临时材料保存在仓库外或忽略目录。`dist/` 是生成物。

## 验证与交付

- 修改或排查代码时，先运行能验证当前改动的检查。例如，用 `npm test -- --suite=NN` 运行受影响的套件。修复失败后先复跑该检查，影响范围扩大时再扩大验证范围。
- 代码改动交付前，确认最终提交内容通过完整验证：`npm run check`、`npm run build`、`npm run ontology:check`、`npm test`、构建后的 `npm run test:e2e:run` 和 `git diff --check`。可复用同一提交内容上已通过的本地或 CI 结果，补跑缺项或输入已变化的检查。
- 本机有并行会话：只停止或删除自己创建的容器和进程。测试脚本会自行清理它的 `eigos-test-<uuid>` 容器。
- 交付：从最新的 `origin/main` 开任务分支，提交并推送，创建或更新 PR，跟到必需检查 `CI result` 通过。分支、worktree 与提交的细则沿用全局规则。
- 解决合并冲突时让每个 PR 的功能都保持可用：把功能迁到当前结构，而不是关闭或降级它。
