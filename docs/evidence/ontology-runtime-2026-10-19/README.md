# Ontology 真实后端运行核验

本次由 Codex 诊断客户端通过已认证 MCP 提交只读业务目标，使用正在运行的 EIGOS Gateway／Worker、真实 Codex 模型和 Shopify 店铺接口。它核验 **诊断客户端 → EIGOS Agent → Ontology＋LLM → Shopify → 本体观察 → EIGOS Agent 验收 → MCP 读回**。用户 PA 发起的完整往返已在随后[单独核验并归档](../agent-catalog-pa-2026-10-19/README.md)，不以本诊断记录替代。

## 结果

修复后的任务 `1e2268bb-e836-4ee1-bcd3-1c01cb339e2a` 完成并通过独立读回：6 次真实模型调用、8 次本体读取／计算、1 轮模型动作计划和 2 次匿名厂商请求。

模型先查询定义和本任务范围，再选择 `DiscoverMerchantCatalog → ReadMerchantVariants`，把第一步实际产生的端点引用传入第二步。请求者已经给出了变体 ID，因此模型省略了搜索和详情查询。两次请求均有模型决策、动作、尝试及 HTTP 回执绑定，没有准备阶段的隐式厂商调用。

结果写为 `CatalogEndpoint` 和 `CatalogObservation`。模型随后读取观察并执行 `catalogObservationStatus`；独立观察器按实际读取时刻重算结果，确认 `known` 与原输出摘要一致。完成决策、任务 artifact、MCP 读回及数据库记录一致。

## 实际发现并修复的字段问题

首轮任务 `74a89106-9b2d-4440-ba27-75adde059e89` 的本体读取、动作派发、来源投影和完成判定确实运行，但归一化器用商家变体的 option title 覆盖了商品名：

| 信息 | 原始来源／原结果 |
| --- | --- |
| Shopify 商品名 | FLOW: Original Medium Roast Whole Bean Coffee |
| Shopify 变体标签 | 12 oz / Whole Bean |
| 首轮交付 title | 12 oz / Whole Bean |
| 修复后交付 title | FLOW: Original Medium Roast Whole Bean Coffee — 12 oz / Whole Bean |

首轮任务虽然被运行时标记 accepted，独立语义核验仍判为失败，见 [修复前记录](verification-before-fix.json)。这说明状态与摘要校验不能替代字段业务含义的检查。

修复保留商品名及不同的变体标签，并提升内部映射配置版本以拒绝续接不一致的旧绑定；本体对象结构、外部任务协议及历史记录未重写。新增回归覆盖“规格标签与商品名不同”和“二者相同不重复”两种情况。修复后的全新请求重新经历真实模型、来源读取、本体写回与验收，见 [通过记录](verification.json) 和 [交付文件](artifact.json)。

所选变体为 `gid://shopify/ProductVariant/36130238136487`、SKU `PC12-R`。记录中的显示单价为 29.00 USD，可售标记为 true，均按当次 Shopify 响应核对；库存数量、配送承诺、完整目录覆盖及合作信任仍未知。它是有时间戳的读取结果，不是之后时点的最新价格承诺。

## 反向验证

以下检查使用真实任务快照和隔离内存副本，不修改运行数据库，也不再次调用厂商：

- 删除实际本体读取回执后，计划校验拒绝执行。
- 删除来源状态计算回执后，完成校验拒绝接受。
- 将计算时刻移至有效窗口之后，来源结果为 `unknown`。
- 把价格改成 1 分并重新计算观察摘要，但不伪造对应的来源证明，函数返回 `unknown`，完成校验拒绝接受。

此前过期的两条历史商品观察，通过当前 MCP 计算同样返回 `unknown`，见 [运行接口检查](ontology-api-before.json)。没有把旧价格作为新鲜事实。

## 证据与边界

- [运行及模型证据](verification.json)：模型调用、实际本体读取、模型选择的步骤、HTTP 请求／响应摘要、来源事实、最终计算及反向检查。
- [冻结源码摘要](source-files.json)：96 个运行源文件／启动配置文件。实际复测发生在提交前，原始记录保留当时的 dirty 标记；交付时再核对这些源码与提交内容及不可变运行构建。
- [测试](tests.txt)、[类型检查](check.txt)、[构建](build.txt)、[进程 E2E](e2e.txt)：334 项测试和 7 项进程测试通过。多路径选择及价格变化后的改选回归使用合成来源；本次两条记录使用真实模型和真实 Shopify 读取，分别记账。

独立观察器 `examples/verify-ontology-catalog-runtime.ts` 只读任务、数据库、已保存的来源字节及准确的不可变运行代码。它不提交任务、不调用模型、不调用 Shopify。反向测试只写内存副本。原有 13 条任务在复测期间保持原样；没有创建购物车、结账、订单、付款或履约记录。

```sh
node --import tsx examples/verify-ontology-catalog-runtime.ts --live --session-dir <本次私有诊断目录>
```
