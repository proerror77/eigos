# EIGOS 项目

当前架构见 [Ontology 架构](docs/architecture/ontology.md)，启动、协议与测试见 [README](README.md)。

- 语义定义集中在 `packages/ontology/`，运行层在 `packages/runtime/`。来源连接器在 `packages/capabilities/`。
- Gateway 和 Worker 连接同一个 PostgreSQL schema，按发布定义解释对象与操作。
- 当前业务范围为地点与车型估价，用户未授权真实下单或付款。
- 代码修改运行 `npm run check`、`npm run build`、`npm test`、构建后的 `npm run test:e2e:run` 和 `git diff --check`。已有有效结果可复用。
- 交付沿用全局规则，提交、推送任务分支并完成对应 PR 的 CI。部署按用户授权执行。
- 凭据、数据库、真实供应商响应和临时材料保存在仓库外或忽略目录。`dist/` 是生成物。
- 修改品牌内容时阅读 [品牌说明](docs/brand-brief.md)。
