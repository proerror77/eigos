# A2A 1.0 协议核对与 EIGOS 接入边界

核对日期：2026-10-15。基准为项目当前使用的 A2A 1.0，而不是 0.3 示例。本文记录规范与本项目实现的区别，不代表 Grok 可复用接入已完成。

## 规范规定什么

| 对象／操作 | 规范含义 | EIGOS 的处理 |
| --- | --- | --- |
| Agent Card | 描述身份、协议接口、认证方式、可选协议能力和业务 skills | 从已启用服务生成，不发布未来能力 |
| AgentSkill | `id`、`name`、`description`、`tags`；可选 `examples`、`inputModes`、`outputModes`、`securityRequirements` | 说明任务范围、输入背景、交付物、限制；它不是工具调用参数 schema |
| SendMessage | 发送消息以发起或继续交互；标准请求没有 skillId／service 必填项 | 文本请求和结构化 data 请求是两个入口；`data.service` 是 EIGOS 自定义约定 |
| Message／Task | 服务端可以直接回复 Message，或创建有状态 Task | EIGOS 当前总是返回 Task，这是允许的实现选择；不能要求任意 A2A 服务都这样做 |
| taskId／contextId | taskId 指定正在继续的任务；contextId 关联一组交互 | 缺信息时继续原任务；终态后不能把原任务重新变为 working |
| INPUT_REQUIRED／AUTH_REQUIRED | 两种中断状态，分别请求补充信息与授权 | 当前 EIGOS 业务层只实现 INPUT_REQUIRED；通用客户端必须识别两者 |
| Artifact | 实际输出交付物 | 文档完成只表示文档交付，不表示文档中描述的外部业务已执行 |
| GetTask／Streaming／Push | 查询与可选更新机制 | 当前只支持查询，Card 如实声明另外两项关闭 |
| messageId | 消息标识；服务端可以据此实现幂等，但协议不保证所有发送自动幂等 | EIGOS 已实现同身份、同动作的收据防重；客户端重试必须保持内容及 ID |
| 认证 | 从 Card 了解要求，通过协议外流程获得凭据，并在请求中使用 | Card 本身不授予权限；配置一次地址不等于永久令牌或自动完成 OAuth 刷新 |

## Card 与 Grok 技能的区别

A2A `AgentSkill` 是服务端对外的能力说明，帮助调用方判断适配性。Grok 保存的技能／`SKILL.md` 是客户端如何发现、认证、提交、跟踪和转交补问的操作说明。前者不要求安装后者；后者只是针对当前 Grok 没有确认原生 Card 配置入口的一种接入适配。

同样，协议不要求客户端了解 EIGOS 内部 Worker 数量、业务连接器或执行计划。内部路由、模型选择、业务验收和供应商调用由 EIGOS 自行实现。

## 当前实现核对所得

1. Card 的接口声明、版本 `1.0`、JSONRPC 绑定和标准 skill 字段方向正确。旧版固定 task-brief 标签和统一示例不足以表达各项能力，正在改为服务自身的说明。
2. `data.service`、`goal`、`datasetId`、`answer` 等是 EIGOS 的应用数据契约。应在接入文档明确描述，不能声称它们是 A2A 标准字段。
3. `returnImmediately=false` 或省略时，标准要求等待到终态或中断态。当前 TaskService 的五分钟超时返回 working，以及模拟服务立即返回 working 的路径，不符合这一阻塞语义，需要修正为明确错误／持续等待，不能静默当作正常阻塞结果。
4. 新写的 Python 客户端仍是未验证草稿；它固定采用 EIGOS 的结构化任务契约，不应称为通用 A2A 客户端。其任务型响应、同源地址限制和服务 allowlist 是客户端／EIGOS 的选择，不是 A2A 强制要求。
5. “让 Grok 配置一次”还需验证技能持久保存、服务可达、认证可续用、补问和恢复查询；读到 Card 并不证明上述用户流程已经完成。

## 对本次工作的约束

先维护诚实、标准格式的 Card。继续使用标准 SendMessage／GetTask／CancelTask，不添加自造 RPC 方法。将 EIGOS 的结构化输入与客户端接入策略明确记录。Grok 实测只在已有授权的本地环境执行，验证应包括补问、任务续接和交付读回；不得把客户端脚本测试写成 Grok 原生 A2A 支持证明。

## 官方依据

- [A2A 1.0 规范：AgentSkill](https://a2a-protocol.org/v1.0.0/specification/#445-agentskill)
- [SendMessageRequest 与配置](https://a2a-protocol.org/v1.0.0/specification/#321-sendmessagerequest)
- [幂等语义](https://a2a-protocol.org/v1.0.0/specification/#331-idempotency)
- [Agent Discovery](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [Life of a Task](https://a2a-protocol.org/latest/topics/life-of-a-task/)

## 后续实现状态

本文件保留核对时的问题记录。2026-10-15 后续已修正阻塞语义和 Card 规范 JSON 序列化，增加 CSV 本体委托与独立授权接口；客户端已通过两次真实 Grok 委托验证。最新实现范围见 [CSV 本体闭环](csv-ontology-delegation.md)及[实测证据](evidence/grok-oag-2026-10-15/README.md)。此前“草稿／未安装”是当时状态，不是当前结论。
