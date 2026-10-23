# 滴滴模拟叫车与原订单回读

`ride.booking.sandbox@1` 在统一 Gateway／Worker 和原生 Ontology MCP 上执行：查询地点及估价 → 展示路线、车型和预估价 → 等待准确计划授权 → 创建一个官方模拟订单 → 独立回读原订单号和司机状态。Agent 从本体选择动作，连接器每次只执行一个来源调用。

本阶段只支持滴滴官方 Mock。真实订单、付款、取消和司机定位均未启用。项目现有“当前不允许真实下单或付款”规则仍有效。生产账号的直接叫车资格、会员各自的私有连接、真实费用和真实订单恢复还没有获得本阶段验证；工具目录存在不代表账号可以真实叫车。

## 配置与确认

在已有本人私有 Key 绑定和 loopback 开发环境中显式设置：

```dotenv
EIGOS_DIDI_ENVIRONMENT=mock
EIGOS_DIDI_ORDERS_ENABLED=mock
EIGOS_DIDI_AUDIT_DIR=/absolute/private/didi-mock-audit
EIGOS_ACTION_SANDBOX=true
```

其余凭据配置沿用[只读接入](didi-readonly-integration.md)。订单开关默认 `false`，不接受 `true`；mock 开关配合生产来源、缺少持久审计目录或未开启沙箱授权时拒绝启动。原来的两项只读工具白名单保持独立。

MCP／A2A 的任务回读包含 `authorizationRequest.confirmation`，展示来源路线、车型、原始预估价、本地刷新截止时间和模拟边界。文案、来源观察及动作参数与计划摘要一起固定；批准沿用原任务的 `approve_plan`。零金额授权表示模拟环境不扣款，不表示车费为零。

估价的 `traceId` 只保存在私有来源回执中，不进入模型、PA 参数或公开任务。下单使用同一绑定、任务、版本的来源观察，并核对车型与价格。五分钟是本地刷新限制，不是供应商保证的有效期；过期后不能沿用旧确认。

## 恢复和验收

创建前重新检查授权、任务取消和 Worker 租约。原业务操作键与持久发送标记防止重复创建。供应商未公开承诺创建幂等键，EIGOS 的本地键不被描述成供应商幂等保证。

回复丢失或无法取得订单号时保留原操作，不再次创建，也不省略订单号查询账号当前订单。保存了原始创建回执时可以恢复原身份，随后仍需独立查询。

`ReadDidiRide` 只接受本任务已保存的原订单观察。官方 Mock 查询实测可能只返回文字：适配器保存其原文，把身份依据标成准确 `order_id` 请求，把数值状态码和结构化司机字段保持未知；不从文字虚构行程阶段。未识别的文字或错误回复保持未知。完成须由 Agent 实际读取并评估独立回读；未知状态码保持未知。匹配中、接单、到达和行程完成分别记录，模拟状态不能证明真实履约。

本体内核 v18 增加滴滴类型、动作和验收函数。`RideEstimateTask` 是受管请求输入，地点和估价是来源证据；组合接口区分二者。一个叫车组件同时覆盖估价和订单回读目标。

## Worker 模型与验证

Worker 默认固定 `gpt-6-luna`、`medium` reasoning 和 `priority`（Fast）。三个配置项为 `EIGOS_CODEX_MODEL`、`EIGOS_CODEX_REASONING_EFFORT`、`EIGOS_CODEX_SERVICE_TIER`。它仍通过 Codex CLI 原生调用任务专属 Ontology MCP，不修改用户全局配置，不静默改用其他模型。

每次运行记录 `modelConfiguration` 和 `durationMs`。配置记录表示明确请求的设置；只有 CLI 另行报告时才记录观察到的 `model`。请求 `priority` 不能当作供应商确认的实际服务层级，也不保证固定提速比例。

自动测试覆盖准确授权、改价、取消、回复丢失、错订单号、生产禁用、统一任务组合以及模型参数。官方 Mock 实测使用：

```sh
node --env-file=/absolute/private/didi.env --import tsx examples/verify-didi-booking.ts --official-mock
```

示例启动隔离的真实 Worker 和本地协议入口，使用 Luna、原生 Ontology MCP 与官方 Mock 来源。它只自动批准打印出的一个模拟计划，并比较同一任务的 MCP／A2A 回读。原始任务、来源回复和运行记录保存在忽略目录中，不能直接公开。一次通过不证明真实叫车资格或长期可靠性。

来源：[滴滴官方 MCP 文档](https://mcp.didichuxing.com/api)、[Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference)、[Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)。
