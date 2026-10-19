# Shopify 真实商家匿名只读准入验证

历史记录：本文保留 2026-10-18 独立探针的范围与结果。2026-10-19 的 PA／Worker 登记、Ontology 模型路径和单独验收见 [后续接入说明](shopify-pa-worker-2026-10-19.md)。

本轮按用户选择“先验证公开商家的匿名只读访问”验收。2026-10-18 22:45（Asia/Shanghai），仓库内的客户端完成 Shopify 生产 Global Catalog 与 Purity Coffee 店铺的 6 次真实请求，全部返回 HTTP 200 且通过协议与业务结果检查。已验证公开商品查询链路；EIGOS 账号令牌、商家合作授权、购买及履约尚未验证。

## 真实结果

| 检查 | 观测结果 |
| --- | --- |
| Global Catalog 工具发现 | `search_catalog`、`get_product`、`lookup_catalog` |
| 商品发现 | 在指定 Shop ID 内搜索，取得商品簇、商家和变体 |
| 商家 | Purity Coffee；`gid://shopify/Shop/40613871783`；`purity-coffee.myshopify.com` |
| 商品变体 | `gid://shopify/ProductVariant/36130238136487`；店铺 SKU `PC12-R` |
| 店铺 UCP 声明 | `2026-08-25`，MCP endpoint 与配置的店铺 origin 一致 |
| 全局详情与店铺回读 | 同一变体均返回 `2900 USD` 最小货币单位，即 29 美元；`available=true` |
| 商品原生结账资格字段 | Global Catalog 当时返回 `eligible.native_checkout=false`；这是来源标记，未尝试结账 |
| 库存数量／目的地配送承诺 | 未知；可售标记不证明已留货或可送达指定地址 |
| 业务写入 | 购物车、结账、订单、付款调用均为 0 |

价格与可售标记是当次查询的来源观测，不是保价、库存预留或履约保证。Purity Coffee 仅作为公开技术样本，尚未进入 EIGOS 已核验合作商家名单。

全局 `get_product` 返回的商品簇实际含有其他商家的报价。本轮按 **Shop ID + canonical myshopify domain + ProductVariant ID** 保留所选报价，再向该店铺 `lookup_catalog` 核对同一个变体和 `inputs.match=exact`。未用商品名或详情中的第一个报价替代供应方身份。

## 交付范围与接入边界

- `packages/capabilities/shopify/read-only.ts`：独立只读客户端。网络目标固定为 Shopify Global Catalog 或显式配置的单个 `*.myshopify.com` 店铺，发现结果必须保持同一 endpoint；拒绝重定向、非法版本、过大响应和未协商能力。
- `examples/verify-shopify-readonly.ts`：可重跑的准入验证，默认匿名。即使环境存在凭据，也不会自动升级为 token 模式。
- `tests/shopify-readonly.test.ts`：11 项本地回归，包括禁止写工具、商家／变体错配、认证失败、缺少真实买家 IP、HTTP 200 内的协议失败及取消等边界。令牌路径使用模拟响应测试，尚无真实账号授权证据。
- 全部入口只执行 `search_catalog`、`get_product`、`lookup_catalog`，以及工具／公开配置发现。没有任意工具透传、购物链接跳转、订单读取或业务写入入口。
- 尚未注册到 Gateway／Worker 的能力目录，也未修改 MCP／A2A 任务行为、业务本体或常驻部署。原本只允许 loopback 的 UCP REST 沙箱交易适配器保持原边界。

店铺公开了购物车、结账和订单工具；工具存在不授予执行权。当前客户端使用 [Shopify 官方托管测试 profile](https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json) 协商协议，它不是已发布的 EIGOS 平台身份。正式接入需要后续准备自己的可访问 profile，并独立验证账号与业务授权。[官方 profile 说明](https://shopify.dev/docs/agents/profiles)

## 准入与授权分别核验

| 门槛 | 本轮状态 |
| --- | --- |
| 匿名请求是否能访问生产 Catalog | 已实测通过 |
| 指定真实店铺是否提供兼容协议与同一商品变体 | 已实测通过 |
| EIGOS 自有平台 profile／签名身份 | 未发布、未验证 |
| Global API 账号令牌与实际 scopes | 未调用真实凭据交换；按用户选择保持匿名 |
| 商家合作与业务执行授权 | 未取得；公开数据可读不等于合作关系 |
| 买家身份关联、现有订单读取 | 未尝试；无本 Agent 发起的已知订单及对应授权 |
| 下单、支付、配送、售后 | 未尝试；本轮接口全部关闭 |

Shopify 文档区分匿名、签名和 token 流量。匿名额度较低，本轮低频读取成功不能推导为生产吞吐承诺。Token 模式的商家 `tools/call` 要求实际买家的 `Shopify-Buyer-IP`，不能用占位值或服务端出口 IP 替代。[官方认证与限流说明](https://shopify.dev/docs/agents/profiles/auth-and-rate-limiting)

后续 token 验证需 Dev Dashboard 的 Catalogs／Global API 凭据，向固定官方 token endpoint 换取短时令牌。代码仅报告令牌元数据，并以实际 API 接受作为访问证据；不会把令牌包含某个 scope 当成商家合作或购买许可。[官方认证流程](https://shopify.dev/docs/agents/get-started/authentication)

即使有订单读取 scope，Order MCP 也限制为该 Agent 参与的订单。当前没有可用于验证的已归属真实订单，因此客户端未开放 `get_order`，没有猜测或遍历订单标识。[官方 Order MCP](https://shopify.dev/docs/agents/orders/order-mcp)

## 重跑

```sh
npm run verify:shopify-readonly
```

默认使用上述公开样本、`coffee beans` 查询和美国市场上下文。若验证其他已选商家，须同时提供从可信来源取得的商家 domain 和 Shop ID：

```sh
EIGOS_SHOPIFY_MERCHANT_DOMAIN=your-store.myshopify.com \
EIGOS_SHOPIFY_MERCHANT_ID=gid://shopify/Shop/123456 \
EIGOS_SHOPIFY_QUERY='your product' \
npm run verify:shopify-readonly
```

这些示例标识是配置占位符。脚本不会把任意域名、链接或模型提供的 endpoint 作为目标。国家可通过 `EIGOS_SHOPIFY_COUNTRY` 设置；它只提供查询上下文，输出中的目的地配送承诺仍为 unknown。

结果写入忽略目录 `data/shopify-readonly/report.json`，每次来源响应原文按回执 ID 保存在 `data/shopify-readonly/responses/`，权限为 0600。公开报告保留时间、来源 endpoint、操作、状态及请求／响应摘要，未保存认证头或凭据。失败时脚本以非零状态退出，不自动重试或降低认证级别。

未来获准验证 token 模式时，配置 `EIGOS_SHOPIFY_AUTH_MODE=token`、`EIGOS_SHOPIFY_CLIENT_ID`、`EIGOS_SHOPIFY_CLIENT_SECRET`，并为商家读取提供由操作方明确输入的 `EIGOS_SHOPIFY_BUYER_IP`。凭据只放本机私有环境或忽略的环境文件；不要贴入聊天、提交仓库或写入任务。此配置仍只开放商品读取，不会启用任何交易工具。

## 验证与证据

[归档报告及校验清单](evidence/shopify-readonly-2026-10-18/README.md) 包含最终真实运行的 6 个回执、商家／商品回读结果及源文件摘要。原始响应保留在忽略目录，逐个核对字节长度和 SHA-256 均与归档回执一致。

本轮 315 项测试通过，其中 11 项为新增只读边界回归；类型检查和构建通过。真实探针直连 Shopify，未使用本地商家替身；单元测试中的故障和 token 响应明确为模拟。探针验证的是本客户端的只读接入，不是 PA／真实模型驱动的完整购买验收。

Global Catalog 的描述、特征等字段可能含平台推断；本客户端只保留标识、报价、可售和来源信息，不将商品文案当作执行指令。来源文档见 [Global Catalog](https://shopify.dev/docs/agents/catalog/global-catalog) 与 [Storefront Catalog](https://shopify.dev/docs/agents/catalog/storefront-catalog)。
