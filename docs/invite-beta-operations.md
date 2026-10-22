# MCP 邀请内测发布与验收

此配置复用原 Gateway／Worker、OAuth/JWT、会员与任务归属规则。`EIGOS_INVITE_BETA=true` 启用受限的文档任务入口。部署、客户端 OAuth、第二个独立用户和实际交付物分别验收；任一未通过都不能宣布用户已经可以接入。

## 固定边界

- 仅 HTTPS/JWT、准确 audience、邀请制、独立持久任务库和会员库。
- 接受明确配置的原生 MCP 客户端与既有设备授权客户端。MCP／A2A 请求即使携带额外签名 scope，也只保留 `services:read`、`tasks:read`、`tasks:write`。
- 原生 OAuth 资源发现额外声明 `openid`、`offline_access`，用于用户登录及刷新；不发布建模、管理员、供应商来源或付款权限。
- 配置拒绝开发令牌、个人供应商凭据、会员来源密钥、网络发布及交易沙箱；原私人来源模式的限制不改变。
- 公开页面只包含入口、服务边界和公开客户端 ID。密码、客户端密钥、邀请及访问／刷新令牌保留在各自私有通道。
- 文档模型工具关闭，不能读取主机文件、运行 shell 或调用浏览器／插件；独立验收仅证明格式、摘要与约定的文档交付，不证明商业事实或执行文档中的业务。

## 当前部署形式

沿用 macOS 的不可变发布、依赖缓存、备份和失败恢复脚本，使用独立 profile：

| 项目 | 内测配置 |
| --- | --- |
| profile | `invite-beta` |
| launchd | `com.eigos.invite-beta` |
| 私有运行目录 | `~/.local/share/eigos/invite-beta/` |
| 本机监听 | `127.0.0.1:3212` |
| 本轮目标域名 | `https://eigos.mandonothing.com`，经独立 Cloudflare Tunnel 接入；是否可用以完成上线验收为准 |
| 隧道进程 | 独立 LaunchAgent `com.eigos.invite-beta-tunnel`，只转发到 `127.0.0.1:3212` |
| 可选入口 | 使用 `.ts.net` 域名时，仍可采用独立 Tailscale HTTPS Funnel 端口 `10000` |
| 既有服务 | `443` 和私人会员来源的 `8443` 保持原配置 |

此方案依赖 Mac、所选隧道和模型运行时在线，是邀请内测运行方式，不承诺生产 SLA。会员库与任务库仍在该 Mac 的私有运行目录；域名和隧道不会将数据库自动迁移到云端。

## 配置与发布

1. 完成类型检查、相关回归、完整测试、构建、差异审查和提交。发布脚本拒绝有未提交变更的工作区。按项目同步规则推送并跟踪准确提交的 CI。受邀请限制的验收实例可在本地检查通过且已推送后用于下文的运行验收；对外宣布内测可用前，必须同时确认该提交的 CI 成功和全部运行验收通过。
2. 用已登录的 Auth0 CLI 准备独立资源。`--invite-beta` 只登记任务 scope 与会员开通 scope，并增加一个使用授权码、PKCE 和轮换刷新令牌的 EIGOS 原生 MCP 集成客户端：

   ```sh
   node scripts/setup-auth0.mjs --public-url https://eigos.mandonothing.com \
     --invite-beta --output data/invite-beta-auth0
   ```

   先检查生成计划。已授权的实际配置使用同一参数，添加准确的 `--tenant` 与 `--apply`。输出的私有 `gateway.env` 指向独立内测数据库；不复制既有会员、任务或供应商凭据。已有资源若包含超出本内测范围的 scope，脚本拒绝继续。
3. 核对 Auth0 租户的 Resource Parameter Compatibility Profile，以及原生客户端的回调和刷新契约。此设置让 MCP 的 `resource` 参数指向准确 API；必须通过实际登录和 JWT 接受结果核验，不能只看开关。本租户实际预检拒绝未登记的随机 loopback 端口，因此该内测客户端登记 `http://127.0.0.1:64517/callback`，生成的 Codex 配置同时设置相同 `oauth.callback_url` 与 `oauth.callback_port = 64517`。这只设置 EIGOS 连接，不改变 Codex 的全局回调端口。变更端口必须同步提供方登记和客户端配置；未匹配的端口继续拒绝。
4. 为自有域名准备专用的 Cloudflare Tunnel。远端配置必须只有两个入口规则：准确的内测主机名指向 `http://127.0.0.1:3212`，其后是 `http_status:404`。不配置路径筛选、通配域名、其他来源、origin 覆盖或 WARP 私网路由。DNS 使用开启代理的 CNAME 指向该隧道的 `隧道UUID.cfargotunnel.com`。

   隧道运行令牌保存在 `~/.local/share/eigos/invite-beta/cloudflare/tunnel.token`，文件为本人所有的 `0600` 普通文件。专用 LaunchAgent 使用已安装的 `cloudflared --no-autoupdate tunnel --metrics 127.0.0.1:0 run --token-file /绝对私有路径/tunnel.token`，日志也保存在该私有目录；不将令牌写进进程参数、Gateway／Worker 环境或模型上下文。

   在同一私有目录准备 `frontend.json`，将下列占位符替换为实际隧道身份，权限设为 `0600`：

   ```json
   {
     "version": 1,
     "kind": "cloudflare-tunnel",
     "accountId": "实际32位账户ID",
     "tunnelId": "实际隧道UUID",
     "tunnelName": "eigos-invite-beta",
     "hostname": "eigos.mandonothing.com"
   }
   ```

   部署程序通过当前 Wrangler 管理登录只读核对隧道身份、健康连接及远端入口规则。管理令牌只在部署进程内使用。DNS 写入权限独立检查；Wrangler 登录成功不代表具备 DNS API 权限。通过控制台配置 DNS 时，保留准确记录回读，并在发布后核对实际 HTTPS 端点。

5. 以绝对私有配置路径执行 Cloudflare 部署预览：

   ```sh
   node scripts/deploy-member-network.mjs --profile invite-beta \
     --config /绝对路径/data/invite-beta-auth0/gateway.env \
     --cloudflare-frontend /绝对路径/invite-beta/cloudflare/frontend.json
   ```

   如果选择 Tailscale Funnel，则使用准确的 `.ts.net` HTTPS origin 生成 Auth0 配置，省略 `--cloudflare-frontend`。核对当前 Serve/Funnel 配置和本机端口归属后，才启用属于本次内测的精确入口：

   ```sh
   tailscale funnel --bg --https=10000 http://127.0.0.1:3212
   ```

   不使用 `reset`，不改已有 `443` 或 `8443`，不将私人来源实例改为公网。Funnel 只支持 tailnet 的 `.ts.net` 域名，不能用自有域名的 CNAME 直接替代其 TLS 主机名。
6. 确认所选隧道已连接、域名已解析且 HTTPS 证书有效，对已审查配置添加 `--apply`。脚本在启动前后均核对精确代理，并核对不可变文件摘要、依赖导入、实际公网健康摘要、邀请准入、公开 scope 和未认证拒绝；发布副本与数据库备份保存在运行目录。Cloudflare 管理状态正常不能替代实际公网端点的这些回读。

## 用户准入

真实用户先在 `/members` 登录、同意开通，再签发绑定该会员的邀请：

```sh
node --env-file=/绝对路径/私有配置/server.env scripts/members.mjs list
node --env-file=/绝对路径/私有配置/server.env scripts/members.mjs invite 会员ID \
  --output /绝对路径/私有邀请文件.json --expires-hours 24
```

确认接收人后通过已授权的私有渠道交付邀请。邀请不能写入公共页面、仓库或群发消息；本轮准备部署不意味着已经授权向任意联系人发送邀请。

## 上线验收

| 检查 | 必须留下的证据 |
| --- | --- |
| 公网可达与版本 | 独立网络 HTTPS 请求成功，健康摘要对应已审查运行文件 |
| 未授权访问 | MCP／A2A 无令牌为 401；会员等待邀请不能调用 |
| 原生客户端 | 用户实际 Codex 完成 OAuth，读取工具并提交需求；不是手工粘贴令牌的替代测试 |
| 独立用户 | 两个不同认证身份各完成本人任务，跨用户查询被拒绝 |
| 准确服务范围 | 目录只有配置的文档能力；建模、来源和付款权限不能借额外 scope 获得 |
| 持久完成 | Worker 真实模型执行；PA 读取 completed 和原交付物，数据库独立回读相符 |
| 续期和撤权 | 原访问令牌实际过期后正常续期；停用连接后旧令牌与刷新不能恢复资格 |
| 进程恢复 | 重启后仍可读取同一任务和交付物；不重复创建任务 |
| 原服务不受影响 | 原 `443`／`8443` 代理配置及私人服务入口保持一致 |

工程回归中的替身身份和协议请求不能替代上表的真实 Auth0、原生客户端和独立用户验收。检查过的摘要归档到 `docs/evidence/`；原始含个人信息的材料保留在忽略目录。

## 故障恢复

发布脚本在启动或回读失败时停止本次 Gateway／Worker 并恢复此前所属配置；保持数据库与执行历史供排查。隧道独立管理：若首次发布未成功且没有旧版本，只停止本次所属的 `com.eigos.invite-beta-tunnel`，或关闭本次新增的精确 Funnel 入口。后续恢复前重新核对隧道身份、DNS 与公开端点。保留其他应用的进程、域名记录与端口；Tailscale 关闭命令先以本机 `tailscale funnel --help` 确认语法，禁止全局重置。

参考：[Codex 原生 MCP OAuth](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Auth0 租户资源参数设置](https://auth0.com/docs/get-started/tenant-settings)、[Cloudflare Tunnel 配置与域名](https://developers.cloudflare.com/tunnel/get-started/)、[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)。
