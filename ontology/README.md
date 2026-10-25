# 独立维护的 MCP 读取定义

本目录是当前供应商 MCP 工具绑定和证据依赖的维护来源，不在 Worker 模型提示或适配器中编排业务调用顺序。完整边界见 [统一接入说明](../docs/mcp-ontology-unification.md)。

| 定义文件 | 已授权的读取 |
| --- | --- |
| `didi-order-test.json` | 固定官方 Mock 下单测试的地点、估价、原订单回查依赖；创建动作另需精确测试许可 |
| `didi-readonly.json` | 滴滴地点搜索、车型估价 |
| `meituan-readonly.json` | 公开地点、本人地址簿、已选地址详情、费用预览 |
| `shopify-catalog.json` | 公共／商家商品目录；HTTP 发现为单独声明的前置原语 |

本体声明每个动作对应的 server／tool／transport，参数来自任务输入、受信配置还是已选来源对象，所需观察与评估函数，以及结果路线关联。支持有界 JSON 对象、数组、常量及枚举查表，无动态代码。模型通过 `describe_ontology` 读取这些内容，自行选择动作、来源、并行方式和完成时机。`requires` 是证据前提，解释器不会自动运行其中的动作。默认要求模型实际读取并评估来源；声明为 `accepted` 的依赖仍须经过主机的当前来源验证，可供模型在同一依赖图中使用前一步实际产生的引用。

执行器仅解释已选择动作。当前仍由 TypeScript 维护领域数据类型、来源验证函数、凭据、网络端点和只读权限。修改定义不能授权新工具或打开下单、取消、付款；新增领域数据契约或授权范围仍需要实现与审核。

v20 的可选只读数据流允许依赖声明 `derive={function,path}`。模型可以显式选择这个纯函数绑定，并自行选择所引用的上游步骤；Worker 仅在真实输出已接受后求值。模块 `completion.planned=true` 允许模型预先选择未来证据的验收绑定，宿主仍执行新的来源读取、状态函数和原有独立验收。unknown 返回新决策机会。当前只在滴滴模块启用；完整合同与证据归属见[只读依赖图说明](../docs/ontology-read-dataflow-2026-10-24.md)。

## 修改与装载

首次安装照常运行 `npm run build`。后续只修改绑定、参数来源或依赖时：

1. 编辑 JSON，语义变化递增 `version`。
2. 运行 `npm run ontology:check`，再运行 `npm run ontology:sync`。这两步使用既有解释器，不重新编译 Worker。
3. 本机管理实例运行 `npm run setup:pa`；它在停止旧服务前核对源文件与同步副本，将定义与代码一起存入不可变运行快照，再重新加载 Gateway／Worker。

没有中途热替换。模块 id、version 和内容摘要进入本体动作及执行配置摘要；已固定计划不能悄悄采用新映射。JSON 缺失、循环依赖、无法解析的参数来源、任意代码、凭据或端点字段均拒绝。`npm run build` 自动完成同步；Docker 镜像也包含同一份定义。

## 可观测性

发现结果的 `action.read.mcp` 展示实际绑定和依赖，`action.read.module` 展示版本、摘要和完成评估函数。模型决策、模型实际本体读取回执、计划、Intent、Attempt、供应商回执和本体观察继续绑定同一任务 revision。只有读取并评估所需来源后，才能发送估价；最终结果仍由独立验收核对。


v23 增加 `externalResults` 声明已注册沙箱操作的输出依赖；它本身不定义或授权操作。仅明确声明 `completion.afterAuthorizedOperation=true` 的回查可在模型选择的图中跟随一个沙箱写动作，绑定其实际返回对象后执行条件验收。没有许可不能写，没有独立回查不能完成；生产写操作不适用。见[滴滴测试说明](../docs/didi-order-test.md)。
