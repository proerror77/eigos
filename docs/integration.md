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

六类服务扩展复用这些接口和权限。运行契约为 `ontology-execution-v6`、模型为 `eigos.business@4`；新增领域默认没有真实来源绑定，显式注入的提供者只用于本机沙箱。Action 定义／模型提案不产生真实业务许可。新类型、状态、运行方式和接口缺口见 [六类服务说明](service-domains-2026-10-18.md)。

同类要求可带所选能力声明的 `role`：例如酒店 `room_count`／`guest_count`、打车 `pickup`／`arrival`、租车 `service_total`／`deposit`。模型保留各自原话与来源；校验只使用相应角色的事实，缺证据保持 unknown。未带 role 的要求保留原有单一语义，不自动匹配其他角色。v5 及更早计划只读，不自动迁移或恢复执行。修复及真实模型证据见 [六类验证](service-domain-validation-2026-10-18.md)。

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

## 邀请制网络接口（默认关闭）

T06–T10 的协作功能复用 JWT/会员身份，另需明确网络准入和 `network:read` / `network:write`。网络写入还需控制者将具体安装绑定到稳定 profile；有任务权限不自动获得网络权限。批准只接受会员会话、同源 Origin 和 CSRF，不提供 bearer/MCP 批准动作。

HTTP：`POST /network/v1/query`、`/commands`、`/receipts/get`；MCP：`network_query`、`network_command`、`network_get_command`。需求、结构化回应和一跳服务推荐共用草稿→精确批准→发布，关闭需求使用 `need.close`。查询使用 need/messages/search 判别输入，具体字段和版本规则见 [T08 接口](network-t08.md)。

这些记录不进入 A2A Task，不调用模型或服务商，也不更改私有要求和授权；从网络线索转换为私有询价属于后续 T10。圈内页面沿用相同受众过滤。网络开关默认 false，本轮未部署或开放真实交易。

T09 增加 `POST /network/v1/updates` / MCP `network_updates`，返回当前授权动态与分页 cursor/增量 checkpoint。`follow.set` 需要新的安装绑定权限 `follow.manage`，`my_follows` 仅本人可读。关注不扩大受众，游标失效返回 CURSOR_STALE 和 resetRequired；恢复、去重、15 分钟有效期与缓存清理规则见 [T09 接口](network-t09.md)。动态读取不启动模型或业务动作。

T10 增加 inquiry.request_conversion/convert 与 inquiry.request_selection/select_quote，要求 inquiry.manage 安装权限、网络与任务 scopes，并消费会员会话确认的准确 choice。my_inquiry 按 owner 恢复 Task，my_selection 只读本人选择快照。来源只限已审核且实际获权的既有只读报价绑定；普通回复、社交推荐和模型方案都不能授予转换或交易权限。完整参数、确认界面、恢复与报价限制见 [T10 说明](network-t10.md)。
