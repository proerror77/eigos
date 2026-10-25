# PA 接入 EIGOS

以下既有示例对应默认 `EIGOS_SECURITY_MODE=legacy`。foundation v2 的[资源／任务／输出合同](security-s2-s4.md)由 [S5 客户端及来源适配](security-s5.md)补齐；查询要求 version 2 和显式 taskId，任务响应为 TaskView。`POST /security/context` 返回 S5 与当前安装／授权引用。S5 已有离线迁移工具及常驻数据副本演练；真实会员双安装、隔离／撤销与部分来源只读验收已通过；滴滴于 18:30 完成新的受保护真实只读验收，最终常驻切换与读回正在完成。新模式需要独立的来源、角色、模型与接收资格，不直接复用旧库授权。
单任务目标覆盖、统一结果和反馈的当前合同见[单任务闭环](single-task-ontology-closure.md)。

完整对象目录、来源接入及工作分支／常驻运行版本见[模型与接入能力总览](ontology-and-integrations.md)。

后端统一使用 Ontology + LLM，公共业务入口只有 `eigos.delegate`，以及显式沙箱配置下的 `eigos.aftersales`。旧直接服务名被输入 Schema 拒绝；历史任务只读，不作为执行兼容层。

PA 可选择直接调用已有来源，或通过下述现行接口委托明确业务范围。避免重复规划、来源操作与授权询问的分工建议见 [PA／MCP／Ontology 职责边界](agent-mcp-ontology-responsibilities-2026-10-22.md)；其中的交接清单不是新接口 Schema，不能据此假定支持任意 PA 计划导入或客户本机工具回调。

## 发现与认证

先读取 `/.well-known/agent-card.json`（A2A），或认证后调用 MCP `list_services`。Card 和服务描述来自同一目录。生产使用 OAuth/JWT 与会员资格，权限 scope 为 `services:read`、`tasks:read`、`tasks:write`；任务由受信 `issuer + tenant + sub` 隔离。401 的 `WWW-Authenticate` 指向资源元数据；403 表示资格或 scope 不足。客户端不得从用户输入中指定所有者。

本机开发使用已生成的私有 Bearer 令牌，限 loopback。不要把令牌放进任务、提示词、日志或公开证据。完整登录与续期见 [会员说明](membership.md) 和 [Agent 自助登记](agent-onboarding.md)。

## MCP

远程无状态 HTTP 地址为 `/mcp`。支持工具：`list_services`、`submit_task`、`get_task`、`list_tasks`、`reply_to_task`、`select_payment_route`、`report_payment_result`、`cancel_task`、`reconcile_task`、`revoke_task_authorization`；配置沙箱售后时另有 `request_remediation`。实际能力以发现结果为准。

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

当前代码运行契约为 `ontology-execution-v23`，业务模型为 `eigos.business@20`，整合了免费报名、可选支付与原常驻版本的规划及 PA 客户端更新，并增加模型可选的[只读依赖图与条件验收](ontology-read-dataflow-2026-10-24.md)。六类服务默认没有真实来源绑定，显式注入的提供者只用于本机沙箱。Action 定义／模型提案不产生真实业务许可。新类型、状态、运行方式和接口缺口见 [六类服务说明](service-domains-2026-10-18.md)。

交易程序 `commerce.journey.sandbox@2` 的海关关卡同时约束 MCP／A2A 任务，因为核验发生在共用 Worker 中。请求范围内的模型通过当前 `ServiceRequest` 的 `customsRuleSets` 和 `regulatoryReferences` 关系读取依据；不扩大为整个所有者的数据访问权。对实际清关评估、报价或结账对象调用 `evaluate_ontology` 的 `customsGateStatus`，只有 `pass_sandbox` 可以继续对应模拟动作。`blocked` 和 `unknown` 均阻止执行，`legalApproval` 始终为 false。准确计划授权保持原接口，不能覆盖关卡。见[海关规则说明](customs-policy-2026-10-20.md)。

显式 `executionEnvironment: "sandbox"` 可选择已配置的 `commerce.journey.sandbox@2`。Agent 以原子动作查询上下文和商家事实；需要用户选择时在原 Task 补充，沙箱写入在同一 `/tasks/{id}/authorize` 接口使用 `approve_plan`，绑定 `planDigest`、`allowedEffects`、`maxAmount`、`payeeIds`、`expiresAt` 和 `environment: "sandbox"`。模型的可行性判断不产生许可。PA 的既有 Python 客户端支持这种授权格式，同时保留旧模拟报价确认格式。新程序和业务证据边界见 [交易沙箱说明](commerce-agent-sandbox-2026-10-19.md)。

同类要求可带所选能力声明的 `role`：例如酒店 `room_count`／`guest_count`、打车 `pickup`／`arrival`、租车 `service_total`／`deposit`。模型保留各自原话与来源；校验只使用相应角色的事实，缺证据保持 unknown。未带 role 的要求保留原有单一语义，不自动匹配其他角色。v6 及更早计划只读，不自动迁移或恢复执行。修复及真实模型证据见 [六类验证](service-domain-validation-2026-10-18.md)。

UCP 本地测试接入也使用原 `eigos.delegate`。`commerce.ucp.prepare.sandbox@1` 只完成结账准备；`commerce.ucp.confirm.sandbox@1` 引用本用户的准备任务，并要求准确的 order/payment 双重模拟许可。两项操作分别返回准确终点，不把准备会话当成购买。正式 HTTP、原键查证、跨任务防重、对象回写和未开放项见 [UCP 接入说明](ucp-local-integration-2026-10-18.md)。生产配置中没有自动启用这些能力的开关。

Shopify 的 `commerce.catalog.query@2` 在显式配置商家后加入本机本人的 `eigos.delegate` 能力目录。PA 仍提交自然语言目标，前端无需知道动作名。解释阶段只创建 `CatalogTask`，没有来源查询。EIGOS Agent 从本体定义选择 `SearchPublicCatalog`、`InspectCatalogVariant`、`DiscoverMerchantCatalog`、`ReadMerchantVariants` 及参数、依赖关系；每个连接器调用只对应一个厂商操作。`CatalogObservation`／`CatalogEndpoint` 写回后，模型读取结果并决定下一步或完成。完成需要所选观察的实际 `catalogObservationStatus` known 结果和独立验收。接口没有固定的三款选择或查询顺序；完整性、库存数量、配送及合作信任仍未知。配置不变，当前实现与真实验收状态见 [Agent 动作说明](catalog-agent-actions-2026-10-19.md)；[@1 预设流程记录](shopify-pa-worker-2026-10-19.md) 与 [前期匿名准入](shopify-readonly-admission-2026-10-18.md) 保留为历史证据。

当前供应商 MCP 路径（滴滴、美团个人通道、Shopify 目录）统一使用独立本体工具定义与模型规划，见 [MCP 统一说明](mcp-ontology-unification.md)。Gateway 不准备候选或读取地址；Worker 按模型选定动作执行一次读取。真实下单和付款继续禁止；非 MCP 的 HTTP／本地模拟程序另行标注，不混作真实业务接入。

## A2A

`/a2a` 实现 A2A 1.0 JSON-RPC 的 SendMessage、GetTask、ListTasks、CancelTask。请求携带 `Authorization: Bearer …`、`Content-Type: application/json`、`A2A-Version: 1.0`。普通 text parts 默认进入 `eigos.delegate`：

```json
{"jsonrpc":"2.0","id":"rpc-1","method":"SendMessage","params":{"configuration":{"returnImmediately":true},"message":{"messageId":"stable-submit-id","role":"ROLE_USER","parts":[{"text":"帮我查1公斤文件普通送运费，先列出保存地址让我选。只查价。"}]}}}
```

后续 SendMessage 带原 taskId，以新的 messageId 回复自然语言。也可使用单个 data part 携带与 MCP 相同的业务参数。`service`、requirements、executionEnvironment 是 EIGOS 字段，非 A2A 标准必填项。标准协议状态与 MCP 共用底层任务。

异步 submitted／working 继续查询同一个 taskId；有界 poll 超时不代表执行失败。input-required 转述问题并等待用户；auth-required 只能经独立授权 API 处理精确的本地模拟方案，普通“同意”回复不授予业务许可。相同请求 ID 重试必须保持原内容，不能用新任务替换结果不明的原操作。

本机 PA 的 Python 客户端支持 `run --text-file <目标文件> --request-id <稳定ID> --save-dir <私密目录>`，在一次调用中发现、提交、轮询并保存原始任务、artifact和分段耗时。超时返回 `resumeRequired=true`，重复相同命令只续读已保存任务；不确定提交停止检查，不自动重发。需要输入或授权时交回 PA，不代答或授权。此便利入口沿用上述 A2A 接口和权限，不预设业务工具或执行顺序。

`run --spec-file <私密JSON>`可引用已保存的profile路径、textFile、requestId和saveDir，另可指定seconds和interval；不能替换显式选定的profile或传入凭据值。run默认等待55秒，单独poll的45秒上限保留。stdout提供简明交付文本；完整任务及artifact仍保存到私密目录。

不提供流式响应或推送通知；客户端轮询。取消 Task 阻止后续工作，不表示供应商订单取消。当前现实订单、支付、取消和退款全部禁止。

## 本机 PA 与运行

`npm run build` 后运行 `npm run setup:pa` 更新本人 macOS 常驻服务。现有 profile 和凭据引用沿用，默认服务改为 `eigos.delegate`。PA 应读取更新后的 `~/.local/share/eigos/grok-life/skill-install.md` 并保存到其技能库。Python 客户端只负责协议收发；实际 PA 必须自己发现、提交、处理问题和读回，固定脚本探针不能替代 PA 验收。

默认新协调器启用。文档能力通过 `EIGOS_EXECUTOR=codex` 配置；个人美团读取通过绝对路径 `EIGOS_PAOTUI_SKILL_DIR` 配置，仅允许本机本人。`EIGOS_PAOTUI_ORDERS_ENABLED` 只能为 false。Gateway 与 Worker 共享持久任务库，模型及 Ontology MCP 查询只在 Worker 执行。见 [运行说明](gateway-worker.md)。

## PA 自有支付与预约回读

`booking.pa-payment.sandbox@3` 把预约准备到待付款，发布 `PAPaymentRequest` 后以 `awaiting_pa_payment` 暂停。PA 先用 `select_payment_route` 提供当前钱包可用性：可用且商家支持时优先 Link Agent Wallet；明确不可用或商家不支持钱包、但提供普通 Link 时，交给用户在同一预约的测试结账页确认。状态未知时先查询，不自动改路。路线及操作键持久保存，提交后不自动改路。随后用 A2A 结构化 `SendMessage` 或 MCP `report_payment_result` 通知同一任务。通知不含凭据、不证明付款；EIGOS 必须独立回读原付款和预约，二者匹配后才完成。

Agent Card 的 `/.well-known/eigos-pa-payment` 版本 2 扩展公布付款请求、路线选择与通知 Schema。Python 客户端支持 `payment-route`、`payment-result`，并通过 `reconcile` 复用已有原操作回读接口。此路径没有 EIGOS 付款动作，不需要 EIGOS Stripe 账户；旧商家付款环境开关已禁用。所有测试均在隔离服务商和 PA 钱包夹具中完成，真实钱包及服务商未接入。详见 [PA 预约付款流程](pa-booking-payment-flow.md)。

## Stripe Treasury 预留

已预留官方 MCP 地址及 `EIGOS_STRIPE_TREASURY_ENABLED=false`。当前版本拒绝启用，没有账户授权、网络连接或可执行 Treasury 能力；MCP/A2A 均不发布资金查询或操作入口。后续按成员账户授权和 Worker 执行边界单独接入，见 [Treasury 接入预留](stripe-treasury-integration.md)。

## 滴滴接入

本人本机可显式配置 `ride.estimate.query@1`，支持地点搜索和指定路线车型估价，仍通过 `eigos.delegate` 使用。Key 仅由 Worker 从私密文件读取；Gateway 构造目录不读 Key、不发来源请求。只有 `maps_textsearch`、`taxi_estimate` 可执行，估价不代表完整车费、叫车或行程完成。配置、歧义和证据范围见[滴滴只读说明](didi-readonly-integration.md)。

## 免费活动报名与通用预约

`booking.participant.free@1` 复用 `eigos.delegate`、同一 Task、MCP／A2A 和 Worker。模型从本体选择检查、提交、回读及等待动作；目标为 `submitted` 时核验提交回执，目标为 `confirmed` 时必须取得有效参加资格。待审核和候补保持进行中，不生成付款请求。

本次真实来源仅为本机本人已登录的 Luma 参与者网页，通过需要在线操作代理的浏览器桥接调用；它不是 Luma 官方参与者报名 API，也不使用主办方 Add Guests 代替报名。通用预约模型与合成流程已实现，其他真实预约平台尚未接入。默认关闭，生产和远程多用户身份不可用。

真实免费提交仍需原 `/tasks/{id}/authorize` 的 `approve_plan`，`environment: "live_free"`，绑定原计划摘要、`allowedEffects: ["reserve"]`、`maxAmount.minor: "0"`、准确服务主体与有效期。这项许可不授予下单、付款、变更或取消权限。金额为零但费用或付款要求未知时不能提交。

已确认后的结果可通过 `query_ontology` 精确读取 `RegistrationRecord`，并用 `evaluate_ontology` 的 `registrationStatus` 独立核验。浏览器回读为 `live_readonly`，实际提交观察为 `live_operation`；它们不证明实际到场，也不等同于 Luma 签名的 API 回执。配置、操作代理、状态和验证记录见[免费报名说明](free-booking-participant-2026-10-23.md)。

跨服务目标使用同一 Task 的[服务组件图](cross-service-composition.md)，分别保留来源和精确授权，全部组件通过后才验收主目标。

### 官方 Mock 下单测试

显式启用 `EIGOS_DIDI_ORDER_TEST_ENABLED=true` 后，本机开发身份可使用 `ride.order.test@1`，必须提交 `executionEnvironment="sandbox"`。`EIGOS_DIDI_ORDERS_ENABLED=false` 保持不变。两种协议共享相同任务、精确计划许可与独立验收；可选 `capabilityRef` 只缩小当前身份可用目录，不产生授权。固定测试路线、操作边界、计时与故障恢复见[下单测试说明](didi-order-test.md)。
