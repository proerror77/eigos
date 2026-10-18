# 常驻 PA → A2A → 公开地点 DiscoverySource 验收

2026-10-18（Asia/Shanghai）。用户批准将 `8c467e5`、`f852f64`、`3fce840`、`897f796`、`16ff19a` 五个提交合入 main，更新既有常驻服务，仅启用“北京市／天安门”的公开地点发现；复用现有登录、PA 和模型，只读、不下单、不付款、不新增权限。

最终由既有 Grok Bot／Monk PA 提交自然语言，经 A2A 进入常驻 EIGOS；真实 Codex 模型解释及规划，新 `meituan:public-geo-discovery` 经内部 Ontology MCP 调用美团 `search_poi`。PA 读回同一任务的 20 个公开地点、名称、地址和度单位坐标，状态 `COMPLETED`、`accepted=true`。不是固定规划器或 fixtures 验收。

## 请求与运行范围

原句保持不变：

> 请帮我查询北京市的公开地点，搜索关键词是“天安门”。请返回实际查到的地点名称、公开地址和可用坐标。仅查询公开地点，不读取我的地址簿，不下单、不付款。

- 常驻 endpoint：`http://127.0.0.1:3430`；后端 `ontology-execution-v3`，公共服务仅 `eigos.delegate`。
- Gateway／Worker 共用白名单：`[{"city":"北京市","keyword":"天安门"}]`。新来源替换该能力的静态搜索绑定，任务和模型不能扩大白名单。
- 原 PA 客户端、profile、技能和客户端令牌逐字节未变；官方来源程序 SHA-256 保持 `0a6b0ef9371bcbf9a6a5cecc20f3efe1b6220174dcffed365d91fc9949d407ba`。无新增登录或权限操作。
- 成功验收的不可变运行构建摘要：`74b36ef65306af7627e7dd85aa02ad775a8547c9fc5987b41dfffd6c91ec1ff7`。观察器逐文件比对部署与当前构建，并比对健康端点摘要。

## 首次失败与修复后的成功

| 尝试 | taskId | 结果 | 实际读取／模型调用 |
| --- | --- | --- | --- |
| 首次 | `0d4d67e0-e412-4e75-93b5-c764158e3b53` | `REJECTED`；来源返回 20 个地点，但城市硬约束缺少兼容事实，无计划或交付物 | 1 次 `search_poi`，2 次 Codex |
| 修复后复验 | `0cf49ef8-926f-48e1-b140-c19e0096add6` | `COMPLETED`、`accepted=true`，PA 收到 20 个地点 | 1 次 `search_poi`，2 次 Codex |

本轮共 2 次真实公开地点读取、4 次后端模型调用。两个 PA 任务分别使用稳定 requestId，每个只提交一次，没有隐去首次失败或改写其终态。修复后来源读取发生于 09:56:06，独立验收完成于 09:56:23；PA 于 09:56:39 回报结果。首次读取不是成功验收，亦不与此前固定规划器的独立来源探针混为一谈。

故障在本体与事实映射：首次模型将“北京市”提取为地点硬约束，但 `geo.search` 没有声明搜索范围语义，准备和交付事实也没有搜索范围。修复明确 `locationSemantics=search_area`，将经回执绑定的 city／keyword 保留到准备和交付事实，并支持城市级搜索范围检查。配送目的地、其他城市及无证据情形仍不能借此通过。实际复验模型按明确的能力描述把城市保留在输入中；强制提取城市硬约束的情况另有运行回归覆盖。

## 验收证据

- [verification.json](verification.json)：成功及失败任务的模型／Ontology 回执、查询摘要、来源配置摘要、覆盖范围、公开结果和独立验收。
- [pa-readback.json](pa-readback.json)：PA 实际保存的 GetTask 的选定字段与完整原文件 SHA-256；PA 产物和服务端只读回读的产物摘要一致。
- PA 又在本地独立核对原查询、计划输入和回执摘要。`inputDigest` 均为 `aca781a95d7e9448bbe3d545225cd6a1e402f08d0d23b2dd0badf7ca6d2ca36f`，未新增业务请求或来源读取。
- 成功任务只有一个读动作，执行复用发现结果；审计增量恰好一条 `ontology_geo_search` 回执，底层名称仅 `search_poi`。包含失败尝试的整段审计恰好两条；无地址簿、报价、订单或支付调用。
- `realSupply=false`、Offer 数为 0、`businessFacts=[]`、`completionTarget=artifact`。`hasMore=true` 表示覆盖完整性未知，不表示商户或库存发现。坐标是度单位，不额外声明坐标参考系或行政区边界验证。

只读观察器不提交业务请求，不调用来源、不运行模型，只核对 PA 文件、持久任务、成功读取审计和部署：

```sh
node --import tsx examples/verify-pa-public-geo-e2e.ts --live \
  --session-dir "$HOME/.local/share/eigos/grok-life/peer/public-geo-discovery-pa-2026-10-18-recheck"
```

完整原始 PA 输出、失败任务快照和运行配置保存在本人私有运行目录；公开证据只含本次授权的公开地点及必要技术回执。

## 工程与部署核对

`npm run check`、178 项 `npm test`、`npm run build`、7 项 `npm run test:e2e:run`、`git diff --check` 通过。新增／扩展回归验证城市级范围、目的地隔离、错误城市和缺失证据，并让 Gateway／Worker 的成功测试包含首次失败时的城市硬约束。工程测试仍使用 fixtures，真实验收由上方独立证据证明。

常驻更新脚本复用运行校验器，显式环境变量可替换清单，省略时保留已有清单，首次安装默认关闭。修复部署时省略变量，回读仍只有原查询组合；非法额外字段配置在停止或改写现有服务前被拒绝，配置、运行清单和来源审计保持原样。提交后再次回读运行版本与最终 SHA，远端 CI 按最终推送 SHA 单独核对。

范围限本人本机常驻服务和这个公开查询组合，不证明多用户或公网部署、通用商户发现、真实交易履约，以及官方 CLI 在真实超时／取消下的退出行为。此前地址选择到真实查价的 [常驻 PA 验收](../persistent-pa-2026-10-18/README.md) 继续作为独立场景证据。
