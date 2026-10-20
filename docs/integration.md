# PA 接入 EIGOS

后端统一使用 Ontology + LLM，公共业务入口只有 `eigos.delegate`，以及显式沙箱配置下的 `eigos.aftersales`。旧直接服务名被输入 Schema 拒绝；历史任务只读，不作为执行兼容层。

## 发现与认证

先读取 `/.well-known/agent-card.json`（A2A），或认证后调用 MCP `list_services`。Card 和服务描述来自同一目录。生产使用 OAuth/JWT 与会员资格，权限 scope 为 `services:read`、`tasks:read`、`tasks:write`；任务由受信 `issuer + tenant + sub` 隔离。401 的 `WWW-Authenticate` 指向资源元数据；403 表示资格或 scope 不足。客户端不得从用户输入中指定所有者。

本机开发使用已生成的私有 Bearer 令牌，限 loopback。不要把令牌放进任务、提示词、日志或公开证据。完整登录与续期见 [会员说明](membership.md) 和 [Agent 自助登记](agent-onboarding.md)。

## MCP

远程无状态 HTTP 地址为 `/mcp`。支持工具：`list_services`、`submit_task`、`get_task`、`list_tasks`、`reply_to_task`、`cancel_task`、`reconcile_task`、`revoke_task_authorization`；配置沙箱售后时另有 `request_remediation`。实际能力以发现结果为准。

N1 增加三个只读工具：`describe_ontology`（services:read）、`query_ontology`、`evaluate_ontology`（tasks:read）。对应认证 HTTP POST 为 `/ontology/describe`、`/ontology/query`、`/ontology/evaluate`；均按同一 owner 隔离。支持类型／接口发现、分页对象集、单跳关系和登记计算，不开放对象写入或业务 Action。输入、边界和来源投影见 [N1 使用说明](ontology-n1.md)。现有 PA 的任务提交、补问及读回方式保持。

N2 在 Worker 内让模型实际调用有界查询，并由程序核对条件和计划快照。`query_ontology` 还支持 `{"object":{"type":"具体类型","id":"对象ID"}}` 精确读取。只有 tasks:write 的客户端仍能获得本次写操作的回执，但模型的数据范围限于当前委托及其已取得对象，不能据此搜索其他委托。完整 owner 查询仍要求 tasks:read。业务决策提案保持不执行；详情见 [N2 说明](ontology-n2.md)。

提交自然语言需求：

```json
{"service":"eigos.delegate","goal":"帮我查询寄1公斤文件普通送的价格，先让我选择寄件和收件地址。只查价，不下单、不付款。","requestId":"stable-submit-id"}
```

缺项返回 `input-required` 和具体问题。按用户选择回复同一任务：

```json
{"taskId":"返回的任务UUID","answer":"寄件用地址1，收件用地址2。","requestId":"stable-reply-id"}
```

地址选项来自真实本人地址簿，按任务私有保存。PA 不自行猜选地址、不索取内部地址 ID，不另建一个报价任务。用户未提供的物品、重量或服务由同一任务补问。地址簿变化会使旧选项失效并重新询问；跨城和含糊选择不能直接报价。

`get_task` 读取交付物及 `delegation.acceptance`。只有完成状态、独立验收和实际交付物一致才报告服务完成。报价仅表示查价完成，订单、支付与配送均未发生。

六类服务扩展复用这些接口和权限。当前代码运行契约为 `ontology-execution-v12`，业务模型为 `eigos.business@11`。六类服务默认没有真实来源绑定，显式注入的提供者只用于本机沙箱。Action 定义／模型提案不产生真实业务许可。新类型、状态、运行方式和接口缺口见 [六类服务说明](service-domains-2026-10-18.md)。

交易程序 `commerce.journey.sandbox@2` 的海关关卡同时约束 MCP／A2A 任务，因为核验发生在共用 Worker 中。请求范围内的模型通过当前 `ServiceRequest` 的 `customsRuleSets` 和 `regulatoryReferences` 关系读取依据；不扩大为整个所有者的数据访问权。对实际清关评估、报价或结账对象调用 `evaluate_ontology` 的 `customsGateStatus`，只有 `pass_sandbox` 可以继续对应模拟动作。`blocked` 和 `unknown` 均阻止执行，`legalApproval` 始终为 false。准确计划授权保持原接口，不能覆盖关卡。见[海关规则说明](customs-policy-2026-10-20.md)。

显式 `executionEnvironment: "sandbox"` 可选择已配置的 `commerce.journey.sandbox@1`。Agent 以原子动作查询上下文和商家事实；需要用户选择时在原 Task 补充，沙箱写入在同一 `/tasks/{id}/authorize` 接口使用 `approve_plan`，绑定 `planDigest`、`allowedEffects`、`maxAmount`、`payeeIds`、`expiresAt` 和 `environment: "sandbox"`。模型的可行性判断不产生许可。PA 的既有 Python 客户端支持这种授权格式，同时保留旧模拟报价确认格式。新程序和业务证据边界见 [交易沙箱说明](commerce-agent-sandbox-2026-10-19.md)。

同类要求可带所选能力声明的 `role`：例如酒店 `room_count`／`guest_count`、打车 `pickup`／`arrival`、租车 `service_total`／`deposit`。模型保留各自原话与来源；校验只使用相应角色的事实，缺证据保持 unknown。未带 role 的要求保留原有单一语义，不自动匹配其他角色。v6 及更早计划只读，不自动迁移或恢复执行。修复及真实模型证据见 [六类验证](service-domain-validation-2026-10-18.md)。

UCP 本地测试接入也使用原 `eigos.delegate`。`commerce.ucp.prepare.sandbox@1` 只完成结账准备；`commerce.ucp.confirm.sandbox@1` 引用本用户的准备任务，并要求准确的 order/payment 双重模拟许可。两项操作分别返回准确终点，不把准备会话当成购买。正式 HTTP、原键查证、跨任务防重、对象回写和未开放项见 [UCP 接入说明](ucp-local-integration-2026-10-18.md)。生产配置中没有自动启用这些能力的开关。

Shopify 的 `commerce.catalog.query@2` 在显式配置商家后加入本机本人的 `eigos.delegate` 能力目录。PA 仍提交自然语言目标，前端无需知道动作名。解释阶段只创建 `CatalogTask`，没有来源查询。EIGOS Agent 从本体定义选择 `SearchPublicCatalog`、`InspectCatalogVariant`、`DiscoverMerchantCatalog`、`ReadMerchantVariants` 及参数、依赖关系；每个连接器调用只对应一个厂商操作。`CatalogObservation`／`CatalogEndpoint` 写回后，模型读取结果并决定下一步或完成。完成需要所选观察的实际 `catalogObservationStatus` known 结果和独立验收。接口没有固定的三款选择或查询顺序；完整性、库存数量、配送及合作信任仍未知。配置不变，当前实现与真实验收状态见 [Agent 动作说明](catalog-agent-actions-2026-10-19.md)；[@1 预设流程记录](shopify-pa-worker-2026-10-19.md) 与 [前期匿名准入](shopify-readonly-admission-2026-10-18.md) 保留为历史证据。

## A2A

`/a2a` 实现 A2A 1.0 JSON-RPC 的 SendMessage、GetTask、ListTasks、CancelTask。请求携带 `Authorization: Bearer …`、`Content-Type: application/json`、`A2A-Version: 1.0`。普通 text parts 默认进入 `eigos.delegate`：

```json
{"jsonrpc":"2.0","id":"rpc-1","method":"SendMessage","params":{"configuration":{"returnImmediately":true},"message":{"messageId":"stable-submit-id","role":"ROLE_USER","parts":[{"text":"帮我查1公斤文件普通送运费，先列出保存地址让我选。只查价。"}]}}}
```

后续 SendMessage 带原 taskId，以新的 messageId 回复自然语言。也可使用单个 data part 携带与 MCP 相同的业务参数。`service`、requirements、executionEnvironment 是 EIGOS 字段，非 A2A 标准必填项。标准协议状态与 MCP 共用底层任务。

异步 submitted／working 继续查询同一个 taskId；有界 poll 超时不代表执行失败。input-required 转述问题并等待用户；auth-required 只能经独立授权 API 处理精确的本地模拟方案，普通“同意”回复不授予业务许可。相同请求 ID 重试必须保持原内容，不能用新任务替换结果不明的原操作。

不提供流式响应或推送通知；客户端轮询。取消 Task 阻止后续工作，不表示供应商订单取消。当前现实订单、支付、取消和退款全部禁止。

## 本机 PA 与运行

`npm run build` 后运行 `npm run setup:pa` 更新本人 macOS 常驻服务。现有 profile 和凭据引用沿用，默认服务改为 `eigos.delegate`。PA 应读取更新后的 `~/.local/share/eigos/grok-life/skill-install.md` 并保存到其技能库。Python 客户端只负责协议收发；实际 PA 必须自己发现、提交、处理问题和读回，固定脚本探针不能替代 PA 验收。

默认新协调器启用。文档能力通过 `EIGOS_EXECUTOR=codex` 配置；个人美团读取通过绝对路径 `EIGOS_PAOTUI_SKILL_DIR` 配置，仅允许本机本人。`EIGOS_PAOTUI_ORDERS_ENABLED` 只能为 false。Gateway 与 Worker 共享持久任务库，模型及 Ontology MCP 查询只在 Worker 执行。见 [运行说明](gateway-worker.md)。

## Stripe 测试付款

`commerce.journey.stripe-test@1` 在配置测试账户后复用现有 MCP/A2A 任务、准确计划授权和独立结果回读。`target=payment` 必须以原 Stripe 测试 PaymentIntent 的独立捕获回读完成；当前验证为隔离 API/模型夹具，未连接 Stripe 账户。配置、动作、PA 请求及失败状态见 [Stripe 测试支付](stripe-test-integration.md)。
