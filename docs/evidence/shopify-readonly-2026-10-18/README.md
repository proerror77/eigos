# Shopify 匿名只读证据

最终运行：2026-10-18T14:45:22Z 至 14:45:25Z（UTC）。命令为 `npm run verify:shopify-readonly`，基线提交为 `1650545e90c5620d495ae8cc97206b0753a72f54`。新增客户端、验证脚本、测试和 package.json 的运行前摘要见 [source-hashes.json](source-hashes.json)；检查时四个文件均未变化。

- [report.json](report.json)：6 次真实 Shopify 请求的回执，以及 Global Catalog 与 Purity Coffee 店铺对同一变体的读取结果。每条回执记录 endpoint、操作、认证模式、时间、状态、响应字节数和 SHA-256。
- [verification.json](verification.json)：原始响应长度／摘要核对、商家与变体匹配、报价比对、测试和构建结果。
- [check.log](check.log)、[tests.log](tests.log)、[build.log](build.log)：类型检查、315 项测试与构建输出。新增 11 项 Shopify 测试，故障与令牌路径使用本地模拟响应。

真实来源包括 `https://catalog.shopify.com/api/ucp/mcp`、`https://purity-coffee.myshopify.com/.well-known/ucp` 和同店铺 `/api/ucp/mcp`。最终记录依次为 Global tools/list、search_catalog、get_product、商家 discovery、商家 tools/list、lookup_catalog，均为匿名且 HTTP 200；协议与业务结果校验也通过。

原始响应按回执 ID 保存在本机忽略目录 `data/shopify-readonly/responses/`，未提交商品描述、完整来源数据或凭据。归档前逐个读取这六份原文，核对长度和 SHA-256 与报告一致。`report.json` 是挑选过字段的读取报告，不能用它本身的文件摘要代替原始响应摘要。

边界：仅证明所记录的公开只读链路。没有 EIGOS 自有 profile／账号令牌授权证据，没有合作商家认证、库存预留、目的地配送保证或现有订单读取；没有创建购物车、结账、订单或付款。测试 profile 来自 Shopify 官方托管样例。未向 PA／Worker 发布该能力，未更新常驻部署。完整说明见 [准入记录](../../shopify-readonly-admission-2026-10-18.md)。
