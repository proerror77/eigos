# 自有域名发布与认证验收快照

记录于 2026-10-22（Asia/Shanghai），具体时间见 [readback.json](readback.json)。这是发布后的检查快照：**公网入口已经启动，真实用户的完整任务验收尚未完成。**

- 入口：[https://eigos.mandonothing.com](https://eigos.mandonothing.com/)
- MCP：[https://eigos.mandonothing.com/mcp](https://eigos.mandonothing.com/mcp)
- 会员中心：[https://eigos.mandonothing.com/members](https://eigos.mandonothing.com/members)
- 本次代码提交：`dd4850799a4f837ff728e91f77b98a155653075c`
- 运行摘要：`e7fd844b5fc783585bc6010c359414829fd03cd23b8b72c3d1afe1920fa4fe1d`
- [该代码提交的 CI](https://github.com/proerror77/eigos/actions/runs/39714556169)。记录时仍在运行，不能将本地检查或已启动实例当作其成功终态；同步收尾另须核对最终仓库 HEAD 的 CI。

## 已验证的事实

| 检查 | 实际结果 |
| --- | --- |
| 本地检查 | 类型检查、构建、差异检查通过；完整回归 919 项通过，失败、跳过、取消均为 0；部署专项 6 项通过 |
| 独立发布副本 | 发布清单包含运行代码及本体历史 JSON；实际 Gateway／Worker 导入成功。临时副本移除必需的 JSON 会复现加载失败，恢复后通过 |
| 本地完整启动 | 独立临时数据库上的 Gateway／Worker 启动成功；正确域名的健康检查正常，错误域名返回 403，MCP／A2A 无令牌返回 401 |
| 自有域名 | 专用 Cloudflare Tunnel 只转发 `eigos.mandonothing.com` 到 `127.0.0.1:3212`，随后为 404 回退；发布程序核对了隧道健康和准确路由 |
| 公网回读 | `/health` 返回 200，运行摘要与发布清单一致；MCP／A2A 无令牌为 401，付款发现入口为 404 |
| 独立网络 | 美国 Buffalo（HostPapa）和德国 Falkenstein（Hetzner Online）的 HTTPS 请求均返回 200；证书验证通过，运行摘要一致 |
| 准入与权限发现 | 准入为 `invite-only`；MCP 资源公开 `openid`、`offline_access` 及三个任务访问 scope，不公开来源、建模或支付 scope |
| 原有路由 | 原 443 的两个目标、8443 的私人来源目标及公开／私人属性保持原配置 |
| 登录回调预检 | Auth0 接受登记的 `127.0.0.1:64517/callback`，拒绝未登记的 64518；原生 Codex 按生成配置监听正确端口。此预检没有进行用户授权或公网任务调用 |
| 模型环境预检 | 实际 `CodexExecutor` 返回有效结构化结果；它是模型连通性预检，未经过真实会员的 MCP 任务流程 |

独立网络原始结果：[Globalping measurement](https://api.globalping.io/v1/measurements/2YMjGdVVEPINwFO1q00021MS4)。检测只请求无凭据的公开 `/health`，没有向检测方发送令牌、Cookie、会员信息或任务内容。

首次发布尝试因清单遗漏运行必需的 JSON，在启动之前被发布检查阻止。修复后重新完成完整回归并发布；没有通过补写未纳入摘要的文件绕过检查。

## 尚未完成的认证验收

会员中心已通过真实 Auth0 登录登记首个身份；记录时尚未提交页面上的会员开通同意，数据库的开通时间为空、活跃会员和助手连接均为零。因此尚未签发该会员的邀请，也没有把登录成功记为已经取得任务调用资格。

以下项目仍待实际流程验证：

1. 本人确认开通，兑换绑定本人身份的邀请。
2. 原生 Codex 对公网 MCP 完成 OAuth，提交文档需求并读回同一任务的完成状态与交付物。
3. 第二个不同认证身份各自完成任务，跨身份查询被拒绝。
4. 访问令牌实际过期后的自动续期，以及连接停用后旧令牌和刷新均不能恢复资格。
5. 真实完成任务在进程重启后仍可读回原交付物。
6. 最终仓库提交的远端 CI 成功，本地／远端一致且工作区干净。

已登录身份、原生客户端回调预检、模型直连预检和模拟身份回归不能替代上述验收。这里不宣称外部客户已经可完成真实业务，也未执行真实下单、付款或对外发送。

## 运行与资料库边界

Auth0 负责身份验证；会员资料、准入、连接状态和任务仍保存在 Mac 的独立 SQLite 数据库。Cloudflare 提供域名和隧道，服务进程与数据库尚未迁移到云端。本次没有新建 Supabase、D1 或阿里云数据库。

运行仍依赖该 Mac、隧道和模型环境在线。接入步骤见[内测用户指南](../../invite-beta.md)，维护与恢复见[内测发布说明](../../invite-beta-operations.md)。

本目录只保存经过检查的摘要。原始登录页面、账号标识、邀请凭据、令牌、私有配置和运行日志保留在忽略目录。
