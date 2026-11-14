# EIGOS 项目

当前架构见 [Ontology 架构](docs/architecture/ontology.md)，启动、协议与测试见 [README](README.md)。

- 语义定义集中在 `packages/ontology/`，运行层在 `packages/runtime/`。来源连接器在 `packages/capabilities/`。
- 设计或修改 Ontology、Interface、Action、Machinery、Scenario、动态排程与自动化前，先查阅对应的 Palantir 官方文档，再映射到现有实现；在变更说明中记录依据与实现边界。复用发布模型、调用契约、权限和 Action 执行，不新增平行引擎或领域专用运行协议。简单能力直接执行，组合、排程与 Scenario 按需要使用。
- Gateway 和 Worker 连接同一个 PostgreSQL schema，按发布定义解释对象与操作。
- 业务模型包括地点与车型估价、服务查询、PA 日历 Scenario，以及报名和定时出行的授权执行链。连接器配置、具体业务授权和供应商履约分别验证；开发验收默认仅真实查询与 synthetic 执行，不授权外部日历写入、真实报名、下单或付款。
- 代码修改运行 `npm run check`、`npm run build`、`npm test`、构建后的 `npm run test:e2e:run` 和 `git diff --check`。已有有效结果可复用。
- 交付沿用全局规则，提交、推送任务分支并完成对应 PR 的 CI。部署按用户授权执行。
- 凭据、数据库、真实供应商响应和临时材料保存在仓库外或忽略目录。`dist/` 是生成物。
- 修改品牌内容时阅读 [品牌说明](docs/brand-brief.md)。
