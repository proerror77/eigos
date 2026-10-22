# Stripe Treasury 接入预留

2026-10-22。当前状态：**配置已预留，默认关闭；未授权、未连接、未调用、未验证企业账户**。

本阶段按用户选择，只在 EIGOS 预留 Stripe 官方 MCP 地址和关闭开关。Treasury 面向企业资金查询和调度，后续可作为可选能力；现有服务预约、PA 自有钱包付款和服务商独立回读继续使用各自流程。

## 当前配置与行为

`.env.example` 提供以下配置；省略时采用相同默认值：

```dotenv
EIGOS_STRIPE_TREASURY_ENABLED=false
EIGOS_STRIPE_TREASURY_MCP_URL=https://mcp.stripe.com
```

- Gateway 与 Worker 使用相同配置校验。当前只接受 `false` 和上述官方地址；设置 `true` 会拒绝启动，不能通过改环境变量开放业务调用。
- 本阶段没有创建 MCP 客户端、进行初始化或工具发现，也没有读取账户或余额。
- Treasury 尚未注册到共用执行目录、本体 Action、对外 MCP 工具或 A2A 能力中。模型和 PA 不能选择或调用它。
- 不需要也不读取 Stripe 凭据；没有新增账户授权、自动探活、定时任务或常驻部署。
- 这是接入准备，不是已经连接的适配器。现有 [Stripe 商家测试适配](stripe-test-integration.md) 与 [Link 预约付款](pa-booking-payment-flow.md) 均不能作为 Treasury 连接证据。

## 后续启用条件

启用需要独立实现和验证，不能只翻转开关：

1. 确认具体业务场景、企业 Stripe/Treasury 资格、账户及环境，并完成账户所有者授权。此前 Link Agent Wallet 的地区限制不代表 Treasury 的准入结果。
2. 为实际使用者建立归属明确、可撤销的来源授权；一名成员的账户连接不授予其他成员读取或支出权限。凭据留在私有授权存储，不写入任务、本体事实、模型上下文或提交文件。
3. 在 Worker 复用现有 Ontology → 受控 Action → 来源观察 → 独立验收流程接入官方 MCP，Gateway 继续只处理协议和任务。先实现用户授权的账户及余额只读操作，并回读真实结果；不把官方完整工具列表直接开放给模型。
4. 付款、转账、换汇、收款人设置及开卡分别评估。资金操作需要准确授权、原操作身份、未知结果恢复及独立结果回读；现有禁止真实下单和付款的边界保持有效。

## 官方依据与验证范围

Stripe 于 2026-10-21 [发布 Treasury for agents](https://stripe.com/newsroom/news/treasury-for-agents)。当前 [MCP 文档](https://docs.stripe.com/mcp) 列出 `get_balance_summary`、`convert_currency`、`send_money`、`setup_recipient` 和 `transfer_money` 等 Treasury 工具。文档中的工具支持不等于本项目已获权限或已验证可用。

官方 MCP 支持 OAuth 和 Agent API key；交互式账户连接优先 OAuth，自主应用可使用最小权限的 Agent API key。本阶段未选择或创建任何凭据。[认证说明](https://docs.stripe.com/mcp#manage-mcp-access-and-sessions)

本地回归覆盖两个进程的默认关闭、拒绝误启用、拒绝替代地址、错误信息不回显地址中的凭据，以及 Gateway/Worker 启动时没有出站 fetch、没有发布 Treasury 能力。测试使用本地配置和内存任务库，不访问 Stripe；通过这些检查不代表远端连接、账户资格或任何资金操作成功。
