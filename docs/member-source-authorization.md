# 会员使用自己的服务账号

2026-10-19。接续 `26a2359`，将来源接入扩展为“每名使用者的 PA 连接本人账号”。默认关闭，保持非生产、同机 loopback HTTPS/JWT 范围。当前 v8 已更新独立私有测试实例，见 [验证与部署记录](evidence/paotui-agent-v8-2026-10-19/README.md)。本人完成平台授权后，真实 PA 的[本人地址簿查询](evidence/member-source-live-2026-10-19/README.md)及[一次真实费用预览与回读](evidence/member-quote-live-2026-10-20/README.md)已通过；后者包含原任务取消后的一次关联查询，不能视为无缝续办。没有真实订单或付款。

## 用户与 PA 的路径

1. 会员能看到经审核的服务介绍。该服务需要账号时，目录返回 `requires_own_authorization`，并提供本人连接的状态和下一步。
2. PA 通过现有 EIGOS 登录、会员准入和安装登记取得本人的 OAuth 权限。服务账号连接额外使用 `sources:read`／`sources:write`；已有令牌不自动扩权。
3. PA 在用户自己的运行环境取得官方美团 `MCP_ACCESS_TOKEN`。没有凭据时，通过官方授权流程交给本人完成。EIGOS 不代替供应商登录，也不声称已经具备供应商原生 OAuth 回调。
4. PA 的宿主代码通过独立 HTTPS 接口提交凭据；模型只看连接请求标识与状态。Token 不进入 MCP 参数、A2A 消息、Task、社交发布或 SDK 缓存。
5. Gateway 从已验签的身份和已登记安装解析 owner、memberId、installationId。请求正文不能指定这些身份。连接接受后返回 `connected` 和 `credentialValidation=not_provider_verified`；这仅表示已安全接收，供应商是否接受该令牌须由后续只读请求证明。
6. 私有询价可以先创建本人 Task。没有有效连接时，Worker 将原任务置为 `auth-required`，并返回 `sourceAuthorization`。PA 完成连接后调用 `resume_source_task`，继续原 Task；仍须补齐地址、重量和服务类型。
7. Worker 使用该 owner 的连接执行本人地址读取和运费预览。同凭据续期后重新查询，并核对保留的地址选择；凭据替换、安装变化或撤销后重连不能沿用旧编号上下文。撤销和到期禁止后续读取，并拒绝在途返回的结果。查询结果不代表下单或履约。

## 能力与入口

| PA 需要做的事 | MCP 工具 | 独立 HTTP 接口 | 权限 |
| --- | --- | --- | --- |
| 发现可连接的服务 | `list_source_connections` | 服务目录及 MCP | `sources:read` |
| 查看本人的连接 | `get_source_connection` | `GET /sources/meituan-paotui` | `sources:read` |
| 发起／更换连接 | `begin_source_connection` | `POST /sources/meituan-paotui/begin` | `sources:write` |
| 安全提交本人凭据 | 不暴露 Token 工具参数 | `POST /sources/meituan-paotui/credential` | `sources:write`，同一安装 |
| 撤销连接 | `revoke_source_connection` | `POST /sources/meituan-paotui/revoke` | `sources:write` |
| 继续原任务 | `resume_source_task` | `POST /sources/meituan-paotui/resume` | `sources:read`、`tasks:write` |

所有接口沿用 EIGOS Bearer JWT、会员状态和 PA 安装校验。浏览器 cookie 不作为凭据上传授权，带 Origin 的写请求拒绝。没有 Token 查询／导出 API。

`begin` 只接受 `{requestId, expectedRevision}`；初次 revision 为 0。返回的上传请求有十分钟期限，绑定本人身份、安装和预期连接版本。`credential` 只接受 `{requestId, token, expiresAt}`。`expiresAt` 是 EIGOS 保留／使用这份连接的期限，须在未来 24 小时内；参考 PA helper 使用一小时。供应商可能更早使 Token 失效，此期限不是供应商有效性保证。

相同上传可重试丢失的确认。新版本写入后，旧上传不能恢复旧连接。撤销同时废止待上传请求；重复撤销不会复活连接。`resume` 需要 `{taskId, requestId, expectedRevision}`，只能继续正等待来源授权的本人任务；它不授予任何业务写操作权限。恢复后通过 `get_task` 或 A2A GetTask 回读最新状态。

## 原有能力如何复用

当前已整合 v8 AgentRuntime，采用 `delivery.quote@3`、`address.book.read@2`，继续复用地址选择规则、Ontology MCP、官方 CLI、来源回执、Task、本体投影、询价与精确分享许可。模型选择地址簿、地址详情、费用预估及完成依据；连接器一次只调用一个官方读取接口，见 [Agent 动作说明](paotui-agent-actions-2026-10-19.md)。服务 listing 的 binding 固定读取程序和策略，不携带发布者账号。任务范围绑定买方自己的连接版本；受限本体字段保存不含 Token 的连接标识与私有业务快照。

Gateway 不启动读取器。Worker 及内部 MCP 从业务库读取加密凭据，均在每条外部读取前后检查当前版本、到期、会员／客户端／安装撤权。每次官方 CLI 调用只注入该 Token，使用独立临时 HOME 和工作目录，不调用服务器操作人的 `pt-passport`，临时目录在结束时清除。

原有持久领取、取消、租约和迟到结果保护继续有效。来源问题只允许继续只读任务，不能借恢复接口重复业务写操作。恢复会归档旧 Agent 计划，保留已用预算和已确认回执，重新建立范围；旧观察不能用作新范围证据。同一会员、安装和凭据续期时，数字回复仍绑定实际展示时的列表，当前所选地址 ID 与内容一致即可继续；补充重量、列表重排或无关地址变动不会丢失已确认选择。凭据替换等无法证明连续性的情况仍需新选择。执行窗口、长任务档位和解释复用见[任务恢复说明](task-recovery-2026-10-20.md)。

从旧单会员模式切换后，已有服务 listing 须按新的 binding 配置摘要重新审核；旧计划、来源引用和上传请求不自动迁移到新账号模式。

## 存储与配置

业务库的私有表以 AES-256-GCM 保存密文，关联数据绑定 owner、安装、连接版本、期限和配置。密钥是库外当前系统用户拥有的 32 字节普通文件，权限 0600；拒绝符号链接、硬链接和不安全权限。密钥标识与读取程序配置在业务库固定，Gateway、Worker 和内部 MCP 不一致时拒绝启动／读取。更换供应商 Token 用上述连接版本流程；更换加密密钥需要独立迁移，不能直接覆盖文件。

HMAC 指纹阻止已经绑定过的同一 Token 被另一会员重新提交；指纹在轮换或撤销后保留，不公开返回。这个检查不能证明任意首次提交的 bearer Token 在供应商侧属于谁；来源是会员 PA 的本人账号授权声明，不能标为供应商对 EIGOS JWT 身份的认证。

Gateway／Worker 使用相同配置：

```dotenv
EIGOS_PAOTUI_SKILL_DIR=/absolute/path/to/official/meituan-paotui
EIGOS_MEMBER_SOURCE_KEY_FILE=/absolute/path/to/data/private/member-sources.key
EIGOS_PAOTUI_ORDERS_ENABLED=false
```

另需已有 `EIGOS_AUTH_MODE=jwt`、HTTPS `PUBLIC_URL`、loopback HOST、持久业务库、网络准入名单和 PA 客户端。与 `EIGOS_PAOTUI_MEMBER_CONNECTION_FILE` 互斥，也不启用公共地点发现。

现有私有 Tailscale HTTPS 可通过 `EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN` 明确启用：它必须与 PUBLIC_URL 完全相同，并以 `.ts.net` 为主机域名。Gateway／Worker 每次启动都读取本机 Serve 配置，要求该精确端口为 HTTPS、唯一根路径转发至本实例的 `127.0.0.1:PORT`，且该端口未启用 Funnel。其他端口的现有服务不受影响；没有私有代理证明就拒绝启动。此配置仍禁止生产模式和非 loopback 监听。

专用 macOS 部署使用 `node scripts/deploy-member-network.mjs --config /absolute/private/config.env` 先检查，再加 `--apply` 启动 `com.eigos.member-network`。它要求已提交的构建、独立会员／任务库和私有密钥，保存不可变发布副本与恢复备份，核对 HTTPS 健康摘要、scope 发现和未授权 401；失败恢复旧服务配置。它不获取用户 Token，不修改 IdP，也不调用业务提供方。

Auth0 配置计划支持 `--member-sources`，只加入上述两个来源 scope，并保留既有 scope。未指定 `--apply` 时只生成本地计划。私有服务已更新；本人重新登录后，现有 IdP API 已补齐来源 scope，验证 PA 也已取得新权限并完成本人凭据的私有传输。已登录 PA 若缺新 scope，须重新经过用户同意。

PA 宿主可调用 `AgentConnector.connectSource({requestId, expectedRevision, loadCredential})`；回调在本机读取本人凭据。SDK 固定上传到当前 EIGOS origin，拒绝重定向、外部路径和请求标识不匹配，不把 Token 保存到登记缓存，异常也不回显凭据。

可执行参考位于 `examples/connect-member-source.ts`。在**用户自己的 PA 主机**完成官方美团授权及 EIGOS 接入后，明确配置 `PUBLIC_URL` 与 `EIGOS_AGENT_CREDENTIAL_PATH`，再运行：

```sh
node --import tsx examples/connect-member-source.ts
```

该命令会传输本人 Token，不属于测试命令。它不发起查价、不自动继续任务；PA 再按原 taskId 调用恢复工具并读回结果。

原[单会员操作人连接](member-source-connection.md)仍作为显式兼容模式保留；本节是其他会员自行连接账号的接入路径，两种模式不会互相回退。

## 验证与剩余边界

验证覆盖两个 JWT 会员、各自不同 Token／地址／报价、实际 Worker 和 stdio MCP 子进程、服务目录至买方 Task、原任务恢复、版本重放、期限、连接轮换、在途撤销、会员／安装撤权、密文篡改、密钥／目录不一致、无本机凭据回退，以及 SDK 的同源传输和错误脱敏。

工程测试中的模型决策、账号和商家返回使用隔离替身，见[工程证据](evidence/member-source-auth-2026-10-19/README.md)。随后在本人完成授权后，真实 PA 和当前版本本人来源只读查询已通过[实际验证](evidence/member-source-live-2026-10-19/README.md)。人工非建模者演练和 T13 其余验收仍单列。

独立私有 HTTPS 实例已更新至 v8 并完成运行文件及接口回读；随后已完成 Auth0 来源权限、PA 会员授权和真实本人地址簿查询，见 [真实回路记录](evidence/member-source-live-2026-10-19/README.md)。当前版本见 [v8 验证与部署记录](evidence/paotui-agent-v8-2026-10-19/README.md)，初次部署与依赖修复保留在 [历史部署记录](evidence/member-network-deployment-2026-10-19/README.md)。

2026-10-20 在数量解释修复版本完成了[真实文件查价](evidence/member-quote-live-2026-10-20/README.md)：本人先选择地址并确认500克及普通送，真实模型执行4次官方只读操作，PA 的最终 MCP、独立 A2A 与持久化结果一致。长时间等待及连接续期使原任务只剩4次模型额度，已保留历史并由 PA 取消；实际报价来自一次明确关联、已补齐事实的后续任务。未重置原预算，也未绕过来源或地址校验。

任务恢复修复后，已进一步通过[同一 Task 的真实 PA 验证](evidence/task-recovery-live-2026-10-20/README.md)：补充信息、连接实际到期、本人凭据续期和报价完成均沿用原 taskId。没有替代任务或额外人工确认；19次模型调用保留，1次费用预览与最终回读通过。
