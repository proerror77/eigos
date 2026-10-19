# Gateway、Worker 与共用任务核心

## 目录与职责

本仓库采用一个 TypeScript 工程，保留一份依赖锁文件与统一验证流程；目前无需分别发布 npm 包。

| 目录 | 职责 |
| --- | --- |
| `apps/gateway/` | MCP、A2A、OAuth 资源服务器、HTTP 审计；接收／查询／回复／取消任务 |
| `apps/worker/` | 后台领取任务、调用模型和业务适配器、续租、超时、执行结果回写 |
| `packages/core/` | 任务与身份模型、TaskService、SQLite 存储、幂等收据和执行领取契约 |
| `packages/capabilities/` | 业务输入契约、文档模型执行器、跑腿适配器、CSV 模拟服务与验收 |
| `packages/members/` | Gateway 专用会员资料、登录会话及连接停用记录；Worker 不读取 |
| `apps/local.ts` | 测试和独立示例的显式进程内组合；不是生产入口 |

Gateway 不启动模型、跑腿凭据适配器或后台执行定时器。新 `eigos.delegate` 的本体解释、候选准备、计划推理、异步执行和独立验收都在 Worker；Gateway 只接受提交、精确模拟授权和查询/取消。原始 CSV 快照由 Worker 准备并私有持久化，不进入模型或任务 metadata。新的目录、适配器和边界见 [后端说明](registered-capabilities.md)。旧需求登记、直接执行、跑腿订单和 CSV pilot 的分发及状态机均已删除。可复用的 CSV 解析／验收程序归入新能力包。

## 启动

```sh
npm ci
npm run setup:dev
npm run dev
```

`dev` 启动两个独立子进程；任何一个退出时，启动器也停止另一个。默认启用新协调器；模型运行需要既有 Codex 登录。真实下单或付款没有可启用的运行分支。

也可分两个终端运行：

```sh
npm run dev:gateway
npm run dev:worker
```

构建后分别使用 `npm run start:gateway`、`npm run start:worker`。`npm start` 是同机双进程的便利启动器。

两个进程必须使用同一个本机 SQLite 文件（建议设置相同的绝对 `DATABASE_PATH`），并由相同系统用户或明确配置的文件权限访问。独立进程不能使用 `:memory:`。Gateway 和 Worker 的能力开关应保持一致；能力目录表示配置的服务，并不保证当前有健康 Worker 在线。Worker 不在线时，任务会持久等待，协议状态仍为 `working`。

Gateway 需要访问令牌验证配置；Worker 不要求开发 Bearer 令牌或 OAuth/JWKS 配置，不监听 HTTP。只有 Worker 主机需要安装和登录 Codex，或持有业务适配器凭据。`EIGOS_EXECUTOR=codex` 在 Gateway 用于声明能力，在 Worker 用于启用执行器；`EIGOS_CODEX_BIN` 和模型超时只由 Worker 执行时使用。生产应分别注入各角色所需环境变量，不必把完整 `.env` 同时发给两端。

会员资料库默认位于 `DATABASE_PATH + .members`，也可由 `MEMBERSHIP_DATABASE_PATH` 指定；只有 Gateway 需要该文件及 `OIDC_CLIENT_ID`／`OIDC_CLIENT_SECRET`。备份会员库与任务库时保留各自权限。会员开通与令牌 scope 都通过后才接收任务；已接受的任务不会因会员停用被当作供应商业务已取消。详见 [会员资料库与 OAuth](membership.md)。

## 任务领取与故障行为

- 新任务和补充回复在一个 SQLite 事务内保存任务及幂等收据。未领取的 `working` 任务就是持久待执行项，Gateway 重启不会清空或标记失败。
- Worker 用 `BEGIN IMMEDIATE` 原子领取；同一任务只能有一个有效令牌，同一数据库最多同时有两个已领取任务。多个 Worker 必须共享同一个文件，不能复制数据库实现扩容。
- 默认每 100ms 检查队列／取消状态，领取有效期 15 秒。结果写回必须同时匹配领取令牌、有效期、任务 revision 和 `working` 状态。
- 取消先持久化，再由 Worker 检测并中止执行。迟到结果无法覆盖取消；停止调用并不证明已经发生的外部动作被撤销。跑腿订单仍禁止用任务取消代替供应商订单取消。
- Gateway 的同步等待最多五分钟，到期返回错误；任务继续存在，客户端用查询获取结果。长任务优先使用 A2A `returnImmediately: true`。
- Worker 正常退出会中止活动调用，记录失败；未领取任务仍保留。强制退出后，由存活或重新启动的 Worker 检测过期领取，标记 `failed` 并明确外部执行结果未知，不自动重放已开始调用。没有 Worker 时，过期检查也要等待 Worker 恢复。
- v3 派发前保存 ActionIntent 与 ExecutionAttempt，网络调用在事务外；返回先追加 Observation，再用当前领取令牌推进 Task。接单/付款后崩溃进入 effect_unknown，由新 Worker 查原键，不能重下单或释放未知支出。取消/租约丢失的迟到事实仍保存，旧源版本和重复回执不能覆盖新事实。
- 异步任务按 nextAt 持久等待。取消/撤销后的已发操作可在只读恢复模式查证，终态 Task 不因此重开；售后建立新的关联任务。授权和累计预算在每次新派发/业务续接前重查。
- v9 Agent 动作计划由模型选择并持久化。每轮结束后释放领取，下一轮从已接受的本体观察继续决策。观察、本体投影和 Agent 状态在原领取令牌下原子写入；失效领取的迟到回包仅作审计。中断读取不自动重放，新模型决策可明确提出新的只读动作。
- Agent 沙箱业务动作每轮至多一个，必须以已读取的固定输入取得准确计划许可；每次派发重查作用、币种、金额、收款方、有效期与撤销状态。未知写入只查原幂等键，不能重新提交。取消后的原操作回读可以完善动作账本，不能重开任务或投影新的业务完成。
- 旧委托不匹配当前 `ontology-execution-v9` 标识时保留只读，不领取/续接/取消，不自动迁移。更新既有实例前停止旧 Worker 并备份，禁止新旧 Worker 在同一数据库混跑。本人常驻部署由 setup:pa 管理；旧代码保留在私有备份。

## 部署边界

启用新后端和个人美团读取时，Worker 通过内部 stdio Ontology MCP 调用官方查询程序；Gateway 不启动该进程、模型或业务读取。两端使用相同 `EIGOS_PAOTUI_SKILL_DIR` 以固定能力／绑定配置，只有 Worker 需要实际个人授权。MCP 只提供版本化定义与只读动作，没有公网监听、下单或付款工具；独立进程不构成新的公共服务。详见 [只读接入](meituan-paotui-integration.md)。

本人常驻服务先构建，再用 `npm run setup:pa` 更新。公开地点 DiscoverySource 默认关闭；明确获准后可在这次更新命令中设置 `EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES='[{"city":"北京市","keyword":"天安门"}]'`。更新脚本复用运行配置的校验器，在停止服务前拒绝非法清单。之后省略该变量会保留已管理实例的清单；显式设为 `[]` 可关闭新发现源。清单同时写入 Gateway／Worker 共用的私有配置，不扩大个人凭据权限；真实查询及模型验收仍按本次任务授权范围执行。

Shopify 匿名查询使用 `EIGOS_SHOPIFY_CATALOG_MERCHANTS` 显式列出商家身份（内部 id、名称、Shop GID、canonical myshopify 域名）。默认关闭，最多 8 家，身份不得重复；仅允许本机开发身份、loopback 和非生产环境。Gateway 只构造能力元数据，实际 HTTP 读取及模型由 Worker 执行。`setup:pa` 同样保留既有清单，显式 `[]` 关闭；启用时将原始响应和回执保存到私有 `shopify-reads/`，不读取 Shopify 账号凭据。Agent 自行选择查询、变体、动作组合及完成时机；价格等事实变化作为新的观察交给 Agent，没有固定复查或自动重试流程。当前实现、边界与 PA 验收状态见 [Agent 动作说明](catalog-agent-actions-2026-10-19.md)。

交易模拟器由独立 `apps/commerce-sandbox` 进程运行；Gateway 和 Worker 都不会在构造能力目录时启动它。构建后可用 `npm run setup:commerce-sandbox` 管理本机 `127.0.0.1:3432` 实例，再向 `setup:pa` 提供其 URL 和私有凭据文件路径。后续更新保留既有绑定。模拟器拥有独立 SQLite、合成资料和签名凭据，没有真实厂商或支付凭据及对外调用实现。准确配置和验证边界见 [交易沙箱](commerce-agent-sandbox-2026-10-19.md)。

当前适用于同机、持久本地磁盘上的 Gateway／Worker 分进程部署。SQLite WAL 不用于跨机器网络文件系统。跨主机和容器集群扩容，需要以后替换共享存储／队列实现并重新验证故障恢复。

Docker 镜像默认启动 Gateway，也包含构建后的 Worker 代码。Worker 可覆盖命令为 `node dist/apps/worker/main.js`，但启用 Codex 的 Worker 还需要单独准备 CLI 和其运行凭据；镜像不包含个人登录信息。容器分进程运行时需挂载同一宿主本地持久卷，并确保权限一致。

本次代码验证包括两条协议的既有隔离测试、两个 Worker 子进程争抢同一任务、跨协议补问续接、Gateway 重启、Worker 强制退出后的过期恢复、取消和迟到结果保护。模型和供应商使用测试替身；这些检查不代表真实业务履约或生产部署已经验证。

2026-10-15 本地验证：`npm run check`、57 项 `npm test`、`npm run build` 与 `git diff --check` 通过；构建后的双进程启动器通过健康检查和已认证 A2A 说明生成；Docker 镜像构建通过，两个非 root 容器共享本地持久卷启动并通过 Gateway 健康检查。容器检查关闭外部网络，未启用模型、下单或付款。
