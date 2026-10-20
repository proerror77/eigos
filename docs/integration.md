# PA 接入 EIGOS

后端统一使用 Ontology + LLM，公共业务入口只有 `eigos.delegate`，以及显式沙箱配置下的 `eigos.aftersales`。旧直接服务名被输入 Schema 拒绝；历史任务只读，不作为执行兼容层。

## 发现与认证

先读取 `/.well-known/agent-card.json`（A2A），或认证后调用 MCP `list_services`。Card 和服务描述来自同一目录。生产使用 OAuth/JWT 与会员资格，权限 scope 为 `services:read`、`tasks:read`、`tasks:write`；任务由受信 `issuer + tenant + sub` 隔离。401 的 `WWW-Authenticate` 指向资源元数据；403 表示资格或 scope 不足。客户端不得从用户输入中指定所有者。

本机开发使用已生成的私有 Bearer 令牌，限 loopback。不要把令牌放进任务、提示词、日志或公开证据。完整登录与续期见 [会员说明](membership.md) 和 [Agent 自助登记](agent-onboarding.md)。

## MCP

远程无状态 HTTP 地址为 `/mcp`。支持工具：`list_services`、`submit_task`、`get_task`、`list_tasks`、`reply_to_task`、`amend_task`、`resume_task`、`get_member_usage`、`cancel_task`、`reconcile_task`、`revoke_task_authorization`；配置沙箱售后时另有 `request_remediation`。实际能力以发现结果为准。

任务返回默认是 `view: "summary"` 的业务视图，无需 PA 选择精简模式。提交、补充、恢复、查询、列表、取消与授权响应保留任务身份、当前版本、状态、问题、完整交付物、验收结论，以及继续处理所需的授权／来源／恢复信息。模型运行记录、完整计划、读取凭据、定义包和历史快照由 EIGOS 内部保存，不随轮询反复发送。现有 `delegation.plan.quote` 和 `delegation.authorizationRequest` 仍提供准确批准所需的报价或计划标识；摘要本身不授予权限。对象详情通过有权限且有界的 Ontology 查询按需读取。`ServiceRequest.requester/proposals/assessments/afterSalesCases` 可进入完整业务链；方案的 `authorizations/businessResults`、验收的 `findings/acceptedArtifact`、售后的 `originalRequest/remedyRequest/originalAssessment/remedyAssessments` 保留各自来源和版本。查询授权状态只返回记录当前是否到期／撤销，不能代替派发时的真实许可检查。详见 [业务链实现与验证](business-chain-implementation-2026-10-20.md)。

A2A 使用相同的业务摘要生成 metadata，保留原有状态与完整 artifacts；默认不附历史消息，显式 `historyLength` 可读取相应业务对话。HTTP 授权、对账和来源恢复响应也使用同一投影。内部账本不删减，结果正文不截断；返回大小主要随业务交付物变化，不随内部模型回合和重复定义增长。

N1 增加三个只读工具：`describe_ontology`（services:read）、`query_ontology`、`evaluate_ontology`（tasks:read）。对应认证 HTTP POST 为 `/ontology/describe`、`/ontology/query`、`/ontology/evaluate`；均按同一 owner 隔离。支持类型／接口发现、分页对象集、单跳关系和登记计算，不开放对象写入或业务 Action。输入、边界和来源投影见 [N1 使用说明](ontology-n1.md)。现有 PA 的任务提交、补问及读回方式保持。

N2 在 Worker 内让模型实际调用有界查询，并由程序核对条件和计划快照。`query_ontology` 还支持 `{"object":{"type":"具体类型","id":"对象ID"}}` 精确读取。只有 tasks:write 的客户端仍能获得本次写操作的回执，但模型的数据范围限于当前委托及其已取得对象，不能据此搜索其他委托。完整 owner 查询仍要求 tasks:read。业务决策提案保持不执行；详情见 [N2 说明](ontology-n2.md)。

提交自然语言需求：

```json
{"service":"eigos.delegate","goal":"帮我查询寄1公斤文件普通送的价格，先让我选择寄件和收件地址。只查价，不下单、不付款。","requestId":"stable-submit-id"}
```

`goal` 和可选 `deliverable` 都属于原始提交。后端将二者保留为独立、有稳定身份和原提交时间的指令来源，后续补充排在它们之后；不会因要求放在 `deliverable` 中而漏掉重量等事实或无法引用原文。

缺项返回 `input-required` 和具体问题。按用户选择回复同一任务：

```json
{"taskId":"返回的任务UUID","expectedRevision":1,"answer":"寄件用地址1，收件用地址2。","requestId":"stable-reply-id"}
```

地址选项来自真实本人地址簿，按任务私有保存。PA 不自行猜选地址、不索取内部地址 ID，不另建一个报价任务。用户未提供的物品、重量或服务由同一任务补问。已确认的编号绑定本人当时看到的列表；续期后仍须读取当前地址簿，所选地址的 ID 和内容一致才可沿用。无关地址增删或列表重排不要求重复选择；所选地址改变、匹配含糊或身份连续性无法确认时才重新询问。

`expectedRevision` 必须来自当时展示的问题或当前任务读回；旧版本回复被拒绝，不自动绑定到后来的问题。用户主动更正已知信息时，用 `amend_task` 和同样参数更新仍开放的只读任务；最新明确事实覆盖旧值，未更正字段及历史来源保留。业务计划固定后仍走原有处理边界。

任务执行预算与支付金额无关。提交可带 `executionBudget: "standard"`（默认）或 `"extended"`。技术故障自动在同一任务重试；连续三次相同故障暂停为 `paused`，不再索取业务答案。运行条件修复后使用 `resume_task`，必要时扩大任务档位：

```json
{"taskId":"原任务UUID","expectedRevision":3,"executionBudget":"extended","requestId":"stable-resume-id"}
```

`resume_task` 不接受 answer、不追加用户确认、不改变业务请求版本。有效补充、来源恢复、技术恢复以及有实质进展的单段续办可开启有限窗口，不删除累计用量，也不授予业务写权限。`get_task` 的 `delegation.executionBudgetStatus` 返回当前档位、单段和累计上限、已用次数及暂停原因；PA 不得用新建替代任务规避累计限制。具体上限、身份连续性和恢复边界见[任务恢复说明](task-recovery-2026-10-20.md)。

`get_member_usage` 需要 `tasks:read`，按当前认证会员汇总其任务和不同安装的用量，不接受其他会员 ID。`get_task.memberUsage` 返回同样统计。当前 `limitsEnforced=false`，不设会员额度上限、余额或重置周期；任务防失控上限仍生效。已报告模型 token、未报告用量的尝试、供应商动作次数分开计数；外部 PA 自己的模型用量不在此账本中。

`get_task` 读取交付物及 `delegation.acceptance`。只有完成状态、独立验收和实际交付物一致才报告服务完成。报价仅表示查价完成，订单、支付与配送均未发生。

原始交付要求、更正、执行关系以及默认业务摘要的真实 PA 验证见[2026-10-20 验收记录](evidence/ontology-graph-live-2026-10-20/README.md)。业务验收时的有效报价与之后的历史回读分别记载，不以过期结果承诺当前价格或来源授权。

六类服务扩展复用这些接口和权限。当前运行契约为 `ontology-execution-v8`，业务模型为 `eigos.business@10`。六类服务默认没有真实来源绑定，显式注入的提供者只用于本机沙箱。Action 定义／模型提案不产生真实业务许可。新类型、状态、运行方式和接口缺口见 [六类服务说明](service-domains-2026-10-18.md)，当前对象身份、执行图与提交条件见 [原则复审](ontology-principles-review-2026-10-20.md)。

同类要求可带所选能力声明的 `role`：例如酒店 `room_count`／`guest_count`、打车 `pickup`／`arrival`、租车 `service_total`／`deposit`。模型保留各自原话与来源；校验只使用相应角色的事实，缺证据保持 unknown。未带 role 的要求保留原有单一语义，不自动匹配其他角色。v6 及更早计划只读，不自动迁移或恢复执行。修复及真实模型证据见 [六类验证](service-domain-validation-2026-10-18.md)。

UCP 本地测试接入也使用原 `eigos.delegate`。`commerce.ucp.prepare.sandbox@1` 只完成结账准备；`commerce.ucp.confirm.sandbox@1` 引用本用户的准备任务，并要求准确的 order/payment 双重模拟许可。两项操作分别返回准确终点，不把准备会话当成购买。正式 HTTP、原键查证、跨任务防重、对象回写和未开放项见 [UCP 接入说明](ucp-local-integration-2026-10-18.md)。生产配置中没有自动启用这些能力的开关。

Shopify 的 `commerce.catalog.query@2` 在显式配置商家后加入本机本人的 `eigos.delegate` 能力目录。PA 仍提交自然语言目标，前端无需知道动作名。解释阶段只创建 `CatalogTask`，没有来源查询。EIGOS Agent 从本体定义选择 `SearchPublicCatalog`、`InspectCatalogVariant`、`DiscoverMerchantCatalog`、`ReadMerchantVariants` 及参数、依赖关系；每个连接器调用只对应一个厂商操作。`CatalogObservation`／`CatalogEndpoint` 写回后，模型读取结果并决定下一步或完成。完成需要所选观察的实际 `catalogObservationStatus` known 结果和独立验收。接口没有固定的三款选择或查询顺序；完整性、库存数量、配送及合作信任仍未知。配置不变，当前实现与真实验收状态见 [Agent 动作说明](catalog-agent-actions-2026-10-19.md)；[@1 预设流程记录](shopify-pa-worker-2026-10-19.md) 与 [前期匿名准入](shopify-readonly-admission-2026-10-18.md) 保留为历史证据。

## A2A

`/a2a` 实现 A2A 1.0 JSON-RPC 的 SendMessage、GetTask、ListTasks、CancelTask。请求携带 `Authorization: Bearer …`、`Content-Type: application/json`、`A2A-Version: 1.0`。普通 text parts 默认进入 `eigos.delegate`：

```json
{"jsonrpc":"2.0","id":"rpc-1","method":"SendMessage","params":{"configuration":{"returnImmediately":true},"message":{"messageId":"stable-submit-id","role":"ROLE_USER","parts":[{"text":"帮我查1公斤文件普通送运费，先列出保存地址让我选。只查价。"}]}}}
```

后续 SendMessage 带原 taskId，以新的 messageId 回复自然语言，并在 `message.metadata.expectedRevision` 绑定问题版本。单个 data part 则在 data 中携带 `expectedRevision`。更正使用 `message.metadata.taskOperation="amend"`；技术恢复使用 `"resume"` 和只含 `expectedRevision`、可选 `executionBudget` 的 data part。`service`、requirements、executionEnvironment、executionBudget、taskOperation 是 EIGOS 字段，非 A2A 标准必填项。标准协议状态、预算和继续执行规则与 MCP 共用底层任务。

异步 submitted／working 继续查询同一个 taskId；有界 poll 超时不代表执行失败。A2A 标准状态仍为 WORKING 时，若 `metadata.internalState="paused"` 则等待运行修复后恢复，不询问已有业务信息；详情在 `metadata.delegation.recovery`。input-required 只补真正缺失的信息；auth-required 按来源连接或精确的模拟方案走独立授权 API，普通“同意”回复不授予业务许可。相同请求 ID 重试必须保持原内容，不能用新任务替换结果不明的原操作。GetTask 的 `metadata.memberUsage` 提供本人累计用量。

不提供流式响应或推送通知；客户端轮询。取消 Task 阻止后续工作，不表示供应商订单取消。当前现实订单、支付、取消和退款全部禁止。

## 本机 PA 与运行

`npm run build` 后运行 `npm run setup:pa` 更新本人 macOS 常驻服务。现有 profile 和凭据引用沿用，默认服务改为 `eigos.delegate`。PA 应读取更新后的 `~/.local/share/eigos/grok-life/skill-install.md` 并保存到其技能库。Python 客户端只负责协议收发；实际 PA 必须自己发现、提交、处理问题和读回，固定脚本探针不能替代 PA 验收。

默认新协调器启用。文档能力通过 `EIGOS_EXECUTOR=codex` 配置；个人美团读取通过绝对路径 `EIGOS_PAOTUI_SKILL_DIR` 配置，仅允许本机本人。`EIGOS_PAOTUI_ORDERS_ENABLED` 只能为 false。Gateway 与 Worker 共享持久任务库，模型及 Ontology MCP 查询只在 Worker 执行。见 [运行说明](gateway-worker.md)。

## 邀请制网络接口（默认关闭）

T06–T12 的协作功能复用 JWT/会员身份，另需明确网络准入和 `network:read` / `network:write`。网络写入还需控制者将具体安装绑定到稳定 profile；有任务权限不自动获得网络权限。批准只接受会员会话、同源 Origin 和 CSRF，不提供 bearer/MCP 批准动作。

HTTP：`POST /network/v1/query`、`/commands`、`/receipts/get`；MCP：`network_query`、`network_command`、`network_get_command`。需求、结构化回应和一跳服务推荐共用草稿→精确批准→发布，关闭需求使用 `need.close`。查询使用 need/messages/search 判别输入，具体字段和版本规则见 [T08 接口](network-t08.md)。

这些记录不进入 A2A Task，不调用模型或服务商，也不更改私有要求和授权；从网络线索转换为私有询价使用下述 T10 的独立确认。圈内页面沿用相同受众过滤。网络开关默认 false，本轮未部署或开放真实交易。

T09 增加 `POST /network/v1/updates` / MCP `network_updates`，返回当前授权动态与分页 cursor/增量 checkpoint。`follow.set` 需要新的安装绑定权限 `follow.manage`，`my_follows` 仅本人可读。关注不扩大受众，游标失效返回 CURSOR_STALE 和 resetRequired；恢复、去重、15 分钟有效期与缓存清理规则见 [T09 接口](network-t09.md)。动态读取不启动模型或业务动作。

T10 增加 inquiry.request_conversion/convert 与 inquiry.request_selection/select_quote，要求 inquiry.manage 安装权限、网络与任务 scopes，并消费会员会话确认的准确 choice。my_inquiry 按 owner 恢复 Task，my_selection 只读本人选择快照。来源只限已审核且实际获权的既有只读报价绑定；普通回复、社交推荐和模型方案都不能授予转换或交易权限。完整参数、确认界面、恢复与报价限制见 [T10 说明](network-t10.md)。

T11 增加 evidence.prepare/refresh 与 my_evidence，使用新的 evidence.manage 绑定权限和 tasks:read，从本人已有结果生成固定字段卡片。draft.create 的 evidence_card 只接受 cardId/cardRevision，复用原精确发布许可；证据等级与正文不能由客户端填写。圈内 evidence/search/updates 只返回获准字段，源变更使旧卡与游标失效。隐私边界、去重和等级门槛见 [T11 说明](network-t11.md)。


T12 的 `/members/network/workbench` 汇总本人私有任务、询价、草稿和发布状态。`/members/network/inquiries/:id` 与 `/members/network/tasks/:id` 复用原对象与 TaskService，会员会话只能读自己的记录。网页可在 CSRF／Origin 和显示版本校验后回复原任务补问；不会批准执行或把 cookie 当作 MCP/A2A 凭据。Agent 继续使用已有任务工具与原 taskId。详情及 T13 未完成的实测门槛见 [T12](network-t12.md)／[T13](network-t13.md)。


个人美团采用[会员自有账号授权](member-source-authorization.md)：各会员 PA 通过独立 HTTP 通道提交本人 Token，MCP 仅提供连接发现／状态／发起／撤销／原任务恢复工具。新增 sources:read、sources:write；身份来自已验签的 JWT 与安装登记。凭据在业务库专用表加密保存，不进入 Task／模型／会员会话库。服务目录可见，查询执行仍需买方自己的有效连接。采用 v8 AgentRuntime 的 delivery.quote@3、address.book.read@2，复用原任务、授权、官方 CLI 和来源回执。模型选择三个独立读取动作及完成依据；详见 [美团 Agent 动作](paotui-agent-actions-2026-10-19.md)。能力默认关闭、只限非生产 loopback HTTPS；旧单会员操作人连接是互斥兼容模式。
