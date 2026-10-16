# Auth0 真实会员 → Agent 验收

2026-10-16 16:10（Asia/Shanghai）完成。本轮使用真实 Auth0 OIDC、真实会员及两个独立 Codex 模型运行时，在本机私有 HTTPS 环境生成并读取会议议程。

## 结果与证据

- 会员通过真实提供方登录，在浏览器提交明确同意后自助开通；[独立会员回读](membership-readback.json)确认身份哈希、active 状态、同意记录和已登记 Agent 连接。
- 个人助手使用独立 public client，经授权码、S256 PKCE、state、nonce 和用户 consent 取得真实访问令牌。提供方 ID／Access Token 签名与 issuer、audience、tenant claim、client ID、scope、令牌用途及寿命按实际代码校验。[验收回执](verification.json)记录了同一会员与任务的核验结果。
- 实际 Personal Agent 调用 `list_services`、一次 `submit_task`、六次 `get_task`；独立 Worker 模型生成文档。[模型运行收据](model-receipts.json)保留两侧不同 thread ID 和工具调用，不保留模型内部推理。
- 唯一任务 `93a908f6-7713-40c5-95db-00c670cadf74` 的状态为 `completed`。助手自己的 MCP 查询、独立 A2A `GetTask` 和 SQLite 中的 Markdown 字节一致；SHA-256 为 `2cde5dce101c1a55be2bc46a86f28624b490babeaa7ffc90a70a738c69634562`。[HTTP 轨迹](http.jsonl)包含对应请求及响应状态。
- [交付物](deliverable.md)已检查：6 人、三个议题、8＋14＋8＝30 分钟，每个议题都有预期产出。

## 现场修复与边界

真实 Chrome 表单暴露了 `Referrer-Policy: no-referrer` 导致 POST `Origin: null` 的问题。会员表单及校验错误 HTML 改为 `same-origin`，登录／回调重定向继续使用 `no-referrer`；没有放行 null Origin。修复后真实浏览器提交成功，已登录会话在 Gateway 重启后保留。88 项回归、类型检查、构建与差异检查通过。

本轮证明预登记参考客户端的真实会员登录、授权、Agent 执行和结果回读。使用 Auth0 `audience` 扩展，不代表任意外部 MCP 客户端自动 OAuth 登记已经兼容，也不代表公网生产发布或商业订单履约完成。

该目录仅保留检查过的脱敏证据。密码、token、client secret、原始账号信息及含账号信息的截图不在 Git 中。
