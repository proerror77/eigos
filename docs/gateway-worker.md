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

Gateway 不导入模型执行器或跑腿凭据适配器，不启动后台执行定时器。`brief.prepare` 是无外部副作用的说明生成，可直接完成；CSV 报价／确认／取消只是任务状态转换，实际模拟履约在 Worker 进行。本地 CSV 导入在 Gateway 对配置目录内的输入取快照，再交由 Worker 使用，避免后续文件变化改变已确认的输入。

## 启动

```sh
npm ci
npm run setup:dev
npm run dev
```

`dev` 启动两个独立子进程；任何一个退出时，启动器也停止另一个。默认能力仍关闭，不会自动启用模型调用、真实下单或付款。

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
- 首次迁移旧数据库时，旧版遗留的非模拟 `working` 任务标记失败，防止把曾经开始的调用误当成新队列项。旧版中断的 CSV 模拟服务继续按其持久步骤恢复。迁移前应停止旧版进程并备份数据库及跑腿密钥文件。
- CSV 模拟步骤在 Worker 内与 Gateway 状态修改串行化，只涉及本地模拟账本。这个事务不构成真实支付或外部副作用的 exactly-once 保证。

## 部署边界

当前适用于同机、持久本地磁盘上的 Gateway／Worker 分进程部署。SQLite WAL 不用于跨机器网络文件系统。跨主机和容器集群扩容，需要以后替换共享存储／队列实现并重新验证故障恢复。

Docker 镜像默认启动 Gateway，也包含构建后的 Worker 代码。Worker 可覆盖命令为 `node dist/apps/worker/main.js`，但启用 Codex 的 Worker 还需要单独准备 CLI 和其运行凭据；镜像不包含个人登录信息。容器分进程运行时需挂载同一宿主本地持久卷，并确保权限一致。

本次代码验证包括两条协议的既有隔离测试、两个 Worker 子进程争抢同一任务、跨协议补问续接、Gateway 重启、Worker 强制退出后的过期恢复、取消和迟到结果保护。模型和供应商使用测试替身；这些检查不代表真实业务履约或生产部署已经验证。

2026-10-15 本地验证：`npm run check`、57 项 `npm test`、`npm run build` 与 `git diff --check` 通过；构建后的双进程启动器通过健康检查和已认证 A2A 说明生成；Docker 镜像构建通过，两个非 root 容器共享本地持久卷启动并通过 Gateway 健康检查。容器检查关闭外部网络，未启用模型、下单或付款。
