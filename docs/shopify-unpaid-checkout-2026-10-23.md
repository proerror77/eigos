# Shopify 未付款结账：私有接入

`shopify.checkout.unpaid@1` 将官方 Shop MCP 的商品查询、创建未付款结账和原会话回读接入 EIGOS。默认关闭，只允许显式配置的本人本机开发实例。此次范围是准备结账、返回商家原始链接及查询状态；不提交正式订单，不付款，不提交邮箱、地址或支付资料。公开邀请测试实例不能启用该能力。

## 原生任务与动作

PA 仍提交 `eigos.delegate`，Worker 通过本体发现能力和动作，再根据每轮实际观察决定下一步。运行时没有预填供应商动作序列。三个动作分别是：

| Action | 效果 | 来源 |
| --- | --- | --- |
| `ReadShopifyCheckoutProducts` | 只读 | 对选定变体调用 `lookup_catalog`，核对商家、变体、数量、显示单价和可售标记 |
| `CreateShopifyCheckout` | `external_draft` | 准确许可后调用一次 `create_checkout`，仅含商品行项目及幂等键 |
| `ReadShopifyCheckout` | 只读 | 以原私有 Checkout ID 调用 `get_checkout`，保持原会话身份 |

能力输入有两种模式：

```json
{"mode":"prepare","merchantId":"configured-merchant","items":[{"variantId":"gid://shopify/ProductVariant/123","quantity":1}]}
```

```json
{"mode":"status","sourceTaskId":"earlier-owned-eigos-task-uuid"}
```

`prepare` 需要已选定的原生变体 ID；尚未选定商品时先使用目录查询。商品预读采用 US／USD 展示上下文，不作为用户收货地址或配送可达性证据。`quantity` 是 Shopify 商品行项目的整数件数，不表示重量或已送达数量。`status` 只接受该用户以前由本能力创建、且账本已确认的唯一结账；不接受任意外部链接或不明 Checkout ID，不新建会话。新任务的完成证据来自新回读，原创建记录仅用于绑定身份。

`ShopifyCheckoutTask` 固定当前用途和商家／商品范围，`ShopifyCheckoutProducts` 与 `ShopifyCheckoutObservation` 保存逐次来源观察。`shopifyCheckoutObservationStatus` 核对原始回执、归属、关系、摘要及五分钟有效期。完整 Checkout ID 中的私有 key 和继续链接保存在受限快照；普通本体读取不可见。最终任务结果向同一已认证用户返回原始继续链接。

## 许可与恢复

`external_draft` 是独立的非付款权限。预览包含准确商家、商品、数量、显示单价、来源摘要、请求摘要和 `maximumCreates: 1`，并固定 `orderAllowed`、`paymentAllowed`、`buyerDataAllowed` 全为 `false`。显示价格不是付款额度；该许可不占用预算，也不能转换为沙箱订单、支付或受管数据写入许可。

MCP 仅在能力启用时注册 `authorize_checkout_draft`。PA 复制原任务返回的 `planDigest` 和整个 `draft`，提供新的 `requestId` 和尚未过期的 `expiresAt`；可直接复制 `draft.sourceExpiresAt`，授权不得超过这个来源有效期。同一个 `requestId` 只可重试相同内容。A2A 使用原 `taskId`／`contextId` 的结构化 `SendMessage`：

`data` 携带 `action: "approve_external_draft"`、原 `planDigest`、完整的原 `draft` 对象、有效的 `expiresAt` 和 `environment: "live"`。A2A 的 `messageId` 用作授权幂等键；现有 Python PA 客户端的 `authorize` 命令支持这一窄授权。两种协议共享 TaskService、任务所有权、上下文、准确预览和撤销检查。

Worker 在持久 Intent／Attempt 之后、实际创建 POST 之前再次检查任务取消、租约、权限和当前商品证据。官方连接器只开放上述三个工具，使用固定 `https://mcp.shop.com`、MCP `2026-07-28` 和 UCP `2026-08-25`。不读取用户 Shopify 登录态，不发送 Cookie、账户令牌或伪造买方 IP。

收到创建响应后，连接器先保存仅本人可读的原响应及按原 operation key 绑定的创建回执，再交给运行时。若响应已保存但任务结果未知，只对原 Checkout ID 做查询恢复；没有可核验的原 ID 时停止并请求查证，不能重发创建。恢复查询不替代模型在完成前明确选择的独立状态回读。取消或失去租约后的迟到结果只作审计，不能完成任务。

## 完成的含义

准备任务必须验收原会话中的准确商品与数量、未完成购买的状态、原始继续链接及创建之后的独立回读。`requires_escalation` 以及缺少买方资料等来源提示会原样保留；创建未付款结账成功不要求用户现在填写这些信息。

返回结果包含来源状态、显示金额、来源要求和支付处理器名称。运费、税费、配送可用性与最终总价没有在此阶段核实。结账链接不证明订单、付款或履约。来源返回 Shop Pay 不表示已接入 Stripe Link 或 Link Agent Wallet。后续状态查询可以如实报告商家返回的完成或订单标识，但不把它归因为 EIGOS 付款。

## 私有配置与部署

两端共用配置：

- `EIGOS_SHOPIFY_CHECKOUT_MERCHANTS`：严格商家清单，字段与匿名目录清单相同；与 `EIGOS_SHOPIFY_CATALOG_MERCHANTS` 分开，默认 `[]`。
- `EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR`：必须是绝对路径，目录由当前用户所有且权限为 `0700`；原响应和恢复文件为 `0600`。
- `DATABASE_PATH`：持久绝对路径。仅允许非生产 `development` 认证和 loopback。

新增 `shopify-checkout-private` 部署 profile，使用独立的 `~/.local/share/eigos/shopify-checkout-private/`、LaunchAgent 和任务／会员数据库。它沿用不可变构建文件、独立依赖、配置备份与失败恢复。部署命令要求已经提交且干净的工作区：

```sh
node scripts/deploy-member-network.mjs --profile shopify-checkout-private --config /absolute/private/checkout.env
node scripts/deploy-member-network.mjs --profile shopify-checkout-private --config /absolute/private/checkout.env --apply
```

该 profile 的任务库、会员库和来源日志分别必须位于实例目录下的 `tasks.sqlite`、`members.sqlite` 和 `shopify-checkout/`。需要既有 Codex 登录和 `EIGOS_EXECUTOR=codex`。不创建公网入口，不修改其他运行实例。

当前运行契约为 `ontology-execution-v18`，新库激活 `eigos.business@18`。v15、v16、v17 的原模型摘要继续固定；v18 增量加入上述类型／动作与非付款许可字段。已有数据库不会自动切换 active release，旧任务也不自动重跑。

## 验证边界

自动化测试使用模拟模型和供应商数据，覆盖准确许可、协议共用、私有配置、撤销／取消／租约、原会话恢复、无原 ID 时停止、受限字段及独立状态回读。这些测试不等于真实 Shopify 或真实 PA 验证；后者另存脱敏证据，原响应与结账私有链接保留在私有实例中。

协议依据：[Shopify 官方 Shop MCP 发布说明](https://shopify.dev/changelog/posts/add-shopping-and-shop-pay-checkout-to-any-agent-with-shop-mcp)。
