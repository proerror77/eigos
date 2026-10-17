# 生活服务发现与需求转交

本阶段让 PA 发现 EIGOS、转交原始目标、获得持久任务回执。购物、酒店、机票、跑腿、外送、家政等需求都可登记；尚未接入这些服务的供应商执行。不是商品、房票查询或通用履约能力。

## 简短入口与执行边界

设置 `EIGOS_LIFE_INTAKE=true` 后，MCP `list_services` 与 A2A Agent Card 公布一个 `life.request`，按服务领域说明接收范围，不为每种商品、航线或服务动作增加条目。默认关闭，既有环境不自动启用。

此入口不调用协调模型或供应商。PA 识别委托意图并实际转交，EIGOS 保存原目标、任务归属和防重收据。真实规划及供应商执行是后续独立工作。

MCP `submit_task` 示例：

```json
{"service":"life.request","goal":"周末去杭州住两晚，帮我安排酒店。","requestId":"stable-handoff-id"}
```

可选 `domain` 是调用方提供的提示，不代表已完成模型分类或取得业务权限。日期、地址等缺项不阻止初次登记；不要提交凭据、证件或无关个人信息。

A2A `SendMessage` 的单个 data part 接受同样字段，messageId 作为幂等键。启用本入口且未启用协调器时，普通 text part 也可登记；已有协调器继续优先处理普通文本。客户端设置 `defaultService=life.request` 时用显式 data part 避免默认路由差异。

返回标准 `TASK_STATE_SUBMITTED`，及 EIGOS 自定义 `metadata.intake`：

```json
{"acceptedFor":"intake_only","status":"waiting_provider","execution":"not_started","businessCompleted":false,"automaticExecution":false,"nextAction":"await_provider_integration"}
```

`waiting_provider` 不是 A2A TaskState。它表示提供方尚未接入，不是供应商接单或执行中；不承诺自动恢复执行、处理时限或通知。任务不进入 Worker 领取，同步 A2A 提交也立即返回登记回执。

两种协议共用原有会员资格、scope、归属、持久化和防重机制。可查询、在同一任务补充信息或取消登记；原目标不被补充覆盖。取消登记不表示取消供应商订单。调用方不能伪造所有者、完成状态或执行结果；此服务没有业务执行授权端点。

## Grok 按意图触发

`integrations/grok/eigos-delegate/SKILL.md` 按生活服务意图触发，无需每次点名 EIGOS。Grok 必须先 discover，再实际发送原目标，并根据任务编号报告“转交成功”。普通问答、写作和讨论不自动登记；用户明确拒绝使用 EIGOS 时不得转交。

Python 客户端新增可选默认服务；旧配置仍默认 `eigos.delegate`，保留 CSV 兼容。生活请求 poll 返回 `handoffAccepted=true`、`businessCompleted=false`、`resumeRequired=false`，不无限等待未接入的供应商。

## 本机常驻验证

```sh
npm run build
npm run setup:grok-life
```

仅用于 macOS 上本人 Grok。脚本创建独立 loopback 服务 `127.0.0.1:3430`、随机开发凭据和专用任务库，不修改 `.env`、Auth0、CSV profile、跑腿授权或其他服务。

- Profile、凭据及安装技能文件：忽略目录 `data/grok-life/`，私有文件 `0600`。
- 实际构建、任务库、审计、日志：`~/.local/share/eigos/grok-life/`，目录 `0700`；`runtime-location.json` 保存路径而不保存凭据。
- `~/Library/LaunchAgents/com.eigos.grok-life.plist` 登录时启动，异常后恢复。Mac 关机、休眠、断连或退出登录仍会影响可用性。
- 在用户数据目录运行快照，避免依赖桌面应用的 Documents 授权。源码更新后，构建并运行 `node scripts/setup-grok-life.mjs --restart` 更新快照。
- Grok 读取 `~/.local/share/eigos/grok-life/skill-install.md`，自己保存到技能库，并记录连接 Mac 的 machineId 和绝对路径。它使用同目录的 Python 客户端与 profile，输入和回执保存在 `peer/`，不依赖 Documents 访问权限。项目 `data/grok-life/` 保留诊断副本。loopback 不属于 Grok 云电脑。
- 停止本服务可使用 `launchctl bootout gui/$(id -u)/com.eigos.grok-life`；若不再自动启动，移除该专用 plist。保留运行目录可保留历史与凭据。

开发凭据不用于公网或其他会员。生产身份继续使用 Auth0／OIDC；Python 接入不证明 Grok 原生内置 A2A 连接器。

## 验收

真实 Grok 在自身技能库读回规则并发现 Card；对不含品牌名的六类自然需求实际提交任务。对照客户端、A2A、MCP 与数据库确认目标、任务编号和未执行回执一致。回归覆盖持久恢复、补充、取消、归属、scope、防重及伪造完成拒绝。固定客户端测试不代替真实 Grok 触发验证。订单、预订、付款与履约不属于本阶段。
