# 部署入口与验收

正式实例只有 `com.eigos.primary`，其 Gateway／Worker 共享一份业务库、一份本体发布注册库和一个 authority ID。会员登录库独立存储，但只有一份会员身份权威。路由方法见[统一运行与路由](../architecture/runtime-authority.md)。

| 入口 | 用途 |
| --- | --- |
| `scripts/consolidate-runtime.mjs` | 对关闭后的数据库副本制定计划并复制合并；原库只读 |
| `scripts/deploy-primary.mjs` | 更新唯一正式主实例的不可变代码快照与常驻进程 |
| `npm run setup:primary-pa` | 为 PA 配置主实例的原生客户端 |
| `npm run dev`、`Dockerfile` | 独立开发与测试；使用合成数据和隔离配置 |

构建、验证、提交后，先执行 `node scripts/deploy-primary.mjs --config /absolute/private/server.env` 检查部署条件，再以相同参数加 `--apply` 安装。配置须包含 `EIGOS_AUTHORITY_FILE`，与预先写入业务库的描述一致。安装器拒绝同时运行旧正式 profile，保留私有配置备份，并核对本机 authority ID 和构建摘要。反向代理须保留已登记的 Host；部署后仍要从每个真实入口独立回读。

主实例就绪探测通过 loopback 保留已登记的 Host，总等待上限为 120 秒，单次请求最多 15 秒且不会越过总截止时间。只有 HTTP 200、`status: ok`、authority ID 和本次构建摘要全部匹配才成功；请求失败或旧版本响应会在剩余时间内重试。失败信息包含最后一次探测原因，保留当前业务库，按日志向前修复。

旧 `setup:pa` 与 `deploy-member-network.mjs` 仅供尚未统一的历史安装；检测到 primary 标记即拒绝重建正式分叉。统一后旧启动项停用，数据库和配置留在私有恢复归档。提供商、浏览器代理、Mock 服务可以是独立进程，它们不持有另一份正式任务队列或本体权威。

迁移输入 JSON 指定 `sources: [{id,tasks,members}]`、`foundationSource`、`membershipSource` 和审核过的 `expectedPolicyDigest`。先运行 `node scripts/consolidate-runtime.mjs --input /private/input.json`，审查源摘要、身份映射及任务数；再提供新的 `--output`、私有 `--authority` 和 `--expected-source-digest` 并加 `--apply`。源文件必须是停止服务后取得的完整 SQLite 副本。会员合并要求 issuer／tenant／subject 完全相同，暂停或同意状态冲突会拒绝。只有一份现有 foundation 权限库可以作为权限基础；迁移自身不新增业务权限。

每个源表和原行进入不可变导入归档。任务 ID、任务 body、来源收据、外部操作键和历史定义指纹不重写；相同定义内容以不可变 release 别名保留原引用。键冲突、活动领取、未解决授权变更或开放草稿会拒绝迁移。旧任务的执行版本继续约束是否可运行，不能因为合并而重放。历史输出能否对某个安装开放，仍需独立授权和来源证明。

更新后核对真实入口的 `/health`、Agent Card、OAuth 发现、认证拒绝路径、同一任务跨入口回读和安装隔离。确认只有一个正式任务权威、所有 Worker 使用相同描述，且来源状态仍有效。代码同步、常驻进程更新与真实业务完成分别验收。

构建同时把完整 `eigos-delegate` Skill 复制到 `dist/integrations/grok/eigos-delegate/`，不可变 release manifest 包含每个主文件、参考和脚本。客户入口 `/connect`、公开 `/connect/agent.json` 及完整下载须在部署后从真实 origin 回读；不能依赖部署目录之外的源码文件。`setup:primary-pa` 保留既有单文件交接，并另外输出完整 Skill 目录；这不等于已在外部 PA 宿主中启用。部署不会替客户登录、批准权限或创建任务。

切换前保留关闭快照、配置与前端路由，核对哈希。主实例一旦接受新任务或授权变化，就保留其数据库并向前修复；不能恢复旧库而丢失结果或复活已撤销权限。业务订单、付款和未知外部效果的重试不属于部署操作。


## 业务事实内核 v24

这是显式的 v23 → v24 更新，代码启动不执行迁移。维护窗口中停止 Gateway／Worker，保留业务库备份和准确恢复记录，再分别预览并审核以下入口：

- `scripts/upgrade-business-facts-policy.mjs`：使用准确旧策略 digest/revision；加 `--apply` 才修改策略。保留已有动作／函数许可及其到期时间，不增加来源或输出字段授权。v22 安装先走原 v22 → v23 的 RollingGo 迁移，不能跳过历史合同。
- `scripts/install-business-facts.mjs`：使用准确 active release digest/generation；加 `--apply` 才激活新增业务定义。只接受已核对的 v23 前身，或对已经完成的 v24 返回原结果；不改写旧事实或任务 pin。

两个入口都要求明确的私有数据库路径；正式库还要求匹配的 `EIGOS_AUTHORITY_FILE`。先完成策略迁移，再安装本体发布。新对象类型与字段仍需按具体来源和任务单独审核授权，不能自动扩大旧授权。完成后检查发布摘要、旧任务回读、新任务实体／关系投影和来源撤销。本流程不调用供应商业务动作。
