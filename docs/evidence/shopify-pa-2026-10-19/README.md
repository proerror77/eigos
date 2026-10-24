# Shopify 匿名商品查询：真实 PA 验收证据

2026-10-19，Grok Bot／Monk 使用已连接 Mac 上的既有 A2A 客户端，将原始自然语言目标提交到本机 EIGOS Gateway。Worker 调用真实 Codex 进行 Ontology 解释和规划，再匿名读取 Shopify 生产 Global Catalog 与 Purity Coffee 店铺。PA 读取最终 artifact 并报告商品及未知项。此证据证明该本机路径，不证明 Grok 原生 A2A 插件、对外部署、商家合作或真实购买。

| 检查 | 结果 |
| --- | --- |
| 成功 Task | `1ec26262-7d40-405a-bf26-6e1ea9923ffc` |
| Request ID | `a76e44cc-c5df-47bd-a8f9-b90849311f52` |
| 提交／完成 | 10:10:31 → 10:11:53，Asia/Shanghai |
| 任务与验收 | completed；accepted；完成目标 artifact |
| 真实模型 | 4 次 codex-exec：2 次解释、2 次规划，保留 thread ID／输出摘要 |
| 模型实际本体读取 | describe、CatalogRead query、catalogReadStatus evaluate、assess_conditions |
| 本体函数验证 | 按读取时刻复算 known 输出，其摘要与模型读取回执一致 |
| 成功尝试来源 | 8 次 HTTP 200；全部 anonymous；只含 search_catalog、get_product、discovery、lookup_catalog |
| 商品身份 | 3 个 Purity Coffee 变体，商家 ID／域名／变体 ID 精确匹配 |
| 商品观察 | FLOW、EASE、PROTECT 均为 2900 USD minor（29.00 USD），available=true |
| 未确认事实 | 库存数量、配送承诺、完整结果范围、商家合作信任 |
| 副作用 | 1 个 read Action；businessFacts=[]；授权预算为空；无购物车／结账／订单／付款 |
| PA 与独立回读 | PA artifact 内容与 MCP／持久数据库一致 |
| 内容摘要 | `4984451f0d390f437a979f91d55b8008672f9c78735b00ae717a33bc836aff57` |
| 构建摘要 | `eafcfe4b3c26757652cdb82be459d91094747ec30156aef4212ac0adfdac2399` |
| 历史与连接 | 原有 9 个任务及本轮 2 个失败任务未变；PA profile／凭据／客户端／安装技能未变 |

价格和可售属于 10:11 的历史观察，有效窗口结束于 10:16:05。观察器之后复算模型历史输出，不延长该有效期，也不重新访问供应方。

## 文件

- [verification.json](verification.json)：独立验收报告，包括真实模型回执、本体读取、函数输出、来源摘要、A2A trace、两个失败尝试和最终快照。
- [pa-artifact.json](pa-artifact.json)：PA 自己从最终 GetTask 回执提取并保存的 artifact；其文件 SHA 与验收记录一致。协议内容相同，不等同于不同序列化文件字节相同。
- [pa-ui-observation.json](pa-ui-observation.json)：原生 Grok Bot 界面可见终态回复的字段抄录，省略无关会话；不是原始截图或聊天导出。
- [source-files.json](source-files.json)：成功提交前冻结的运行源码摘要；观察器核对构建目录、当前源码及运行 releaseDigest。
- [历史自动验证输出摘要与文件哈希](../archive-cleanup-2026-10-22.json)：325 项测试、类型检查和构建通过。

## 失败记录与复现

首轮 `b33a7960-f808-4fb0-9e07-2eca81a83e95` 在全局商品簇没有返回所选商家变体时拒绝；其 4 次来源读取和失败状态保留。修复详情查询为精确变体及商家过滤后，第二轮 `f2b3a553-d948-4bda-88c1-e10dac28d7dd` 在高负载下的模型阶段失败，没有任何新的 Shopify 请求。其通用错误不能独立证明最终错误类别。成功第三轮新增 8 次查询，三次尝试累计 12 次匿名只读请求。

本地默认并行全量测试遇到时序和进程启动等待失败。领域测试的 tick 已改为同时等待任务调度时间；最终使用相同测试集合的串行命令通过全部 325 项：

```sh
node --import tsx --test --test-concurrency=1 tests/*.test.ts
npm run check
npm run build
git diff --check
```

独立观察器运行方式：

```sh
node --import tsx examples/verify-pa-shopify-e2e.ts --live --session-dir /absolute/private/session
```

它只读取 PA 已提交任务及已有来源响应，不提交、不调用模型、不访问 Shopify。原始 HTTP 响应、PA 完整收发文件、凭据和恢复备份继续保留在私有忽略目录；公开归档不含认证头或凭据。详细接入与边界见 [运行说明](../../shopify-pa-worker-2026-10-19.md)。

2026-10-22 归档整理：重复的自动检查原始输出已移出 Git 跟踪并保留本地副本；仓库保留摘要、原文件哈希和整理前提交。摘要不是原始逐项日志，也不代表本次重新运行了历史验证。
