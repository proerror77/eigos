# 部署入口与验收

正式实例只有 `com.eigos.primary`，其 Gateway／Worker 共享一份业务库、一份本体发布注册库和一个 authority ID。会员登录库独立存储，但只有一份会员身份权威。路由方法见[统一运行与路由](../architecture/runtime-authority.md)。

| 入口 | 用途 |
| --- | --- |
| `scripts/consolidate-runtime.mjs` | 对关闭后的数据库副本制定计划并复制合并；原库只读 |
| `scripts/relocate-primary.mjs` | 将已经统一的 primary 关闭副本搬到另一主机；保留 authority ID，更新绝对路径与 revision |
| `scripts/deploy-primary.mjs` | 更新唯一正式主实例的不可变代码快照与常驻进程 |
| `npm run setup:primary-pa` | 为 PA 配置主实例的原生客户端 |
| `scripts/postgres-primary-handoff.mjs` | 预览并分别安装 PostgreSQL 运行扩展／最小权限、记录经审查的激活 |
| `scripts/postgres-node-migrate.mjs` | 离线迁入原 Relay／通信节点 v2 快照并独立完整回读 |
| `npm run dev` | 独立开发与测试；使用合成数据和隔离配置 |
| `Dockerfile`／发布产物 | 固定 Node 运行镜像；部署和激活另行验收 |

以下 `deploy-primary` 和 SQLite 搬迁流程用于既有常驻 SQLite 安装；它们不代替后文的 PostgreSQL handoff。构建、验证、提交后，先执行 `node scripts/deploy-primary.mjs --config /absolute/private/server.env` 检查部署条件，再以相同参数加 `--apply` 安装。配置须包含 `EIGOS_AUTHORITY_FILE`，与预先写入业务库的描述一致。安装器拒绝同时运行旧正式 profile，保留私有配置备份，并核对本机 authority ID 和构建摘要。反向代理须保留已登记的 Host；部署后仍要从每个真实入口独立回读。

预检只读现有业务库与会员库，不创建数据库、迁移权限或授予模型通道。两个库须位于运行用户的 `~/.local/share/eigos/primary/` 下，描述、持久 authority、Foundation v2 与 JWT 配置必须一致。配置、数据库、authority 和凭据均由该用户拥有，权限不宽于 `0600`，不能是符号链接或多重硬链接。启用 Harness 时，还核对外部运行版本和当前私有模型凭据；缺失或过期时拒绝部署。

主实例就绪探测通过 loopback 保留已登记的 Host，总等待上限为 120 秒，单次请求最多 15 秒且不会越过总截止时间。只有 HTTP 200、`status: ok`、authority ID 和本次构建摘要全部匹配才成功；请求失败或旧版本响应会在剩余时间内重试。失败信息包含最后一次探测原因，保留当前业务库，按日志向前修复。

旧 `setup:pa` 与 `deploy-member-network.mjs` 仅供尚未统一的历史安装；检测到 primary 标记即拒绝重建正式分叉。统一后旧启动项停用，数据库和配置留在私有恢复归档。提供商、浏览器代理、Mock 服务可以是独立进程，它们不持有另一份正式任务队列或本体权威。

迁移输入 JSON 指定 `sources: [{id,tasks,members}]`、`foundationSource`、`membershipSource` 和审核过的 `expectedPolicyDigest`。先运行 `node scripts/consolidate-runtime.mjs --input /private/input.json`，审查源摘要、身份映射及任务数；再提供新的 `--output`、私有 `--authority` 和 `--expected-source-digest` 并加 `--apply`。源文件必须是停止服务后取得的完整 SQLite 副本。会员合并要求 issuer／tenant／subject 完全相同，暂停或同意状态冲突会拒绝。只有一份现有 foundation 权限库可以作为权限基础；迁移自身不新增业务权限。

每个源表和原行进入不可变导入归档。任务 ID、任务 body、来源收据、外部操作键和历史定义指纹不重写；相同定义内容以不可变 release 别名保留原引用。键冲突、活动领取、未解决授权变更或开放草稿会拒绝迁移。旧任务的执行版本继续约束是否可运行，不能因为合并而重放。历史输出能否对某个安装开放，仍需独立授权和来源证明。

更新后核对真实入口的 `/health`、Agent Card、OAuth 发现、认证拒绝路径、同一任务跨入口回读和安装隔离。确认只有一个正式任务权威、所有 Worker 使用相同描述，且来源状态仍有效。代码同步、常驻进程更新与真实业务完成分别验收。

构建同时把完整 `eigos-delegate` Skill 复制到 `dist/integrations/grok/eigos-delegate/`，不可变 release manifest 包含每个主文件、参考和脚本。客户入口 `/connect`、公开 `/connect/agent.json` 及完整下载须在部署后从真实 origin 回读；不能依赖部署目录之外的源码文件。`setup:primary-pa` 保留既有单文件交接，并另外输出完整 Skill 目录；这不等于已在外部 PA 宿主中启用。部署不会替客户登录、批准权限或创建任务。

切换前保留关闭快照、配置与前端路由，核对哈希。主实例一旦接受新任务或授权变化，就保留其数据库并向前修复；不能恢复旧库而丢失结果或复活已撤销权限。业务订单、付款和未知外部效果的重试不属于部署操作。

## 最小 Linux 主机

SQLite 模式可由一台有持久磁盘的 Linux／ECS 主机运行 Gateway、Worker 和按任务创建的 Ontology MCP，业务库与会员库分开存储。PostgreSQL 模式可拆分常驻 Gateway 与 ECS 执行 Worker，统一连接同一目标权威。TLS／反向代理保留已登记 Host。2 核 4 GiB 可作为单个 Harness 并发的 MVP 起点，实际内存和延迟须按负载观察。SQLite 不放在网络文件系统；PostgreSQL 的多宿主也不允许第二个正式数据库或资格 publisher。

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

## 将已有 SQLite primary 搬到 Linux

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

真实切换还须用已授权的原任务从 MCP 和 A2A 独立回读，并验证安装隔离、取消／恢复和原操作身份。入口检查不代替这些业务数据验收。目的端接受写入后禁止直接恢复旧快照；需要迁回时再次排空并搬运最新关闭副本。演练只证明所用副本与 Linux 接线，不能代替当前正式源主机的新鲜停写证据、完整数据导入和公网切换。源主机及其路径应以当前 authority 描述和实际运行记录为准，不能默认取 Mac 开发副本。


## 固定版本的容器与发布产物

`Dockerfile` 提供独立的 `gateway`、`relay`、`worker`、`worker-codex` 目标及候选 `worker-harness`；默认目标为 Gateway。镜像使用 Node.js 22.22.3 和锁文件 `npm ci`，运行用户为 `node`（UID 1000）。`worker-codex` 另安装固定 Codex CLI 0.164.0；基础 `worker` 不包含模型 CLI。Codex 与 Harness 均有 PostgreSQL 执行适配，但镜像须按发布清单的实际 backend／target 验收。`worker-harness` 固定 Harness 与其实际 OAuth provider 插件版本；专用镜像和对应发布流程在取得准确提交的必要 CI、完整镜像构建与运行证据前只属于 candidate；不能把主机已安装 DSH 或 Codex 镜像通过当作 Harness 镜像已经可发布。

构建上下文默认拒绝未列出的文件，包含构建必需的 PA Skill 源资产；运行镜像只复制实际 `releaseFiles` 白名单和生产依赖。数据库、`.env`、私有配置、认证文件和本机工具目录不进入镜像。`/var/lib/eigos` 用于外部持久状态；`CODEX_HOME=/home/node/.codex` 的认证须在运行时注入，`auth.json` 必须属于 UID 1000、为普通文件且权限为 `0600`。模型进程继续使用既有凭据白名单、任务范围和注册模型通道检查；安装 CLI 不授予业务或数据权限。

UID 1000 只是镜像默认值，不能假定它与原 ECS 账户配置匹配。现有 DiDi member-connection 读取要求描述的 `localUid` 等于实际 `process.getuid()`，且文件由该用户拥有、权限为 `0600`。镜像／容器部署须核对原源 UID 和私有文件所有者；若需要改变账户配置，另行审核迁移，不能静默改 `localUid`、admission digest 或来源身份。provider key 与账户材料继续按原保管边界提供。

按需发布使用 GitHub Actions 的 **Release artifacts** 手动入口，明确提供完整源 SHA 与 `codex`／`harness` backend。它先要求该准确 SHA 的最新 CI 及全部必要检查成功，包括类型、构建和进程级验证；缺失、运行中或跳过必要检查均停止发布。普通 PR／push 不触发 GHCR 发布。针对 Docker、发布脚本及构建源资产的 PR，独立的 **Container build smoke** 构建 Gateway、固定 Codex Worker 和 Harness Worker，读取镜像内文件与非 root 身份，并对 Harness 执行无网络、无凭据的 SDK 初始化检查；`push: false`、不登录 registry、不启动模型或服务。它不代表已发布或完成部署。镜像使用 `sha-<完整SHA>-<backend>` 标签写入 GHCR，再记录构建实际返回的 `@sha256:` 引用与 provenance／SBOM；已有标签不会被此流程覆盖。

Harness 发布先在本地构建产物中检查原生 SDK，再对 registry 返回的准确 Worker digest 重新执行同一检查。两次均使用非 root、只读容器、临时可执行目录和 `--network none`；实际版本、两种既有 provider 的 initialize／shutdown、编译适配入口、准确源 SHA 与零模型轮次写入 `harnessImage` 证明。只有证明绑定该 Worker OCI digest、所有角色镜像及准确源 CI 时，`finalize --harness-image-proof` 才能将产物变为 `artifact-ready`。缺失或不匹配的证明保留 candidate；SDK 初始化不证明真实模型、数据库权限或业务执行成功。镜像已写入 registry 后若验证失败，停止发布并保留失败证据，不覆盖原标签。

产物下载包 `release-<SHA>-<backend>` 包含 `manifest.json`、实际 runtime/source/lockfile 摘要、14 阶段官方内核的离线 `ontology/package.json`、固定 document/model digest 及供应商模块引用。`payloadDigest` 固定镜像内的代码与本体文件，`manifestDigest` 另外绑定外部 OCI 引用、准确源 CI 和适用的 Harness 镜像证明，避免镜像包含自身摘要的循环。缺少任一必要证明时只能是 `candidate`；`artifact-ready` 只表示这些发布产物已齐备。

产物可用以下只读入口复核，不能据此推定实例已部署：

```sh
node scripts/release-artifacts.mjs verify --root /private/release-package --require-ready
```

该手动流程当前构建 `linux/amd64`，部署前核对 ECS 的实际架构。镜像适用于 ECS／兼容 OCI 的运行环境；Cloudflare Workers 的请求入口仍使用独立 Workers 构建，不能把 Docker target 直接当成 Workers 脚本。部署须使用 manifest 中准确的 `image@sha256:...`，显式注入私有环境、同一 authority 描述与已验证的数据库连接。默认后端仍为 SQLite；显式 PostgreSQL 入口已存在，但产物生成不会执行导入、激活或两协议／业务权限验收。跨主机不能各自启动一份 SQLite 正式库。

本体包没有数据库 `releaseId`、published／active 声明。将离线包校验、不可变发布、候选代码部署和 CAS 激活分别执行，见[固定本体与发布流程](ontology-releases.md)。回滚代码时固定上一份已核对兼容性的镜像 digest 和实际发布引用；仍使用当前业务库，禁止用旧数据库覆盖后续任务、结果或撤销记录。部署后从真实 Gateway／Relay／Worker 路径回读 source/build、authority、实际本体引用与原任务结果，才能认定该次切换完成。

## 业务事实内核 v24

这是显式的 v23 → v24 更新，代码启动不执行迁移。维护窗口中停止 Gateway／Worker，保留业务库备份和准确恢复记录，再分别预览并审核以下入口：

- `scripts/upgrade-business-facts-policy.mjs`：使用准确旧策略 digest/revision；加 `--apply` 才修改策略。保留已有动作／函数许可及其到期时间，不增加来源或输出字段授权。v22 安装先走原 v22 → v23 的 RollingGo 迁移，不能跳过历史合同。
- `scripts/install-business-facts.mjs`：使用准确 active release digest/generation；加 `--apply` 才激活新增业务定义。只接受已核对的 v23 前身，或对已经完成的 v24 返回原结果；不改写旧事实或任务 pin。

两个入口都要求明确的私有数据库路径；正式库还要求匹配的 `EIGOS_AUTHORITY_FILE`。先完成策略迁移，再安装本体发布。新对象类型与字段仍需按具体来源和任务单独审核授权，不能自动扩大旧授权。完成后检查发布摘要、旧任务回读、新任务实体／关系投影和来源撤销。本流程不调用供应商业务动作。

## PostgreSQL 候选导入与正式 handoff

Gateway／Worker 已能按 `EIGOS_STORAGE_BACKEND=postgres` 启动实际异步任务、会员、本体、权限和已注册来源适配。默认值仍为 SQLite。正式入口还要求 Foundation JWT、同一个原 authority、受控 binding、已安装的最小运行权限及单独激活记录；仅设置环境变量或导入成功不会切换主权威。Codex／Harness 执行 Worker 保持在 ECS 等常驻 Node 宿主；先确定实际执行器、模型接收方和私有凭据维护方。

### 冻结源与导入

先运行 `npm run build`，再从**当前正式源主机**完成排空、停止并禁止自动重启、原 authority 停写围栏和活动领取观察，取得同一窗口的业务／会员关闭快照。保留原始停写、排空、领取观察和权威围栏回执及哈希；工具不会替操作者停止 ECS，也不能用构造 JSON、手改验证标志或旧演练回执代替这些实际动作。SQLite 副本须 checkpoint、使用 `journal_mode=DELETE`，且没有 WAL／SHM／journal。

```sh
node scripts/business-postgres-preflight.mjs --snapshot /absolute/private/offline-business.sqlite --authority /absolute/private/authority.json --policy-digest "$SOURCE_POLICY_DIGEST"
```

盘点保存表结构、行数／大小、摘要、索引／触发器及序列高水位，拒绝活动租约、恢复、未解决围栏和未审查的存储映射。开放草稿按原身份、revision、base release 与 generation 保留，不自动发布或重置。业务导入保留原任务 body、操作键、不可变历史和 SQLite 行序 `__eigos_rowid`；会员库另导入并核对 issuer／tenant／subject、原安装、连接、令牌与邀请，不重新授权来填补缺失身份。

导入／身份核对工具使用既有私有环境 `EIGOS_BUSINESS_POSTGRES_URL` 与绝对 `EIGOS_BUSINESS_POSTGRES_CA_FILE`；URL 不带覆盖 TLS 的参数，密码含特殊字符时按 URL 规则编码。这些秘密不放到命令参数或 Git。下例 schema 和环境变量均须替换为同一已审核操作的真实值，再按盘点摘要和容量预算执行：

```sh
node scripts/business-postgres-import.mjs --apply --snapshot /absolute/private/offline-business.sqlite --authority /absolute/private/authority.json --policy-digest "$SOURCE_POLICY_DIGEST" --expected-file-digest "$BUSINESS_FILE_DIGEST" --schema eigos_business_example --max-database-bytes "$REVIEWED_BYTE_BUDGET"
node scripts/membership-postgres-import.mjs --apply --snapshot /absolute/private/offline-members.sqlite --expected-file-digest "$MEMBERSHIP_FILE_DIGEST" --schema eigos_membership_example --max-database-bytes "$REVIEWED_BYTE_BUDGET"
node scripts/business-postgres-verify.mjs --snapshot /absolute/private/offline-business.sqlite --authority /absolute/private/authority.json --policy-digest "$SOURCE_POLICY_DIGEST" --expected-file-digest "$BUSINESS_FILE_DIGEST" --schema eigos_business_example
node scripts/postgres-identity-audit.mjs --business-schema eigos_business_example --membership-schema eigos_membership_example --business-digest "$BUSINESS_FILE_DIGEST" --membership-digest "$MEMBERSHIP_FILE_DIGEST"
```

分别保存实际导入回执、独立业务逐表／序列验证和会员身份核对结果。身份 audit 只检查其声明范围，不证明完整授权或外部效果。导入器只创建新私有 schema，不激活服务、不授予运行角色，也不修改源。容量预算不包含 PostgreSQL WAL 或托管平台额外开销；可导入的大行也不等于运行时／HTTP 能在原有读取界限内处理，不可截断历史或放宽默认界限来验收。

### pgvector 扩展的独立准备

语义检索使用 PostgreSQL 的 `vector` 扩展。先以目标库实际提供的版本填写私有 operation 文件；文件结构见 [`vector-extension.ts`](../../packages/postgres/vector-extension.ts)。目标包含主机、端口、数据库、CA 文件及其摘要，管理员登录与实际数据库角色分别填写；密码仅从 `EIGOS_POSTGRES_ADMIN_PASSWORD` 读取，登录名使用 `EIGOS_POSTGRES_ADMIN_USER`。

```sh
node scripts/postgres-vector.mjs --input /absolute/private/vector-operation.json
node scripts/postgres-vector.mjs --input /absolute/private/vector-operation.json --apply --expected-preview-digest "$VECTOR_PREVIEW_DIGEST" --output /absolute/private/new-vector-install.json
node scripts/postgres-vector.mjs --input /absolute/private/vector-operation.json --readback --expected-preview-digest "$VECTOR_PREVIEW_DIGEST" --output /absolute/private/new-vector-readback.json
```

默认预览不读凭据、不连接数据库。应用仅在既有 `extensions` schema 安装准确版本，不自动升级或迁移其他安装；提交后用独立连接核对扩展归属、C 函数、类型、距离运算符及合成向量运算。回执区分扩展可用、运行角色兼容和语义检索配置；安装成功不证明 embedding 已生成或 RAG 已接通。

此工具不发运行角色 GRANT。扩展自身可能有默认 PUBLIC ACL，因此不能把“工具未发 GRANT”理解为权限目录完全不变。正式运行角色仍须通过 handoff 的 schema／routine 检查；不得为绕过检查而豁免整个 `extensions` schema。embedding 模型、维度、资料外发许可及候选过滤需依[建模指南](ontology-modeling.md#postgresql与pgvector语义检索目标)另行配置和验收。[Supabase pgvector](https://supabase.com/docs/guides/database/extensions/pgvector)

### 业务运行 schema 的准备

handoff 使用两个不同的已审查输入：`phase=prepare-schema` 安装运行扩展和最小权限，`phase=activate` 另行写入不可变激活记录。输入 schema 见 [`postgres-handoff.ts`](../../packages/deployment/postgres-handoff.ts)；绑定 schema 见 [`postgres-binding.ts`](../../packages/deployment/postgres-binding.ts)。输入固定目标身份、两份原快照、导入回执、独立验证和真实源围栏文件。目标运行登录须预先隔离配置，不能用数据库 owner 测过就当作运行账号验收。

```sh
node scripts/postgres-primary-handoff.mjs --input /absolute/private/prepare-schema.json
node scripts/postgres-primary-handoff.mjs --input /absolute/private/prepare-schema.json --apply --expected-preview-digest "$PREPARE_PREVIEW_DIGEST" --output /absolute/private/new-schema-receipt.json
```

`PREPARE_PREVIEW_DIGEST` 只取自上一条已审核预览，输入改变后重新预览。预览不取凭据、不连接数据库。应用从宿主秘密环境读取既有 `EIGOS_POSTGRES_ADMIN_USER`／`EIGOS_POSTGRES_ADMIN_PASSWORD`，按绑定中的 CA 与主机名验证 TLS。提交后另开连接核对实际 schema 和 receipt；此阶段仍未激活，也不启动 publisher／Relay／Worker。基础业务独立验证在扩展安装前保存，安装后使用扩展专用校验，不篡改原回执的 `false` 标志。

### 完整迁入节点并独立回读

Relay 服务端数据库和 Gateway／通信节点的本地私有状态分别迁移。关闭原节点后，用 [`readRelayNodeMigrationSource`](../../packages/agent-transport/client.ts) 从原凭据文件和完整 SQLite 状态导出 v2 私有快照及两文件摘要；快照含私钥和密文，只能保存到受控私有目录。v2 保留原 receipt TEXT、原游标以及全部 outbox／inbox／retained 记录，不能从 v1 推造未知原文、只选活跃记录或生成新 Agent 身份。

节点操作输入见 [`postgres-node-migration.ts`](../../packages/deployment/postgres-node-migration.ts)：引用上一步 `prepare-schema` 输入、实际 schema receipt、完整源 manifest、目标 Relay 配置以及**既有** wrapping key 的环境名与摘要。manifest 须覆盖 Gateway 独立节点、原已初始化通信节点及未初始化 endpoint 清单。宿主提供匹配的 `EIGOS_RELAY_WRAPPING_KEY`；导入工具不创建、轮换或替换该密钥。

```sh
node scripts/postgres-node-migrate.mjs --input /absolute/private/node-operation.json
node scripts/postgres-node-migrate.mjs --input /absolute/private/node-operation.json --apply --expected-preview-digest "$NODE_PREVIEW_DIGEST" --output-directory /absolute/private/new-node-evidence
node scripts/postgres-node-migrate.mjs --input /absolute/private/node-operation.json --readback --expected-preview-digest "$NODE_PREVIEW_DIGEST"
```

导入应用后，脚本从独立连接读取已提交的实际 AEAD 身份、每条密文／原 TEXT 和游标，再写入新证据目录；另一个 `--readback` 进程可再次完整校验。它拒绝不匹配的 wrapping key、原文件／快照／绑定变化、孤立或缺失节点以及不完整行。若目标 Relay origin 改变，仅通过受审查的 repoint 保留原私钥、secret、registration ID 和所有历史；产生单独 origin-repoint 回执，不改源文件。输出的 `serverAcceptance: not-observed` 必须保持原意：离线完整回读不能证明 Relay 服务端已接受原凭据或双方关系。

### 单独激活，再启动与回读

将实际节点库存、导入／独立回读／repoint 文件及摘要纳入最终 binding；没有 Relay 功能的部署不补造节点证据。经审核的 activate 输入绑定真实 source fence、独立业务验证、身份 audit、schema receipt 和原 authority，保留源／目标关系。不能用“已构建镜像”替代这些输入。

```sh
node scripts/postgres-primary-handoff.mjs --input /absolute/private/activate.json
node scripts/postgres-primary-handoff.mjs --input /absolute/private/activate.json --apply --expected-preview-digest "$ACTIVATE_PREVIEW_DIGEST" --output /absolute/private/new-activation-receipt.json
```

激活事务核对当前最小权限、完整库存与实际受审节点；提交后脚本从独立连接重查 schema，并用 `EIGOS_POSTGRES_PASSWORD` 指定的受限运行登录执行真实 TLS／激活校验。它记录激活而不启动服务，不改变任务或模型授权。出现提交或关闭错误时先读取不可变 migration／schema／activation 回执与节点实际行；响应未知不能覆盖重试，新输出路径不能指向已有证据。

最后才使用已核对版本与私有配置启动常驻入口：

```sh
node --env-file=/absolute/private/gateway.env dist/apps/gateway/main.js
node --env-file=/absolute/private/worker.env dist/apps/worker/main.js
```

两侧显式选择 `postgres` 并保持相同权威／binding；Gateway 是唯一 publisher，Worker 检查既有 Gateway 就绪后才领取。外部 origin、issuer、audience、Host／DPoP 地址语义和原本体 pin 保持准确。核对每个真实入口的 authority／build、OAuth 拒绝、原节点及联系人、同一原任务的 MCP／A2A 回读、领取／续租／取消／迟到结果和来源撤销。新鲜正式源的围栏、完整导入、目标激活与公网回读全部通过前，迁移仍未完成；测试数据库、模拟模型或加密回路成功不能替代实际模型／供应商结果。目标接受写入后保留当前库向前修复，不能恢复旧 SQLite 快照覆盖新结果和撤销。

## Cloudflare Relay 与常驻 Gateway

已有 `apps/relay/cloudflare.ts` 是独立 Workers Relay 入口；它不启动模型，也不承担主 Gateway 的会员／任务执行或本体权威。部署该入口不会自动把 MCP／A2A 和 ECS Worker 迁到 Cloudflare，Relay 服务端与原节点离线导入也须分别核对。

当前 Node Gateway 仍需要原私有配置／PA Skill 资产、唯一 publisher 和常驻进程的关闭语义。普通 Worker 的模块加载或 HTTP 桥接通过不证明持续资格续约；请求后的后台处理有生命周期限制，不能用增加授权期限弥补。[Workers 运行限制](https://developers.cloudflare.com/workers/platform/limits/)

Cloudflare Containers 可作为复用 Node Gateway 镜像的候选：固定一个实例路由至同一 PostgreSQL 权威，DO 只协调容器生命周期，不存第二份任务／本体业务数据。需先满足 [Workers Paid 账户资格](https://developers.cloudflare.com/containers/)并完成操作者选择，再取得真实 OCI digest、私有配置／Secret 注入、端口健康、原 Host／DPoP 和 publisher 停止／重启验收。容器默认空闲退出及平台重启也须处理；本仓库不承诺其始终在线，候选配置不代表已部署。LLM／Harness Worker 继续使用 ECS 等常驻执行环境。[Containers 配置](https://developers.cloudflare.com/containers/configuration/wrangler/)、[容器生命周期](https://developers.cloudflare.com/containers/faq/)
