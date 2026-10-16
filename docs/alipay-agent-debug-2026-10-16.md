# 支付宝已订阅 Agent 调用排查与平台报障

日期：2026-10-16。范围：核对正式调用入口、请求schema、版本和认证/订阅关系，尝试无个人信息、无付款的真实交互；必要时联系平台。结果：**尚未取得业务回答；已通过官方公开AI联系邮箱提交技术问题，邮件发送状态已读回为SENT。**

## 本轮确认与修正

1. 登录恢复后，订阅详情再次显示“厦门落户通”订阅中，资源AI100000000002059049，外部URL仍为 `https://opengw.alipay.com/api/v1/open/agents/dmdzfoesbnlsmzam`。页面“API Key 设置管理”跳转至AI服务应用列表。端点来源正确，但这不等于已经掌握完整调用契约。
2. 当前A2A规范推荐Major.Minor版本头；本轮改传0.3，网关明确拒绝，traceId `21d3d06117921147566956063edb09`。因此不能仅凭标准规范把0.3视为这个支付宝实现的可用版本。
3. 对照官方固定v0.3.0 JSON schema发现，上次请求遗漏了Message必填的 `kind: message`。该遗漏已补齐；沿用网关未报版本不支持的0.3.0，仍返回HTTP200、JSON-RPC -32603“系统内部错误”，traceId `21d0d2a317921154586718498ef1a1`。
4. 再使用schema明确支持的contextId、空metadata、extensions/referenceTaskIds和blocking配置，仍失败，traceId `21d817e117921156907234005eaaae`。没有把HTTP200当成成功，没有循环重复同一输入。
5. 官网“CLI工具/阿宝”说明主要覆盖商家MCP关联、Skill生成、预览及上架，是供给侧路径。官方onboarding包核验下载哈希后只读检查，未发现本次外部Agent调用契约；没有安装或执行其中业务脚本。
6. 公开A2A规范能核对标准schema，但不能代替支付宝对Authorization格式、APPID/空间订阅绑定和上游扩展的确认。当前仍不能证明Bearer前缀是平台要求的完整格式，也不能把内部错误唯一归因于平台故障。

## 证据与官方来源

- [修订版本头的响应](evidence/alipay-agent-debug-2026-10-16/version-major-minor.json)
- [补齐Message.kind的请求与响应](evidence/alipay-agent-debug-2026-10-16/required-message-kind.json)
- [完整标准字段的请求与响应](evidence/alipay-agent-debug-2026-10-16/full-schema-defaults.json)
- [A2A v0.3.0 Message定义](https://a2a-protocol.org/v0.3.0/specification/#64-message-object)
- [官方v0.3.0 JSON schema](https://raw.githubusercontent.com/a2aproject/A2A/v0.3.0/specification/json/a2a.json)
- [当前A2A版本协商规范](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
- [支付宝自研智能体开发指南](https://opendocs.alipay.com/ai/0jb1nq?pathHash=ca854f82)
- [平台官方CLI入口](https://open.alipay.com/ai/ai-resource-center/cli-guide/abao?spaceId=2026101502102043600019445)

## 提交平台

技术支持网页及后续控制台页面出现连续浏览器加载/CDP超时；停止该重试路径，改用已连接邮箱发送。收件地址 `alipay.ai@service.alipay.com` 来自[ACT官网公开联系信息](https://www.act-protocol.com/)；它是AI联系渠道，不声称为已确认的A2A专属工单系统。邮件明确请求转接AI开放平台/A2A网关团队。

- 发件人：proerror@gmail.com（已连接账号，发送前读取profile确认）。
- 收件人：alipay.ai@service.alipay.com。
- 主题：[EIGOS] 已订阅智能体外部 A2A 调用 -32603：请确认请求格式与授权（APPID 2021007109677510）。
- 发送时间：2026-10-16 09:55:50（Asia/Shanghai）。
- Gmail message/thread ID：`1a1426c34d0e7707`。
- 发出后metadata读回：`label_ids: [SENT]`，收件人和主题一致。只确认发件成功，不宣称对方已收到/已立工单/已处理。
- 已发送正文（本地 `output/alipay-agent-debug-2026-10-16/support-email.txt`，含联系信息，未纳入版本库）。包括应用/资源/空间标识、确切端点、脱密Header、完整请求正文、六个trace参考和具体问题。**无API_key、私钥、Cookie或访问令牌。**

请平台确认：正确调用入口及官方SDK/最小成功示例；Authorization准确格式和额外Header；EIGOS应用API_key与订阅资源是否需额外绑定；协议版本/method/schema/SSE支持；授权映射、路由与目标Agent运行状态。

本次只读核对和无资金测试，没有修改EIGOS运行代码、没有创建新的凭证、没有付款。曾尝试订阅官方免费诊断MCP以查看客户端示例，但未观察到订阅成功；浏览器故障后无法完成状态读回，不能计作新增已可用资源。

结论边界：上次请求有可证实的schema缺项，本轮已修正但未解决。下一步依平台正式契约或trace诊断修正接入，而不是继续把供应商文档、资源订阅或网关错误响应当作阿宝调用成功。

## 发件身份更正：已从公司飞书邮箱重发

用户指出业务邮件必须使用公司邮箱，并明确授权重发及记住该偏好。实时读取飞书邮箱profile确认主地址为 `sonic.shih@mandonothing.com`，随后显式指定该from/mailbox，以user身份发给 `alipay.ai@service.alipay.com`。

- 新主题：[EIGOS] A2A 调用报错排查（请回复公司邮箱）。
- 正文开头说明接续此前个人Gmail来信，后续请统一回复公司邮箱，不再回复个人Gmail；原问题、请求示例及traceId保留。
- 飞书message/thread ID：`ZWVkYmQ5OTUtMWJjMC00ODUyLWI1ODktNDZlZGIxOTgyZDE0`。
- 发送后读回from为公司地址、to为官方AI联系邮箱、folder为SENT、message_state为sent。
- send_status 对该收件人返回 `status:4`（投递成功）；不等于对方已阅读或处理。
- 公司邮箱重发正文（本地 `output/alipay-agent-debug-2026-10-16/support-email-company.txt`，含联系信息，未纳入版本库）。

用户偏好已通过指定记忆入口记录：今后所有对外业务邮件使用公司飞书邮箱；不可用时停下说明，不自动改用个人邮箱。未撤回或删除此前Gmail邮件。

## 公司邮箱首封回复与跟进基线

2026-10-16 11:56，alipay.ai@service.alipay.com 回复公司飞书邮箱。message_id：QXNrMnY2ZnVrenBaNmdaVHpiVlhBZkJLYkw0PQ==，同一公司邮件thread。内容建议查看 https://aipay.alipay.com，并请留下联系电话以安排深入沟通；未提供请求格式、认证/授权要求或trace排查结论。原公司邮件已包含联系电话。

已读此条作为监控基线；无新的技术前提，因此未重复发起失败接口请求，也未自动发送回复。用户已请求持续留意公司邮箱，收到可用技术信息后继续无付款验证。

## 用户授权的需求澄清与排程取消

随后用户明确授权使用公司飞书邮箱回复：需要阿宝面向外部 Agent 的服务发现、选择、任务执行和结果回读能力，不只是支付或商家上架；询问正确接入入口、文档、授权要求及技术对接人，仍不涉及付款。已在原线程回复，message_id `ZjlhYzQyZDAtZjllYy00ZDNkLWIyMWUtN2M4YjZhNWNlMDFk`，send_status 对官方收件人返回 `status:4`（投递成功）。这不等于平台已确认接入资格。

按用户要求，每小时邮箱检查任务 automation-3 已删除。后续研究为用户单独授权的主动核对，不再有定时检查。阿宝／AHA 的进一步官方资料核对见 [外部 Agent 接入研究](abao-external-agent-research-2026-10-16.md)。
