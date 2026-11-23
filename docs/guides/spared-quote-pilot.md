# spared 合成报价试点

本地试点使用一个已发布的 Ontology Function 读取指定 owner 的合成报价。EIGOS 持有 fixture 并按已有 Function、来源和对象权限访问。Function 仅把标签和金额文本发给 loopback 上的 spared。Rust 插件去除包装字符并把 CNY 金额精确转成分，拒绝区间和近似金额。在每个 app 的 SQLite 里保存最近一组输入和结果。已有来源投影在 PostgreSQL 保存合成报价及其关联的 `SourceReceipt`，并保留 fixture 原始字段的摘要。报价使用 `synthetic`，回执沿用现有的 `fixture` 枚举。报价没有预订入口。

## 本地验收

需要 Node、Docker 和 rustup。构建脚本固定了 spared、WASI SDK 和 Rust 版本。仓库 CI 在套件 41 运行这条路径。

```sh
scripts/prepare-spared-quote-pilot.sh artifacts/spared-quote
EIGOS_TEST_SPARED_BIN="$PWD/artifacts/spared-quote/spared" \
EIGOS_TEST_SPARED_WASM="$PWD/artifacts/spared-quote/quote.wasm" \
npm test -- --suite=41
```

套件启动自己的 spared、Gateway 和 PostgreSQL 测试环境，发布附加了试点定义的 Ontology。两个 owner 使用相同的报价 ID、不同的 fixture 和独立的 spared app。套件经过已有来源读取和投影入口写入，再通过 Gateway 查询报价及关联回执。它还检查重试、撤权、停机和重启。

## 接入边界

试点定义由 `withSparedQuotePilot` 显式加入本地发布，标记为 sandbox。扩展模块由 `EIGOS_EXTENSION_MODULE` 指定，指向构建产物下的 `packages/capabilities/spared-quote/extension.js`。用 `EIGOS_SPARED_QUOTE_CONFIG_FILE` 指定本机 fixture 文件的绝对路径。配置含 `port`、`wasmSha256` 和 `owners`，每个 owner 的 `quotes` 按报价 ID 记录 `quote`（`label` 与 `price`）和 `observedAt`。两份可运行的示例配置在套件 41。

Function 版本通过 `implementationId` 绑定完整 Wasm SHA-256，app 名由摘要和认证 owner 派生。部署步骤在管理面核对 spared 返回的组件摘要。版本变化时创建新的 app，并发布新的 Function 版本。旧发布仍有任务使用时保留原实现和实例。业务进程只访问数据端口。插件 manifest 仅授予 app 自己的数据目录访问。上游预览版的隔离范围见 [spared Isolation](https://github.com/michaelmagan/spared/blob/v0.0.1-preview/docs/isolation.md)。

Function 版本和来源投影沿用 [Foundry Function versioning](https://www.palantir.com/docs/foundry/functions/functions-versioning) 与 [Object Data Funnel](https://www.palantir.com/docs/foundry/object-backend/overview) 的职责边界。
