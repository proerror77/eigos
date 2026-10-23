# 滴滴地点搜索与车型估价

2026-10-23。`ride.estimate.query@1` 复用 `eigos.delegate`、Agent 动作循环、Ontology 与持久任务。Gateway 只发布能力；只有 Worker 读取本机私密 Key 并连接[滴滴官方 MCP](https://mcp.didichuxing.com/api)。没有新增公共入口或依赖。

## 范围与来源

可执行工具固定为 `maps_textsearch` 和 `taxi_estimate`，SDK 发出请求前再次校验。上游目录中的下单、取消、订单、司机、链接及其他地图工具都不能执行。`EIGOS_DIDI_ORDERS_ENABLED=true` 在启动时拒绝，普通回复或沙箱许可不能扩展工具范围。

支持独立地点搜索，以及给定城市、起点、终点的车型估价，不要求虚填人数、预算或接送期限。模型选择动作和来源地点；可并行搜索两端，估价前必须实际读取、评估两份已接受的地点观察。连接器不自行选择业务步骤。

唯一精确名称可消歧；多个同名地点要求完整地址选择，不默认取第一项。地点 ID 是本地快照摘要，非平台 POI ID；坐标来自当前任务和 revision 的观察，发送为字符串，经度在前，坐标系标为 `provider_unspecified`。

价格保留原生车型代码和 `priceText`。只有明确的单值十进制才精确转为人民币 minor；区间、约数和“起”价保持原文。指定车型未返回时报告本次无结果，不替换车型。`RideEstimateObservation` 不投影为 `RideOption`、`RideTrip` 或订单，完整费用、可叫到车、接驾和到达承诺保持未知。五分钟新鲜度是 EIGOS 本地策略，非滴滴报价有效期。`traceId` 只可留在私密原始回包，不进入模型、Task、本体或交付物。

使用官方 SDK 处理握手、工具发现与 Streamable HTTP/SSE。每个动作只发一次业务工具调用，不自动重放。发现结果的必填字段与类型必须匹配白名单；额外可选字段不传入。拒绝重定向、异常端点、超大回包、JSON-RPC/MCP 错误、错误业务字段和 Key 回显，错误信息不带原始 URL 或上游原文。

## 本机配置

默认关闭，仅支持本人 `local-development/local/developer`、非生产 loopback，不共享个人 Key 给 JWT 多用户。生产与 Mock 端点固定、不互相降级；Mock 只在显式 sandbox 任务中可见，证据标为 `provider_test`，测试替身为 `synthetic`。

Key 放在仓库外、当前用户拥有的普通文件中，文件权限 0600、父目录 0700。拒绝符号链接、硬链接、宽松权限和摘要不符。Gateway 不读文件；两端使用相同的非秘密引用：

```dotenv
EIGOS_DIDI_KEY_FILE=/absolute/private/didi.key
EIGOS_DIDI_KEY_SHA256=<SHA-256 of the trimmed Key>
EIGOS_DIDI_BINDING_ID=personal-didi
EIGOS_DIDI_ENVIRONMENT=production
EIGOS_DIDI_ORDERS_ENABLED=false
# Only Worker needs this private directory.
EIGOS_DIDI_AUDIT_DIR=/absolute/private/didi-reads
```

不要把 Key 放进环境变量值、CLI 参数或任务消息。摘要固定实际凭据，变更后旧配置拒绝使用；轮换需更新绑定 ID 与摘要，使旧计划失效。删除 Key 或改变其私密权限后，后续来源读取拒绝。在途返回仍受任务取消、revision 和租约保护，已经发出的只读请求不能追溯撤回。

构建后 `setup:pa` 可启用本人既有本机实例，在停止服务前检查凭据。首次提供以上引用；后续省略会保留，显式 `EIGOS_DIDI_KEY_FILE=''` 可关闭。原始回包和审计保存于私密目录，不提交 Git；没有公网部署。

## 使用与验证

PA 继续以 MCP `submit_task` 或 A2A `SendMessage` 提交自然语言，例如“只搜索北京市北京西站地点”或“只查北京西站到天安门的滴滴估价，不下单不付款”。地点歧义在原任务补问；完成仅表示本次地点／估价查询完成。

独立验证通过实际 Gateway／Worker 和 Codex 模型执行两个公共地点目标，并核对 MCP、A2A 和 `rideEstimateStatus`：

```sh
node --import tsx examples/verify-didi-readonly.ts --live \
  --config /absolute/private/server.env --output /absolute/private/verification
```

验证器不接收 Key、不直接调用滴滴工具，输出在私密目录；不等于真实 PA 发起或真实打车。测试覆盖工具禁用、凭据文件、金额、异常、地点歧义、跨用户隔离、新鲜度与取消迟到结果。真实验证及当前限制见[本轮证据](evidence/didi-readonly-2026-10-23/README.md)。
