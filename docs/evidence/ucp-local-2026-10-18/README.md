# UCP 官方本地商家验证证据

2026-10-18。范围为用户明确选择的官方本地测试商家；实现与重跑方式见 [接入说明](../../ucp-local-integration-2026-10-18.md)。代码起点 `70aaa12337db1257221977616fe629bb694bb9f2`；本轮为 ontology-execution-v7／eigos.business@5。

- 最终真实模型：准备 4 次模型调用／5 次本体读取；确认 5 次／7 次。两项参数、独立验收、A2A／MCP 交付物一致；确认模型实际调用 checkoutReadiness。
- 独立商家数据库：新增 1 个 checkout、1 个模拟 order，库存减少 2 件；账本、HTTP、商家防重键一致。未签名读取返回 401。
- 本地自动检查：304 项测试、类型检查、构建、7 项进程 E2E 及差异格式检查通过。

| 文件 | 内容 |
| --- | --- |
| [verification.json](verification.json) | 最终摘要、源码摘要、官方提交及明确未完成项 |
| [model-first-failure.json](model-first-failure.json) | 首轮结构化 USD 预算被重复提取后拒绝的真实记录；确认阶段未派发业务动作 |
| [model-intermediate.json](model-intermediate.json) | 预算修复后的两阶段成功；该中间轮未记录完整源码摘要，不作为最终版本证据 |
| [model-final.json](model-final.json) | 最终版本两阶段任务、固定计划、许可、模型输出／回执、本体读取、交付物及验收 |
| [merchant-readback.json](merchant-readback.json) | 直接读取独立商家数据库的计数、原订单关联、准确商品／金额、地址匹配及操作键核对 |
| [reference-uv.lock](reference-uv.lock) | 官方 Python 商家的测试环境依赖锁；非 EIGOS 生产依赖 |
| [类型检查](typecheck.log)、[测试](tests.tap)、[构建](build.log)、[进程 E2E](process-e2e.tap) | 最终自动验证 |

模型报告保留结构化输出，不记录内部推理。原始读回保留于忽略目录，归档记录其文件 SHA-256；公开报告省去重复任务历史、候选私有数据和测试街道地址，没有私钥、访问令牌或模拟支付 token。最终 26 个源码摘要均已核对。官方业务源码未修改；启动器只设置 loopback、测试数据和强制签名。

真实的是模型、标准 HTTP 请求、签名验证、独立商家进程和数据库读回。业务是官方样例的本地模拟；不能称为真实商家交易、支付到账或实际配送。没有实际用户 PA、生产 Shopify／AHA 连接或常驻部署。仓库提交与对应 CI 的状态在交付时另行回读。
