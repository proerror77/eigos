# 部署入口与验收

正式实例只有 `com.eigos.primary`，其 Gateway／Worker 共享一份业务库、一份本体发布注册库和一个 authority ID。会员登录库独立存储，但只有一份会员身份权威。路由方法见[统一运行与路由](../architecture/runtime-authority.md)。

| 入口 | 用途 |
| --- | --- |
| `scripts/consolidate-runtime.mjs` | 对关闭后的数据库副本制定计划并复制合并；原库只读 |
| `scripts/relocate-primary.mjs` | 将已经统一的 primary 关闭副本搬到另一主机；保留 authority ID，更新绝对路径与 revision |
| `scripts/deploy-primary.mjs` | 更新唯一正式主实例的不可变代码快照与常驻进程 |
| `npm run setup:primary-pa` | 为 PA 配置主实例的原生客户端 |
| `npm run dev`、`Dockerfile` | 独立开发与测试；使用合成数据和隔离配置 |

构建、验证、提交后，先执行 `node scripts/deploy-primary.mjs --config /absolute/private/server.env` 检查部署条件，再以相同参数加 `--apply` 安装。配置须包含 `EIGOS_AUTHORITY_FILE`，与预先写入业务库的描述一致。安装器拒绝同时运行旧正式 profile，保留私有配置备份，并核对本机 authority ID 和构建摘要。反向代理须保留已登记的 Host；部署后仍要从每个真实入口独立回读。

预检只读现有业务库与会员库，不创建数据库、迁移权限或授予模型通道。两个库须位于运行用户的 `~/.local/share/eigos/primary/` 下，描述、持久 authority、Foundation v2 与 JWT 配置必须一致。配置、数据库、authority 和凭据均由该用户拥有，权限不宽于 `0600`，不能是符号链接或多重硬链接。启用 Harness 时，还核对外部运行版本和当前私有模型凭据；缺失或过期时拒绝部署。

主实例就绪探测通过 loopback 保留已登记的 Host，总等待上限为 120 秒，单次请求最多 15 秒且不会越过总截止时间。只有 HTTP 200、`status: ok`、authority ID 和本次构建摘要全部匹配才成功；请求失败或旧版本响应会在剩余时间内重试。失败信息包含最后一次探测原因，保留当前业务库，按日志向前修复。

旧 `setup:pa` 与 `deploy-member-network.mjs` 仅供尚未统一的历史安装；检测到 primary 标记即拒绝重建正式分叉。统一后旧启动项停用，数据库和配置留在私有恢复归档。提供商、浏览器代理、Mock 服务可以是独立进程，它们不持有另一份正式任务队列或本体权威。

迁移输入 JSON 指定 `sources: [{id,tasks,members}]`、`foundationSource`、`membershipSource` 和审核过的 `expectedPolicyDigest`。先运行 `node scripts/consolidate-runtime.mjs --input /private/input.json`，审查源摘要、身份映射及任务数；再提供新的 `--output`、私有 `--authority` 和 `--expected-source-digest` 并加 `--apply`。源文件必须是停止服务后取得的完整 SQLite 副本。会员合并要求 issuer／tenant／subject 完全相同，暂停或同意状态冲突会拒绝。只有一份现有 foundation 权限库可以作为权限基础；迁移自身不新增业务权限。

每个源表和原行进入不可变导入归档。任务 ID、任务 body、来源收据、外部操作键和历史定义指纹不重写；相同定义内容以不可变 release 别名保留原引用。键冲突、活动领取、未解决授权变更或开放草稿会拒绝迁移。旧任务的执行版本继续约束是否可运行，不能因为合并而重放。历史输出能否对某个安装开放，仍需独立授权和来源证明。

更新后核对真实入口的 `/health`、Agent Card、OAuth 发现、认证拒绝路径、同一任务跨入口回读和安装隔离。确认只有一个正式任务权威、所有 Worker 使用相同描述，且来源状态仍有效。代码同步、常驻进程更新与真实业务完成分别验收。

构建同时把完整 `eigos-delegate` Skill 复制到 `dist/integrations/grok/eigos-delegate/`，不可变 release manifest 包含每个主文件、参考和脚本。客户入口 `/connect`、公开 `/connect/agent.json` 及完整下载须在部署后从真实 origin 回读；不能依赖部署目录之外的源码文件。`setup:primary-pa` 保留既有单文件交接，并另外输出完整 Skill 目录；这不等于已在外部 PA 宿主中启用。部署不会替客户登录、批准权限或创建任务。

切换前保留关闭快照、配置与前端路由，核对哈希。主实例一旦接受新任务或授权变化，就保留其数据库并向前修复；不能恢复旧库而丢失结果或复活已撤销权限。业务订单、付款和未知外部效果的重试不属于部署操作。

## 最小 Linux 主机

一台有持久磁盘的 Linux 主机运行 Gateway、Worker 和按任务创建的 Ontology MCP；业务 SQLite 与会员 SQLite 分开存储。TLS／反向代理仍指向唯一主机并保留已登记 Host。2 核 4 GiB 可作为单个 Harness 并发的 MVP 起点，实际内存和延迟须按负载观察。此部署不把 SQLite 放在网络文件系统，也不让两台主机同时运行正式 Worker。

使用专用非 root 用户（例如 `eigos`）。管理员只需预先为其启用系统自带的 user manager 和 lingering：

```sh
sudo loginctl enable-linger eigos
```

以该用户登录后，`loginctl show-user eigos --property=Linger --value` 应为 `yes`，`systemctl --user show-environment` 应成功。部署器按当前 UID 使用 `/run/user/<uid>/bus`，拒绝 root、缺失 user manager、活动的旧正式服务或 system 级 primary。lingering 的启动语义见 [loginctl 文档](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)。

在 Linux 上获取已审核的提交，以 Node.js 22.13 以上执行 `npm ci`、`npm run check` 和 `npm run build`；不要复制 Mac 的 `node_modules`。Harness 运行时单独安装并固定版本，配置绝对 `EIGOS_HARNESS_BIN`。目录如下：

```text
~/.local/share/eigos/primary/
├── server.env / authority.json / release.json
├── state/<migration>/tasks.sqlite / members.sqlite
├── releases/<buildDigest>/
├── dependency-cache-v2/<lockDigest>/node_modules/
├── backups/                     # 配置和启动项备份，不覆盖现有业务库
└── stdout.log / stderr.log
~/.config/systemd/user/com.eigos.primary.service
```

完成下述关闭副本搬迁并准备私有环境文件后，仍使用同一部署入口：

```sh
node scripts/deploy-primary.mjs --config /absolute/private/server.env
node scripts/deploy-primary.mjs --config /absolute/private/server.env --apply
systemctl --user status com.eigos.primary.service
```

服务启用后随 user manager 启动，设置私有文件掩码与 `NoNewPrivileges`。停止预算为 60 秒，作用于整个进程组；应用内先完成最多 45 秒的恢复写回。服务规则参考 [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) 和 [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。关闭整台 ECS 前，先等待服务停止并确认原任务恢复状态已落库。

Harness 的 GPT OAuth 文件仅消费当前 access token。原登录是唯一 refresh 写入方；正式切换前必须明确登录维护方和私密副本更新方式，不能把一次复制视为长期有效的无人值守凭据。部署器不会替换模型接收方许可。若正式库没有当前 Harness 通道，须先完成独立授权流程，不能为通过部署预检自动创建。

云端可以使用独立的原生 Codex 登录维护此副本。安装 `@openai/codex@0.164.0`，在该主机专用的私有 `CODEX_HOME` 完成一次 ChatGPT 登录；不要复制仍由 Mac 使用的 refresh 凭据。私有 `--login-config` JSON 指定 `version: 1`、`codexBin`、`codexHome`、`credentialFile`，两个数据目录都必须位于该用户的 primary 运行目录内；`credentialFile` 必须与 `EIGOS_HARNESS_CREDENTIAL_FILE` 一致，且不能是原生 `auth.json`。

先运行 `node scripts/refresh-harness-login.mjs --config /absolute/private/login.json` 生成只含 access token 的副本，再给部署预览及应用命令加相同的 `--login-config /absolute/private/login.json`。原生 Codex 是唯一 refresh 拥有方；更新通过 `account/read {refreshToken:true}` 完成，不创建模型回合。使用 [官方认证流程](https://learn.chatgpt.com/docs/auth)和[原生认证 RPC](https://learn.chatgpt.com/docs/app-server#authentication)。

安装器增加 `com.eigos.primary.login.service` 与对应 timer。主实例启动依赖一次成功的登录检查；timer 每五分钟检查，仅在访问令牌不足十分钟时刷新。`flock` 保证刷新单位只持有一个写入者，输出以 `0600` 原子替换，失败保留上一次完整副本，不切换模型。不要同时让其他 CLI 使用该专用登录目录；人工重新登录前先停 timer。登录缓存不纳入应用回滚，不能恢复已经轮换失效的 refresh token。需要强制验证续期时，在相同的 `login-refresh.lock` 下运行刷新脚本的 `--force`，不要绕过锁并发执行。

## 将已统一的 Mac primary 搬到 Linux

`consolidate-runtime` 用于尚未统一的历史库，不能再次处理已有 primary。搬迁使用 `relocate-primary`；源和目标之间始终只允许一个正式写入方。以下步骤是操作流程，执行预览不会自动切换生产。

1. 排空任务并停止、禁用源主机的正式服务及其自动重启；保留 source commit、release、私有配置、前端配置和关闭快照。确认没有其他 Gateway／Worker／授权管理进程写入。单纯停止 SSH 会话不构成停机。
2. 在无写入状态下取得业务库与会员库的完整副本，关闭副本连接并转为 `journal_mode=DELETE`，确认没有 `-wal`／`-shm`／`-journal`。两库来自同一维护窗口；传输前后核对哈希，目的端私有文件由服务用户拥有。仅复制数据库主文件而遗漏 WAL 不符合条件。
3. 复制源 authority 描述作为只读输入。在 Linux 私有输入文件中填入 `authorityFile`、`businessSnapshot`、`membershipSnapshot` 和新的 `targetDirectory`（位于目标 primary 的 `state/` 下）。目的目录不得已存在，也不能直接输入源描述声明的活动库路径。
4. 运行预览，审核库哈希、任务数、会员数、authority ID、策略摘要及目标绝对路径；使用原预览 `sourceDigest` 才能复制应用：

```sh
node scripts/relocate-primary.mjs --input /absolute/private/relocation-input.json
node scripts/relocate-primary.mjs --input /absolute/private/relocation-input.json --apply --expected-source-digest <reviewed-sourceDigest>
```

5. 输出保留原任务 body、外部操作键、不可变本体 release、会员和原授权到期时间；authority ID、issuer 和 ingress 保持不变，只将目标路径和 authority revision 前进一版，对应策略 fence revision 前进一次。只在目标副本追加不可变搬迁收据。活动领取、恢复、未解决 fence 或无法与会员身份对应的当前许可会阻止搬迁。已经释放租约后保留的历史领取摘要映射原样保存，不会复活旧领取。开放定义草稿默认阻止搬迁；审核关闭副本后可在预览与应用时都加 `--preserve-unpublished`，将其计数和摘要纳入原预览，原样保留正文、revision 和 base release，不发布、不丢弃、不自动 rebase。工具不创建权限、不重放操作，也不启动服务。
6. 私有 `server.env` 指向输出的两库与 `authority.json`，逐项处理主机相关绝对路径和供应商私有配置；不要整份照搬 Mac 路径。按上节预检、安装。确认源仍禁用后才切换既有反向代理；随后运行部署命令加 `--apply --verify-ingresses`，检查每个登记入口的 authority／build 摘要、Agent Card、OAuth 发现及 MCP／A2A 未认证拒绝。该选项不登录、不批准权限、不创建任务。

真实切换还须用已授权的原任务从 MCP 和 A2A 独立回读，并验证安装隔离、取消／恢复和原操作身份。入口检查不代替这些业务数据验收。目的端接受写入后禁止直接恢复旧快照；需要迁回时再次排空并搬运最新关闭副本。ECS 的合成数据演练只证明 Linux 接线，不代表 Mac 正式数据、前端或 PostgreSQL 已经迁移。


## 固定版本的容器与发布产物

`Dockerfile` 提供独立的 `gateway`、`relay`、`worker`、`worker-codex` 目标；默认目标为 Gateway。镜像使用 Node.js 22.22.3 和锁文件 `npm ci`，运行用户为 `node`（UID 1000）。`worker-codex` 另安装固定 Codex CLI 0.164.0；基础 `worker` 不包含模型 CLI。当前主线没有已整合的 Harness adapter，因此发布入口明确拒绝 `backend=harness`，不能以安装 DSH 二进制冒充支持 PR #73。

构建上下文默认拒绝未列出的文件，包含构建必需的 PA Skill 源资产；运行镜像只复制实际 `releaseFiles` 白名单和生产依赖。数据库、`.env`、私有配置、认证文件和本机工具目录不进入镜像。`/var/lib/eigos` 用于外部持久状态；`CODEX_HOME=/home/node/.codex` 的认证须在运行时注入，`auth.json` 必须属于 UID 1000、为普通文件且权限为 `0600`。模型进程继续使用既有凭据白名单、任务范围和注册模型通道检查；安装 CLI 不授予业务或数据权限。

按需发布使用 GitHub Actions 的 **Release artifacts** 手动入口，明确提供完整源 SHA 与 backend。它先要求该准确 SHA 的最新 CI 及全部必要检查成功，包括类型、构建和进程级验证；缺失、运行中或跳过必要检查均停止发布。普通 PR／push 不触发 GHCR 发布。针对 Docker、发布脚本及构建源资产的 PR，独立的 **Container build smoke** 只构建 Gateway／固定 Codex Worker 并读取镜像内文件与非 root 身份；`push: false`、不登录 registry、不启动模型或服务。它用于给当前 PR 留下真实远端镜像构建证据，不代表已发布或完成部署。镜像先用 `sha-<完整SHA>-codex` 标签写入 GHCR，再记录构建实际返回的 `@sha256:` 引用与 provenance／SBOM；已有标签不会被此流程覆盖，部分失败时仅重跑失败的角色任务。

产物下载包 `release-<SHA>-codex` 包含 `manifest.json`、实际 runtime/source/lockfile 摘要、13 阶段官方内核的离线 `ontology/package.json`、固定 document/model digest 及供应商模块引用。`payloadDigest` 固定镜像内的代码与本体文件，`manifestDigest` 另外绑定外部 OCI 引用和准确源 CI，避免镜像包含自身摘要的循环。缺少任一镜像 digest 或 CI 记录时只能是 `candidate`；`artifact-ready` 只表示这些发布产物已齐备。

产物可用以下只读入口复核，不能据此推定实例已部署：

```sh
node scripts/release-artifacts.mjs verify --root /private/release-package --require-ready
```

该手动流程当前构建 `linux/amd64`，部署前核对 ECS 的实际架构。镜像适用于 ECS／兼容 OCI 的运行环境；Cloudflare Workers 的请求入口仍使用独立 Workers 构建，不能把 Docker target 直接当成 Workers 脚本。部署须使用 manifest 中准确的 `image@sha256:...`，显式注入私有环境、同一 authority 描述与已验证的数据库连接。现有默认运行入口仍有 SQLite 路径，产物生成不会替代 PostgreSQL 运行时、两协议或业务权限验收；跨主机也不能各自启动一份 SQLite 正式库。

本体包没有数据库 `releaseId`、published／active 声明。将离线包校验、不可变发布、候选代码部署和 CAS 激活分别执行，见[固定本体与发布流程](ontology-releases.md)。回滚代码时固定上一份已核对兼容性的镜像 digest 和实际发布引用；仍使用当前业务库，禁止用旧数据库覆盖后续任务、结果或撤销记录。部署后从真实 Gateway／Relay／Worker 路径回读 source/build、authority、实际本体引用与原任务结果，才能认定该次切换完成。

## 业务事实内核 v24

这是显式的 v23 → v24 更新，代码启动不执行迁移。维护窗口中停止 Gateway／Worker，保留业务库备份和准确恢复记录，再分别预览并审核以下入口：

- `scripts/upgrade-business-facts-policy.mjs`：使用准确旧策略 digest/revision；加 `--apply` 才修改策略。保留已有动作／函数许可及其到期时间，不增加来源或输出字段授权。v22 安装先走原 v22 → v23 的 RollingGo 迁移，不能跳过历史合同。
- `scripts/install-business-facts.mjs`：使用准确 active release digest/generation；加 `--apply` 才激活新增业务定义。只接受已核对的 v23 前身，或对已经完成的 v24 返回原结果；不改写旧事实或任务 pin。

两个入口都要求明确的私有数据库路径；正式库还要求匹配的 `EIGOS_AUTHORITY_FILE`。先完成策略迁移，再安装本体发布。新对象类型与字段仍需按具体来源和任务单独审核授权，不能自动扩大旧授权。完成后检查发布摘要、旧任务回读、新任务实体／关系投影和来源撤销。本流程不调用供应商业务动作。

## PostgreSQL 迁移前业务库盘点

`node scripts/business-postgres-preflight.mjs --snapshot /private/offline-business.sqlite --authority /private/authority.json --policy-digest <reviewed-digest>` 对**停止写入后的私有 SQLite 副本**做只读盘点；先运行 `npm run build`。副本须完成 checkpoint、使用 `DELETE` journal 模式，且没有 WAL／SHM／journal 文件。它核对受保护的运行权威描述和已审查的权限策略摘要，拒绝尚有 Worker 领取、有效管理／网络租约、运行中的恢复或未解决权限围栏的副本。开放草稿会校验原始身份、文档、基准发布及代次后原样保留；过期基准不会自动重置或发布。

报告仅包含表结构、唯一键信息、行数、编码总量、最大编码行大小和摘要、索引／触发器数量、SQLite 自增序列高水位以及源文件摘要，不包含行正文。版本 2 还记录并校验每张业务表的 SQLite 隐含行序，导入时将其保存在 PostgreSQL 的 `__eigos_rowid`；新的行序使用独立序列，保留自增表的高水位。它拒绝当前未定义映射的列类型、生成列、`WITHOUT ROWID` 和 `STRICT` 表，并检查无法无损进入 PostgreSQL 的值。报告本身仍属于内部迁移证据，应保存于仓库外的私有位置。

Gateway 的会员、安装、会话和撤销状态由 `MEMBERSHIP_DATABASE_PATH` 指定；未设置时默认使用业务库路径加 `.members`。业务快照导入不会复制这些数据。切换前须一并迁移并核对会员身份、安装绑定、连接封禁、令牌及邀请状态，并验证它们与业务库中的授权和任务身份一致；不得通过重建安装或重新授予权限掩盖缺失记录。运行时 PostgreSQL 适配完成并验证两库的受控切换之前，不得把业务导入结果设为正式运行权威。

会员库可使用 `node scripts/membership-postgres-import.mjs --apply --snapshot /private/offline-members.sqlite --expected-file-digest <reviewed-digest> --schema eigos_membership_example --max-database-bytes <reviewed-byte-budget>` 导入独立私有 schema，连接环境与 CA 配置同业务导入。它仅接受当前已审查的会员库结构及不大于 64 MiB 的私有离线快照，逐表回读并记录摘要；不激活服务或授予运行时角色。导入后仍须核对会员库和业务库的一致性，并完成运行时适配。提交响应丢失时必须先检查目标 schema 的 `eigos_membership_migration_receipt`，不可覆盖重试。

两份快照导入后可执行 `node scripts/postgres-identity-audit.mjs --business-schema eigos_business_example --membership-schema eigos_membership_example --business-digest <reviewed-business-digest> --membership-digest <reviewed-membership-digest>`。该检查绑定两份迁移回执，在一致的只读事务中比较尚未过期的活跃身份投影与会员、安装及连接状态，仅输出总数与不匹配数量；不匹配时退出失败。它不核验全部授权、任务和外部效果，不能单独作为切换或授权依据。

`packages/postgres/runtime-transaction.ts` 提供 PostgreSQL 写事务的基础围栏：同一业务 schema 的协作写入共享锁，在事务前后核对并锁定运行权威；事务连接须处于空闲状态，执行前后核对事务身份；提交或事务边界结果不明时禁止自动重试。此组件尚未接入 Gateway 或 Worker，调用者仍须在同一事务中核对任务、领取和授权，并等待全部数据库操作完成；所有业务写入者必须采用同一锁，权威行锁通过固定查询路径的受控数据库函数取得；函数默认不授予 PUBLIC 执行权。合成测试验证了受限角色能调用该函数而不能读取或修改权威表。正式运行角色的配置和完整权限验证仍未完成，不能据此启动 PostgreSQL 运行时。

PostgreSQL 领取校验与续租组件现可在事务中核对原领取令牌、权威摘要、任务版本和当前授权；校验只返回有界状态与版本字段，不向运行进程传送完整任务正文。数据库端仍需解析正文，超大任务的数据库内存、完整读取、领取创建、过期恢复、结果提交及完整权限范围尚未解决，也尚未接入 Worker。

PostgreSQL 任务授权查询现可在上述业务事务中对照成员代次、父授权和任务授权版本、租约、策略摘要与请求版本；调用者必须使用受信任的运行时代码中已审查的策略摘要，不能采用请求方提供的摘要。它不验证 Worker 领取、任务执行状态或完整权限范围，也尚未接入 Gateway／Worker。不能将此查询的结果单独用作执行授权。

**业务库盘点入口只读，不写入 PostgreSQL，也不代表业务库可切换。** PostgreSQL 结构、全部业务和权限事务、历史不可变触发器、共享 Worker 领取及 MCP／A2A 运行路径仍需迁移并验证。切换后产生的新任务、授权和外部效果不能通过恢复旧 SQLite 副本抹除或重放。

预备的离线导入入口使用 `EIGOS_BUSINESS_POSTGRES_URL` 和绝对路径 `EIGOS_BUSINESS_POSTGRES_CA_FILE`；连接 URL 不允许附带可能覆盖 TLS 校验的参数。先审查盘点报告中的 `fileDigest`、权限策略摘要和容量，再显式执行：

```sh
node scripts/business-postgres-import.mjs --apply --snapshot /private/offline-business.sqlite --authority /private/authority.json --policy-digest <reviewed-policy-digest> --expected-file-digest <reviewed-file-digest> --schema eigos_business_example --max-database-bytes <reviewed-byte-budget>
```

导入只创建新的私有 schema，不授予运行时角色，也不修改源文件或激活新权威。它拒绝未审查的 SQLite 结构、JSON 语义不兼容和源摘要变化；复制后按主键逐表回读摘要，保留序列高水位，在数据复制完成后再安装不可变历史和网络缓存失效触发器。业务 JSON 索引字段和网络身份键须保持已审查的类型，SQLite 与 PostgreSQL 对 JSON 有效性的差异会使导入回滚。提交响应丢失时，结果可能未知；应查询该 schema 的 `eigos_migration_receipt` 并核对摘要，不要重试覆盖。

容量检查以 `pg_database_size` 为基础，并不包含 PostgreSQL WAL 或保证满足托管平台配额；必须保留额外空间并根据实际目标大小重新评估。大记录按单行处理，测试覆盖合成 42 MiB 任务；这不代表 Cloudflare 入口已具备读取相同大小任务的能力。业务运行时代码和 MCP／A2A 仍需完成 PostgreSQL 适配及权限、领取、取消、恢复和跨入口联调，才能启用目标库；所有依赖 SQLite `rowid` 的排序和游标必须改用 `__eigos_rowid`，不能按主键或时间猜测顺序；数据库触发器拒绝普通更新改写已有行的该值，普通插入也不能显式指定该值；导入器使用明确的覆盖语法，运行角色还需禁止绕过序列。旧版不含行序的业务导入回执不能用于新版身份核对或正式切换。
