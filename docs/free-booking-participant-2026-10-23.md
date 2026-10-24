# 免费活动报名、通用预约与可选支付

2026-10-23 初始实现使用 `ontology-execution-v16`、`eigos.business@16`。2026-10-24 与原常驻 v18 的规划及 PA 客户端更新整合，当前执行契约为 `ontology-execution-v19`，业务模型仍为 `eigos.business@16`；历史验证保留其原运行身份。

## 交付与接入范围

`RegistrationTask`、`RegistrationOffer` 和 `RegistrationRecord` 支持活动报名及通用预约。任务固定目标、公开服务链接、参与者数量和明确提出的起止时间；来源提供费用、条款、资格及具体报名状态。调用仍经 `eigos.delegate`，由现有 Worker 的 Ontology + LLM 循环选择原子动作，没有第二套业务规划器。

当前真实提供者是 **Luma 普通参与者网页**。它通过本机浏览器操作代理执行，要求本人账号已登录且操作代理在线；不是无人值守连接器或已上线的公共服务。通用预约模型经合成来源验证，尚未接通其他真实预约平台、日历写入、改期或外部取消。

Luma 官方 [MCP](https://help.luma.com/p/mcp) 可供普通账号连接，其公开文档主要列出发现、参与事件查询与有权管理的活动操作，没有列出普通参与者对任意活动的报名工具。官方 [API](https://docs.luma.com/reference/getting-started-with-your-api) 要求 Luma Plus；[添加嘉宾](https://help.luma.com/p/inviting-and-adding-guests-to-your-event) 是主办方管理能力，不能冒充参与者报名。本次不购买订阅、不使用私有 API 或导出浏览器凭据。

## 目标、状态与支付

| 委托目标／来源状态 | 处理 |
| --- | --- |
| `completionTarget=submitted` | 必须独立回读到原报名的有效提交回执；仍可明确报告待审核或候补 |
| `completionTarget=confirmed` | 必须回读到 confirmed、确认依据及匹配的参与者、活动与时段 |
| submitted、pending_approval、waitlisted、unknown | 确认目标继续保持进行中，由模型选择等待后查询原记录 |
| rejected、canceled、expired | 报告该结果；不冒充参加资格或自动重报 |
| 仅点击按钮、来源接收排队或本地 Task 成功 | 均不构成报名确认 |

`payment.requirement=not_required`、完整总费用为 0、来源条款明确且无额外同意事项时，免费路径直接提交并独立回读，无钱包或付款请求。缺少费用或出现付款／协议要求时停止该提交。浏览器操作代理必须在最终提交前核对当前页面；不能为了完成联调编造表单资料。

已有预约程序升级为 `booking.pa-payment.sandbox@3`。明确 `paymentRequirement=not_required` 且完整价格为 0 的预约，只需原预约独立确认；付费预约继续使用原 PA 付款交接和付款／预约双重回读。缺失该新字段沿用原付款要求，未知要求不能自动发起付款；把金额改为 0 本身不会跳过核验。

## 原子动作与权限

| 动作 | 效果与边界 |
| --- | --- |
| `InspectRegistrationPage` | 读取当前来源页、公开票种、时段、条款和已登录参与者状态 |
| `SubmitFreeRegistration` | 准确的零费用参与者预约；只允许本机本人配置的真实来源 |
| `SubmitFreeRegistrationSandbox` | 同样的业务语义，但仅用于显式沙箱测试提供者 |
| `ReadParticipantRegistration` | 重新打开原活动页，独立读取同一报名，提交回执不能代替此动作 |
| `WaitForRegistration` | 持久保存原报名上的有界等待，不创建新报名或付款 |

真实动作在既有授权接口使用 `approve_plan` 与 `environment=live_free`。许可固定计划摘要、作用 `reserve`、金额 0、服务主体和有效期。每次派发重查，浏览器桥接在操作代理领取实际提交前再次读任务库和原许可；取消、撤销、变更、过期均阻止未派发操作。这项路径没有 `order`、`payment`、改期或取消效果。

源操作在独立持久队列按原操作键保存。排队／进行中按有界退避查原键，不计入相同失败次数；明确拒绝按拒绝处理，未知结果不重新提交。晚于取消或失效租约的结果只保留审计，不投影新的业务完成。任务取消仍不代表 Luma 已有报名被取消。

## 本机配置与操作代理

Gateway 和 Worker 使用相同的四项显式配置：

- `EIGOS_FREE_BOOKING_BRIDGE_URL`：仅接受 `http://127.0.0.1:<port>`。
- `EIGOS_FREE_BOOKING_TOKEN_FILE`：Worker 私有令牌绝对路径；Gateway 不读取。
- `EIGOS_FREE_BOOKING_BINDING_ID`：固定的本人 Luma 账号绑定。
- `EIGOS_FREE_BOOKING_ATTENDEE_SHA256`：已登录邮箱规范化后的 SHA-256；原邮箱不进入本体或协议结果。

未配置时不发布该能力。需要 development 身份、非生产和 loopback；来源桥接另有独立操作代理令牌，模型不能提交浏览器观察结果。核心通用预约 URL 合同为不含凭据的 HTTPS 链接；Luma 连接器另外检查 Luma 域名及公开活动路径，不跟随任意来源 URL。

常驻管理可使用 `EIGOS_FREE_BOOKING_BROWSER_CONFIG` 固定私有 `browser.json`，由 `setup:pa` 校验并保留来源绑定，并由同一启动器管理独立浏览器队列进程。任务库必须准确指向该常驻实例，来源队列必须独立；部署不导入旧临时任务或重报活动。配置、启停和回读规则见 [常驻部署说明](gateway-worker.md#免费报名与预约来源)。

构建后用 `scripts/free-booking-browser.mjs setup /absolute/private/session` 初始化专用私有会话。账号邮箱由 `EIGOS_PARTICIPANT_EMAIL` 环境变量提供，只保存其摘要。生成的会话含专用任务库、来源队列、两个私有令牌、`gateway.env` 与浏览器证据目录，须放在忽略目录或仓库外。

运行 `serve` 启动本机来源桥接；Gateway 和 Worker 使用该会话的 `gateway.env` 分开启动。操作代理用 `next` 读取原子请求，`dispatch <original-key>` 在操作前核对原许可，完成实际浏览器操作后用 `resolve <original-key> <result-file>` 返回当前页面观察和证据文件；任何外部未知结果都不得再次点击提交。实际浏览器可由授权的 Codex Computer Use 操作，桥接自身不读取 Chrome 的 Cookie、会话数据库或其他页面。

每次来源观察留存当前页面文字与截图的 SHA-256，原文件仅留私有目录。报名提交与独立查询分别有自己的操作及来源回执。`live_operation` / `live_readonly` 表示授权浏览器观察，不是 Luma 签名 API 证明；本地测试始终保留 synthetic。公开归档仅使用已检查、去个人资料的验证摘要。

## 验证

新增测试覆盖两个业务类型、提交与确认目标、待审核／候补、未知费用、额外同意事项、异步排队、明确拒绝、原键防重、取消和跨环境权限；MCP／A2A 测试比较同一 Task 的交付物与本体回读。已有付费预约测试继续验证付款及预约双重确认。

`examples/verify-free-booking.ts <private-session> <original-task-id>` 只读核对实际模型、MCP、A2A、持久任务库、原预约动作、完整零费用及独立确认。它不报名或创建替代任务。真实联调结论另存于对应的 `docs/evidence/` 记录，不以合成测试代替。
