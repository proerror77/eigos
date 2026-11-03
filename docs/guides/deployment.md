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


## 业务事实内核 v24

这是显式的 v23 → v24 更新，代码启动不执行迁移。维护窗口中停止 Gateway／Worker，保留业务库备份和准确恢复记录，再分别预览并审核以下入口：

- `scripts/upgrade-business-facts-policy.mjs`：使用准确旧策略 digest/revision；加 `--apply` 才修改策略。保留已有动作／函数许可及其到期时间，不增加来源或输出字段授权。v22 安装先走原 v22 → v23 的 RollingGo 迁移，不能跳过历史合同。
- `scripts/install-business-facts.mjs`：使用准确 active release digest/generation；加 `--apply` 才激活新增业务定义。只接受已核对的 v23 前身，或对已经完成的 v24 返回原结果；不改写旧事实或任务 pin。

两个入口都要求明确的私有数据库路径；正式库还要求匹配的 `EIGOS_AUTHORITY_FILE`。先完成策略迁移，再安装本体发布。新对象类型与字段仍需按具体来源和任务单独审核授权，不能自动扩大旧授权。完成后检查发布摘要、旧任务回读、新任务实体／关系投影和来源撤销。本流程不调用供应商业务动作。
