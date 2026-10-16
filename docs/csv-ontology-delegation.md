# CSV 审计：A2A 委托、Ontology/OAG 与独立验收

## 当前范围

`eigos.delegate` 已扩展为注册能力接待路径，CSV 是其中一项，另外支持 brief.prepare。用户明确选择 EIGOS 后，可以直接发送 A2A 文本目标；PA 不必选择审计内部函数。协调模型的能力上下文来自 `packages/ontology/csv-audit.ts`，只允许计划配置目录内的 CSV 审计。

本轮实现的是一个有边界的领域闭环：真实模型做能力判断和补问，真实本地 CSV 文件被审计，固定程序独立验收。付款、补交与退款账本属于本地模拟；没有真钱、支付宝客户端或外部供应商发现。不是通用采购、任意本体推理或全网 Agent 搜索系统。

## 模块与真实约束

- `packages/ontology/csv-audit.ts`：版本、对象／关系、动作、输入限制、检查项和计划类型。
- `packages/coordinator/coordinator.ts`：通用候选选择与补问；`packages/capabilities/pilot/capability.ts`：CSV 输入检查、绑定计划和授权。
- `packages/capabilities/executor.ts`：复用受限 Codex JSON 运行器，工具／浏览器／插件关闭。协调器仅获得对话与业务定义，不得到原始 CSV、入站凭据或任意工具。
- 既有 CSV producer：执行缺失值、重复 ID、邮箱／金额／日期格式检查。
- 既有 independent verifier：独立解析原始字节并重算检查结果，验证订单／输入哈希与 Markdown，防止生产报告的函数自己判定成功。

执行前由程序检查本体版本、计划摘要、规则版本、检查项、动作集合、原始文件哈希和授权的报价摘要。模型不能通过输出新动作或“用户已同意”来绕过这些检查。验收失败最多补交一次，持续失败进入模拟退款／待复核；不会交付失败报告并称为完成。

输入仅允许 UTF-8 CSV、1–1000 条数据记录、最多 1 MiB／32 列。必需列为 `record_id,email,amount_cny,event_date`；额外列只解析、不审计。输入以快照固定，后续文件变化不改变已报价的输入。需审计新内容时创建新任务。

## 配置

在本地开发配置中开启：

```dotenv
EIGOS_AUTH_MODE=development
HOST=127.0.0.1
EIGOS_COORDINATOR=codex
EIGOS_CSV_PILOT=true
EIGOS_CSV_INPUT_DIR=/absolute/path/to/dedicated-inputs
```

还需开发令牌、同一数据库文件，以及 Worker 上已登录的 Codex CLI。`EIGOS_EXECUTOR` 控制旧文档生成器，与新协调器开关分开。CSV 能力只允许本地开发身份；brief.prepare 不依赖 CSV 配置。本文的实例仍为本地验证，未对公网部署。正常启动仍为 `npm run dev` 或分别启动 Gateway／Worker。

## A2A 交互

`SendMessage` 的文本新请求在协调器开启时进入 `eigos.delegate`；未开启时保留原有行为。结构化 EIGOS 请求也可明确指定该 service。新任务返回 `SUBMITTED`，领取后进入 `WORKING`；模型可能请求文件名并返回 `INPUT_REQUIRED`。补充信息用同一 taskId、新 messageId。

CSV 检查通过后返回 `AUTH_REQUIRED`；brief.prepare 只生成说明，不走模拟付款。`metadata.delegation` 包含本体版本、评估和计划；`metadata.pilot` 包含与计划／输入绑定的模拟报价。模型判定不支持的目标返回 `REJECTED`，不会自动转成文档生成。输入缺失／非法时请求修正，尚无模拟付款。

A2A 的阻塞请求（未设置 returnImmediately 或设为 false）现在等待实际终态／中断态，模拟服务也同样等待。五分钟等待上限或 Gateway 关闭时返回错误，任务继续保留；不再以成功响应返回仍处于 WORKING 的任务。长任务应显式使用 `returnImmediately: true` 并查询。

Agent Card 使用 A2A 1.0 的规范 JSON 序列化；认证字段不会暴露 SDK 内部的 `scheme.$case` 表达。

## 通过独立通道确认模拟计划

这是 EIGOS 应用接口，不是新增 A2A RPC。它遵循 A2A 的任务内授权由独立安全通道取得的方式；客户端需要明确了解这一接口。连接成功不等于已批准任务。

```text
POST /tasks/{taskId}/authorize
Authorization: Bearer <与任务相同身份的令牌>
Content-Type: application/json
```

```json
{
  "action": "confirm_simulated_payment",
  "requestId": "stable-authorization-request-id",
  "quoteId": "从任务返回的报价编号",
  "quoteDigest": "从任务返回的报价摘要"
}
```

此接口只批准绑定的本地模拟流程，不移动真实资金。要求 tasks:write；普通 A2A 聊天“yes”不会批准计划。错误的摘要、过期报价、被修改的计划或其他用户任务会拒绝。重试保留原 requestId 和完整内容。拒绝计划可取消任务；本轮不支持在等待授权状态下直接改报价，需求变化应取消后新建。

已有足够明确的用户授权可以使用，无需重复询问；未覆盖实际文件、范围或报价时必须向用户确认。授权后回到 WORKING，独立验收通过才 COMPLETED。完成／失败／拒绝／取消任务不能重新开始。

## Grok 一次配置与复用

可复用包在 `integrations/grok/eigos-delegate/`，含技能说明与 Python 标准库客户端。地址与凭据引用保存在私有 profile；凭据不会写入技能正文或请求消息。客户端默认只允许 eigos.delegate，固定同源并拒绝重定向。生产 OAuth 登录／刷新尚未由此客户端实现。

在 Grok 实际运行请求的电脑上配置一次：

```sh
python3 /path/to/eigos_a2a.py --config /private/profile.json configure \
  --card-url http://127.0.0.1:3421/.well-known/agent-card.json \
  --token-file /private/token --allow-loopback-http
```

将 SKILL.md 保存到 Grok 技能库，并记录实际电脑、脚本和 profile 的绝对路径。后续用户点名 EIGOS 时执行 discover，依照 Card 匹配当前范围，然后 send／poll／reply／authorize／get。循环不会把轮询间隔结束当作任务失败。

本机联调配置位于 Git 忽略的 `data/grok-oag/`；其服务启动命令为：

```sh
node --env-file=data/grok-oag/server.env scripts/run-local.mjs --built
```

只有这台 Mac 可访问该 loopback 服务；Grok 必须在已连接的用户 Mac 上运行客户端。配置持久化不等于服务自动开机启动。该命令的前提是先 `npm run build`；关闭后用同一命令恢复，保留 profile 和任务库。

## 验证界限

自动测试使用协调模型替身检验状态机、防重、输入／计划篡改保护、补交／退款和阻塞语义；真实 Grok 与真实模型证据应单独归档。仅看到配置成功、Card 或 Task COMPLETED 不能代替服务端输入哈希、模型收据、独立验收以及客户端交付物逐字比对。

2026-10-15 已完成两次真实 Grok 委托，含首次补问和后续配置复用；三次真实协调模型调用、两次报告独立验收、客户端／服务端交付物逐字一致。见 [完整实测证据](evidence/grok-oag-2026-10-15/README.md)。

注册与通用选路的当前实现见 [可注册能力](registered-capabilities.md)。
