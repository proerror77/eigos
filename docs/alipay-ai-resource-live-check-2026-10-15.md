# 支付宝 AI 资源真实接入核验

核验日期：2026-10-15。用户授权创建 EIGOS AI 服务应用、订阅免费资源并验证调用；另明确同意生成 API_key 并私密保存。没有充值、付费订阅、下单付款或真实身份/落户申请。

## 已完成

- EIGOS AI服务应用：APPID `2021007109677510`。创建后由审核中转为**已上线**，实际页面读回确认。
- API_key：用户完成短信验证，页面显示已启用。私密存于用户配置目录（仓库外），文件权限0600，目录0700；API_key不写入本文或请求证据。到期时间按平台显示为 **2026-10-23 18:02:13**（界面日期）。
- 官方免费“支付宝支付集成Skill”已订阅，我订阅的列表读回1项。资源包 `99210300001000032882`，子资源 `AI300000000000132825`。只提供技能包下载，不能当成远程调用完成。
- 免费智能体“厦门落户资格诊断”已订阅，管理页名称“厦门落户通”，提供方王佳豪，资源包 `99210300001000401942`，资源 `AI100000000002059049`，智能体ID `202609APooOv22646581`，版本0.0.1。
- 智能体订阅详情明确支持“URL+API Key”方式，显示外部地址 `https://opengw.alipay.com/api/v1/open/agents/dmdzfoesbnlsmzam`。这是实际官方平台提供的地址，不是猜测端点。

截图：[应用已上线](eigos-alipay-app-online-2026-10-15.jpg)、[Skill订阅成功](alipay-free-skill-subscribed-2026-10-15.jpg)、[智能体订阅与外部调用](alipay-agent-subscribed-call-url-2026-10-15.jpg)。

## 实际调用结果：尚未成功返回业务回答

测试问题仅要求介绍能力范围和输入字段，明确“不判断任何人的资格、不执行申请、不索取个人信息”。未传用户姓名、手机号、证件号或业务资料。API_key仅发送给详情页显示的支付宝官方网关，未直接发送到第三方域名。

正式页面给出外部 URL、API_key 和 A2A/SSE 方向，但所读文档未提供完整请求示例。因此进行有界标准协议兼容性测试，保留错误，不把探测报文描述为平台明确确认的完整契约。

| 请求 | 真实响应 | 结论 |
| --- | --- | --- |
| GET 详情页给出的URL（无凭证） | HTTP405 | 该地址不接收普通GET |
| 标准message/send，无版本头 | JSON-RPC -32602：A2A protocol version is missing | 必须声明版本 |
| A2A-Version 1.0，SendMessage | -32602：Unsupported A2A protocol version. upstreamVersion=1.0 | 本次网关明确拒绝1.0 |
| A2A-Version 0.3.0，message/send，Bearer API_key | -32603：系统内部错误 | 没有业务回答，不能确认端到端成功 |
| A2A-Version 0.3.0，message/stream，Bearer API_key | -32603：系统内部错误 | 流式方式也未完成 |
| 同一0.3.0请求，不带Authorization（负对照） | -50001：Authorization is required | 带凭证与不带凭证返回不同，仍不证明完整资源授权/业务执行成功 |

以上 JSON-RPC 错误响应的 HTTP 状态均为200，不能以 HTTP200 统计成功。0.3.0 未返回“不支持版本”，但不能仅据此断言完整兼容性。

可供官方排查的 traceId：

- 普通0.3.0调用：`2188d1e417920588875158993e91a8`
- 流式0.3.0调用：`0b2536c317920589106264410e641d`
- 无凭证对照：`0b44079717920589468416627e1d17`

[原始脱密请求与响应](evidence/alipay-agent-call-2026-10-15/a2a-v03.json)、[流式错误](evidence/alipay-agent-call-2026-10-15/a2a-stream.json)、[负对照](evidence/alipay-agent-call-2026-10-15/no-key-control.json)。服务方/平台需确认当前 Agent 的完整请求契约、订阅授权映射及上游路由/服务状态；现有证据无法确定唯一根因。未做重复扣费或无限重试，未绕过平台权限。

## 对“是否要申请智能体/MCP交互”的回答

通用平台权限、AI应用与API_key已就绪；具体智能体的订阅也已落地。下一步已经从“申请通用资格”进入“具体资源调用联调”。上述内部错误不直接说明还缺一个申请，需凭traceId确认。阿宝/AHA整体任务委托仍是独立资格，本次第三方免费Agent不是阿宝。

官方依据：[自研智能体开发指南](https://opendocs.alipay.com/ai/0jb1nq?pathHash=ca854f82) 的“A2A网关调用说明”明确API_Key/RSA2认证、订阅鉴权和SSE返回；[已订阅资源详情](https://open.alipay.com/ai/ai-resource-center/agent/AI100000000002059049/ordered?tab=subscribe&spaceId=2026101502102043600019445&agentVersion=0.0.1) 提供实际调用URL。
