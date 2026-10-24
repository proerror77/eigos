# 权限 S1：身份、授权存储与撤销协调

日期：2026-10-24。基于 `d83feb5` 和[三层权限方案](ontology-permissions-implementation-plan-2026-10-24.md)实施。S1 交付可选择启用的身份／授权控制面及 Worker 校验接缝；对象／属性策略和安全结果投影仍属于 S2–S4。本阶段没有更新常驻服务、迁移真实数据库或执行供应商业务。

## 行为与启用边界

`EIGOS_SECURITY_MODE=legacy` 是默认值，保留现有协议与身份准入行为。`foundation` 必须同时配置 JWT、明确的 `OIDC_AGENT_CLIENT_ID`、新的持久任务库和独立会员库。Worker 使用相同的数据库与 mode，但不读取会员档案、Bearer 或 OAuth 客户端密钥。

新模式在数据库中持久记录版本和模式。省略配置不能让 foundation 数据库被新的 legacy Gateway／Worker 打开；包含旧任务的无标记数据库也不能直接切换。S1 没有在线升级／回退接口，现有实例的迁移留到 S5。测试使用隔离数据库和合成身份，不能把测试身份映射成常驻的个人开发身份。

foundation 当前只开放会员／安装管理与权限上下文检查。已认证的业务 HTTP、MCP、A2A 请求统一返回 `503 security_stage_incomplete`，Agent Card 不发布可执行 skills。新增 grant 不会进入旧的 owner-wide 查询或完整 Job 输出。既有 legacy 模式保持其原有边界，不会因为升级源码而宣称已经得到三层权限。

## 已实现的身份路径

1. Gateway 先使用既有 verifier 验证 JWT，再调用现有 `AgentRegistrations.authorize` 和 `MemberStore.authorize`。
2. 安装身份来自 token 绑定的 registration.id；同一 clientId 下的两次安装分开处理。其他 OAuth client 不能通过缺少安装记录被当成会员会话。
3. 会员库提供最小资格事实：ownerKey、memberId、clientId、installationId、当前资格。没有邮箱、会话、token 或供应商凭据进入业务授权表。
4. Gateway 读取当前安装授权，生成 `AccessContext` 并保留在服务端 Principal。MCP extra 和 A2A AgentUser 使用同一已验证身份接缝；客户端的 owner／installation／role／approvedBy 字段不会被用于生成身份。
5. 完整的已验证 token scopes 会被保留，包含 `members:write`／OIDC scope；只有具体操作所要求的 scope 才有作用。上下文结构解析本身仍不等于授权。

foundation 的安装注册状态可为 `data_authorization_required` 或 `foundation_ready`。后者只代表可以检查自身权限上下文，不能解释为业务服务可用。

## 授权存储

[SecurityStore](../packages/security/store.ts) 与 JobStore 复用同一个 SQLite 连接和可嵌套 savepoint，新增以下记录：

| 记录 | 作用 |
| --- | --- |
| security_settings | 数据库安全版本／模式，拒绝隐式切换 |
| security_manager | 单个在线资格发布者的短期 lease |
| security_subjects | 最小会员／安装资格、epoch 与 freshness |
| security_fences | 会员、客户端连接或安装的拒绝状态与协调版本 |
| security_grants | 安装与任务数据授权，保存独立的状态、revision、期限和父授权 |
| security_task_authorities | 固定任务、请求版本、安装、父子 grant 和身份 epoch 的执行授权 |
| security_events | 不含 token／资料正文的控制事件摘要 |

安装授权由已经登录的控制者批准，服务端生成 owner、批准者、ID、时间和 revision。字段必须是注册的具体对象属性，已有 `restricted` 属性不能被此接口开放。每个安装只允许一个 active 上限；替换前显式撤销当前上限。安装／任务最长有效期沿用 S0 的 30 天／24 小时限制。

任务 grant 与执行授权目前是供后续阶段使用的**内部接缝**，没有 S1 公共创建或绑定接口。存储层验证会员／安装／owner、父授权版本、字段／来源／渠道子集、期限、当前任务 revision 和已有输入对象 revision。已有会员资产输入还要求提交时有 `tasks:read`，内部任务处理要求 `tasks:write` 和 `task.process`。来源实际可用性、逐对象策略、program 语义和输出渠道最终控制继续由 S2–S4 完成。

旧 PlanGrant 保持原有业务作用、预算、收款方和环境约束；不会自动转换成数据 grant。S1 不从 OAuth scopes、当前存在的安装或旧任务所有权推定新授权。

## 撤销顺序与故障处理

[AuthorizationCoordinator](../packages/security/coordinator.ts) 被会员网页、Agent 自撤销和现有会员 CLI 共同使用：

1. 先在业务库提交拒绝 fence，失效对应 subject／grant／task authority。
2. 获取该 fence 版本的写锁，确认没有更新的协调请求，然后更新会员库。
3. 最后在业务库确认 applied；明确恢复资格时才转为 cleared。恢复资格不会恢复已撤销的 grant 或任务执行授权。

两库不被描述成原子提交。第二步失败或进程中断时，第一步的拒绝已经持久化，返回 `REVOCATION_PENDING`，不能显示撤销已全部完成。重试相同目标可以完成协调。每次协调尝试递增 fence revision，旧恢复请求不能修改会员库或清除较新的拒绝状态。

成员 approve／连接 restore 在状态本来有效且没有拒绝 fence 时为无操作，避免重试误撤销后来新建的授权。不同安装和不同任务的撤销分别作用于自己的范围；会员停用和客户端连接停用则覆盖对应的安装。

只允许一个在线 Gateway 发布资格，lease 为 60 秒，每 30 秒刷新。资格源读取失败会关闭发布者，Worker 不继续沿用不确定资格；不会把临时读取失败编造成永久的会员撤销。新 Gateway 必须重新核验来源并取得 lease。直接修改数据库或运行不受管理的旧二进制不在该协调协议内，部署时仍必须隔离／停止旧进程。

## Worker 边界

foundation 任务保存为 `executionMode=worker-security-foundation`，旧 Worker 的 `worker` 队列选择器不能领取它们。新的 Worker 同时要求数据库 mode 一致。

领取、续租、checkpoint、结果完成、dispatch 和 ExecutionAttempt 写入都复核当前任务授权；匹配 owner、安装、身份 epoch、grant revision、请求 revision、有效期以及发布者／资格 lease。派发检查和持久尝试记录位于同一事务。撤销先提交就不能新派发；先批准的在途外部操作不能被宣称已经撤回。

撤销后在途 Worker 的续租失败会中止其调用；迟到回包仍可写入审计观察，但不能通过旧 claim 投影或完成任务。既有取消、租约和结果保护保持。S1 不开放业务入口，也没有新增可绕过撤销的 recovery authority；S3 将单独接入原操作的最小恢复上下文。

## 控制接口

| 接口 | 要求／结果 |
| --- | --- |
| `POST /security/context`，body `{}` | 已验证注册 Agent、active 安装 grant、`services:read`；仅返回安装、grant 引用、epoch、S1 阶段和 `businessAccess=false` |
| `GET /members/security/grants` | 当前会员浏览器会话；只返回自己的 grant，移除 ownerKey 和内部会员／批准者字段 |
| `POST /members/security/grants` | 同一会员会话＋同源 Origin＋CSRF；创建安装授权上限 |
| `POST /members/security/grants/:id/revoke` | 同一控制者＋Origin／CSRF＋expectedRevision；撤销 grant 与依赖的任务授权 |
| 原 `/members/agents/:id/revoke`、连接 revoke／restore | foundation 模式使用同一个撤销协调器 |
| 原 `/agents/registrations/:id/revoke` | 原注册 credential＋已验证 bearer；可停止自身安装，不能签发 grant |

创建安装上限的 JSON 字段为 `_csrf`、installationId、capabilityIds、resources（type＋fields）、sourceBindingIds、channels、expiresAt。服务端不接受请求自报 id、ownerKey、memberId、approvedByMemberId 或状态。该控制 API 是 S1 接缝；完整的逐任务授权审阅界面仍按后续阶段实施，现有会员页面会说明业务未开放。

新权限模式需要浏览器控制者会话进行批准；Agent 的 bearer、注册 credential、会员申请 consent 或自由文本中的“批准”都不能替代该会话。HTTP、MCP、A2A 不混用 Cookie 身份。

## 会员 CLI

现有 `npm run members -- approve/suspend` 通过 [openMembershipAdministration](../packages/security/admin.ts) 读取数据库的实际 mode，并调用同一个协调器；即使遗漏 `EIGOS_SECURITY_MODE` 也不能绕过 foundation。显式配置与数据库不同则拒绝。CLI 复用本机管理员权限，不新增远程管理令牌或服务。

CLI 必须指向已经存在且分离的任务／会员数据库，不能通过管理命令意外创建另一个空库。它不取得 Gateway 的资格发布 lease，也不签发数据授权。邀请和资料管理继续使用原会员实现。

## 验证与下一步

本地最终验证为 635 项测试、9 项进程 E2E、类型检查、构建、S0 清单和 diff 检查全部通过。S1 的 15 项专项包含在全量测试中，编译后的 CLI 测试包含在进程 E2E 中。记录见 [S1 验证归档](evidence/security-s1-2026-10-24/README.md)。远端 CI 和部署状态单独核验。

专项验证覆盖：同会员同 client 的不同安装、伪造身份字段、控制者会话／Origin／CSRF、跨会员批准、已有私有字段、公共协议关闭、成员库写入失败、源读取不可用、缺失持久安全配置、重启后的拒绝状态、旧恢复请求与新拒绝竞争、资格过期、唯一发布者、父子 grant 越界、请求／输入 revision、Worker 中止及迟到观察。另有编译后的会员 CLI 子进程 E2E，证明撤销可被另一连接的 Worker 读回。

S0 属性分类和业务模型没有改变；代码路径清单新增身份／授权模块与配置／Worker 接缝。验证时同时运行 `security:s0`，不通过删掉变化检测来放行本阶段改动。

S2 接入资源查看权、任务对象绑定和统一读取视图后，才逐条开放经过端到端保护的数据路径；S3 接入完整执行和恢复上下文，S4 接入安全结果投影，S5 执行经验证的迁移与切换。S1 测试通过不代表这些后续阶段已经完成。
