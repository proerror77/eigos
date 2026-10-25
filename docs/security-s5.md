# S5：迁移、PA 与来源适配

2026-10-25。S5 的离线复制迁移、参考客户端和当前原生来源适配已实现，并完成常驻数据副本演练。**真实同会员双安装、隔离访问与撤销验收已通过；常驻仍为 legacy，尚未切换。** Shopify 公开目录、美团地点／本人地址和 Luma 既有报名的只读查证已取得真实来源结果。滴滴地点查询返回上游账户额度耗尽，尚待用户选择“停用滴滴后切换已验收来源”或“等待额度恢复后整体切换”。源码、本地测试、CI、运行切换与真实业务完成分别记录。

## 迁移合同

`npm run security:migrate -- plan|apply|verify` 只处理显式提供的闭合 SQLite 快照。它不读取默认 `.env`，不原地更新数据库，不停止或启动常驻。

输入 JSON 包含：

```json
{
  "databaseSnapshot": "/private/snapshots/tasks.sqlite",
  "membershipSnapshot": "/private/snapshots/members.sqlite",
  "assetSnapshots": [{"label": "reports", "directory": "/private/snapshots/reports"}]
}
```

```sh
npm run build
npm run security:migrate -- plan --input /private/migration-input.json
npm run security:migrate -- apply --input /private/migration-input.json --output /private/new-foundation --expected-source-digest <reviewed-digest>
npm run security:migrate -- verify --output /private/new-foundation
```

`apply` 必须使用 plan 的准确摘要和不存在的目标目录。输入检查包括数据库完整性、活跃领取／资格发布者、未完成的撤销协调 fence、文件与行数上限、产物符号链接及复制期间的变化。新目录为 0700，数据库／产物为 0600；先完成私有临时目录，再验证并重命名。

迁移复制任务、幂等回执、对象／关系、执行意图／尝试／观察、业务许可和预算账本。原始行及未知扩展表另外保存在 `security_migration_archive`。任务唯一变换为 `executionMode=worker-security-archive`，新旧常规领取器均不领取这些任务。所有者、对象键、来源证据、原操作键和账本事实保留；会员数据库按字节复制。

旧安装登记不等于当前 AgentGrant。迁移不激活旧安全授权，不产生资源角色、来源许可、任务数据授权或对象绑定。可证明当前定义、任务版本和来源关系的对象仅进入 `security_migration_candidates`，需要新的明确控制面授权；历史／无法定位对象继续仅供受信归档审计。旧开发身份不会自动归入真实 OIDC 会员。

`verify` 核对复制后的业务表、原始归档、会员文件及完整私有产物目录，并确认没有任何新授权、策略／输出状态或被重新领取的旧任务。**这是启用前的迁移完整性检查**；正常业务或授权写入后，不再把其摘要不一致解释为迁移失败，应按运行与审计读回核对新的事实。

## 本次常驻副本演练

原服务保持运行，通过 SQLite 一致性备份得到闭合副本；原始来源审计文件和参与者队列另存到私有快照。演练不替代最终切换前停止全部旧进程后的重新捕获。

| 项目 | 数量／结果 |
| --- | --- |
| 历史任务 | 48 |
| Ontology 对象／关系 | 568／1053 |
| 执行意图／尝试／观察 | 各 114 |
| 幂等回执 | 55 |
| 业务许可／预算行 | 各 3，事实保留，未转为新安全许可 |
| 私有产物与恢复文件 | 130 个文件，5 个明确来源目录 |
| 可证明候选对象／仅归档对象 | 26／542 |
| 激活任务绑定／自动授权 | 0／0 |
| 输入副本与会员文件 | 哈希保持一致 |

可公开核对的计数和摘要见[演练证据](evidence/security-s5-2026-10-25/README.md)。原始数据库、凭据、浏览器记录及环境文件留在用户私有目录。

## PA 合同

Node `AgentConnector` 支持 `foundation_ready`，并提供 `authorizationContext`、带明确 taskId 的 v2 `queryOntology`／`evaluateOntology` 和 `checkAccess`。`POST /security/context` 返回 S5、当前安装和授权引用；客户端核对安装 ID，拒绝旧接口或跨目的地回退。

`scripts/agent-enroll.mjs` 的 `begin`／`finish`／`status`／`join` 使用现有 OAuth 提供者。每个安装拥有独立 0600 凭据文件；本人在提供者页面完成设备确认。它不修改提供者客户端、令牌寿命或登录策略，也不打印 bearer／refresh token。`join` 需要包含明确 consent 的私有会员资料。

Python PA 客户端的 foundation profile 通过 `scripts/agent-request.mjs` 调用同一个 AgentConnector。刷新令牌留在 Node 的私有凭据文件中；Python 仅收到同源应用响应。配置只有通过 discovery 和安装上下文检查后才覆盖旧 profile。需要已有环境代理的机器可显式使用 `--node-use-env-proxy`。

v2 A2A metadata 只提供 `view`、`outputStatus`、获准的 `accepted`、`authorization`、`payment`、`attachments` 和安全错误。`accepted=true` 仅在已接受任务的实际产物可交付时出现；完成后的权限收紧仍可阻断整个产物。运行记录、旧完整 Job 和任意来源 result 不进入响应。当前原生来源的结果包含被明确授权的 `observedData`，使用相同字段／来源／标签检查。

游标是服务器保存的短期不透明引用，绑定安装、任务、查询与策略。`check_access` 只诊断，不产生许可。新客户端拒绝在 denied、旧服务或缺失 TaskView 时转回 owner-wide 查询。具体使用见[PA 技能](../integrations/grok/eigos-delegate/SKILL.md)。

## 来源适配与模型边界

`EIGOS_PERSONAL_SOURCE_OWNER` 必须是一个规范会员身份，只允许非 production、本机监听、HTTPS public origin 的 foundation JWT 实例。每个原生程序与该身份不可变绑定；其他会员不会共享其个人来源。安装仍需分别具备 AgentGrant、角色、来源操作、任务数据、模型通道和接收资格。凭据文件存在不产生这些许可。

| 原生程序 | 本轮 foundation 集成样例 | 模型／PA 投影 |
| --- | --- | --- |
| 滴滴只读 | 地点选择、估价、完成及撤销后的阻断 | 固定业务观察，原始 MCP trace 与凭据不出站 |
| Shopify 公开目录 | 原生搜索、选择来源变体并完成 | 商品与观察字段；私有来源回执留内部 |
| 美团地点／地址／运费 | 三条原生路径完成 | 模型只见安全摘要；明确授权的地址列表只交给 PA，排除电话 |
| 参与者报名 | 原有报名的独立读取与完成 | 排除 attendeeRef、确认凭证和原始截图 |
| 原操作查证 | 严格匹配原操作及活跃查证 lease | 只返回最小状态、原引用、观察时间和证据摘要 |
| 商务沙箱 | 原生报价、路线和运输／海关关卡 | 地址缩减到国家／地区／城市／邮编；合成事实保持标注 |
| 预约沙箱 | 独立零价预约许可与确认 | 支付处理端点和 checkout 链接不进入模型观察 |

这些适配保留模型选择动作、参数、顺序和候选的方式。安全层提供确定性的绑定、固定字段视图和检查，没有固定业务步骤来代替模型决策。类型或字段未登记时保持拒绝；旧 brief／document／CSV／UCP adapter 不自动获得 foundation 执行许可。首批常驻方案仅拟启用经过投影的原生来源及只读操作，其他路径保留既有 legacy 验证范围。此表列的是代码与集成测试覆盖，真实来源结果另列如下。

受信语义验证器可以在对应业务视图已获授权时检查内部来源完整性；公开查询和模型工具仍看不到原始 snapshot。计算结果按同一固定投影输出。自由文本、结构化结果、文件和 PA 专属地址视图继承实际读取依赖的限制。

单次同步读取／验证内复用已确认的权限结果，避免复杂来源校验重复读取同一资格。当前连接的数据库写入、其他连接提交、授权到期都会使复用失效；退出时完整复核。它不跨异步来源调用、模型工具调用或业务派发，不放宽租约。测试覆盖同连接撤销、独立连接撤销与资格过期。

## 真实双安装与只读来源验收

本人通过现有 Auth0 分别完成 A／B 设备确认。两个独立 0600 凭据文件经签名验证后对应同一活跃会员，安装 ID 和访问令牌不同。未修改提供者客户端、期限或账户策略。随后建立仅含读取动作的临时 AgentGrant、Viewer 资源角色、来源许可、模型与接收资格。

独立 Python PA 进程证明：原 requestId 重放返回同一任务；A、B 不能读取对方任务；各自可读取自己的 v2 Ontology 视图。独立 Worker 进程取得两个领取后，撤销 B 的 AgentGrant，A 续租成功而 B 续租失败，B 的后续 PA 请求也被拒绝。撤销测试没有调用业务来源。B 安装仍绑定会员，但本次试验 grant 已撤销；最终常驻必须重新签发明确许可，不能复活旧任务权限。

| 真实来源 | 独立结果 | 证明范围 |
| --- | --- | --- |
| Shopify 公开目录 | 模型选择读取动作，任务完成并 accepted；独立 PA 读回一致 | 公开商品查询；未调用 checkout、订单或付款 |
| 美团公开地点 | 在原有北京市／天安门白名单内完成，独立 PA accepted | 未扩大公开地点查询白名单 |
| 美团本人地址簿 | 独立 PA accepted；未交付电话字段，模型读取账本无完整 addressBook | 地址视图仅交付 PA；本次没有选择地址或发起真实运费估价 |
| Luma 原有报名 | 浏览器重新加载后显示已取消；来源桥记录、v2 Ontology 独立读取均为 canceled | 只证明读取现状；报名确认目标未达成，未重新报名。浏览器桥仍需要在线操作员 |
| 滴滴地点搜索 | JSON-RPC `-32001`，`user maps_textsearch quota exceeded` | 上游配额阻断，真实查询验收未通过；未绕过额度或更换凭据 |

Luma 的当前日期信息沿用同一活动此前已核验的元数据；此次页面没有完整费用明细，因此结果保留 `feesComplete=false` 和未知付款要求。验收任务随后仅在 EIGOS 内停止；没有修改外部报名状态。原始浏览器记录及参与者引用保存在私有证据中。

真实联调暴露的运行问题已修正：foundation 启动复用同一规范会员来源检查；规划上下文的摘要视图不再默认展开完整字段／函数 schema，预备读取超出上下文预算时交回模型重新选择。完整字段与函数显式查询仍可用，原有 30 KB 上下文边界及权限检查保持生效。

## 浏览器来源与查证

参与者浏览器桥在 foundation 下以只读方式打开任务库，核对版本、策略摘要、准确任务／计划／操作、当前 AgentGrant、资源动作权及来源许可。入队后到操作员实际开始前再检查；撤销会阻止派发。浏览器操作员与 Worker 凭据保持分离。

`/audit/operations/{originalKey}` 另需一个当前、准确的 RecoveryPermit lease。它不能取得普通图、模型或 TaskDataGrant。原提交响应不足以证明独立查证：仅当已有单独的 `ReadParticipantRegistration` 观察匹配同一来源、报名及参与者，且在原派发后、5 分钟以内，才报告已观察到的原操作。没有新鲜独立观察时返回 unknown，不自动重新报名或新开浏览器操作。完成／撤销／错误 token、另一操作键和错误身份均不能继续查证。

查证记录写入 audit-only observation，`applied=0`；已取消任务与原意图不被自动恢复或改成完成。不具备原操作 observer 的来源保持 unknown。

## 验收与尚未完成的运行门槛

| 原方案门槛 | 当前证明 |
| --- | --- |
| T01–T06 | 安装／任务隔离、资源 Viewer、具体类型、反向关系、过滤分页、字段和稳定实体：`security-data-policy`、`security-protocols`、双 JWT Connector 测试 |
| T07–T10 | 模型通道／会话复核、领取／派发／迟到保护、跨库拒绝与独立来源许可：S1、Worker、output 和 source-bridge 测试 |
| T11–T13 | 标签继承、统一 TaskView／重放、受控附件、PA 专属地址：output、protocols、native source、独立 Python 测试 |
| T14–T16 | 新安装不继承旧许可、未知策略默认拒绝、任务修订与对象绑定：S1、data-policy、output 和 migration 测试 |
| T17–T18 | 原始证据与未知历史行归档、旧执行方式隔离、标签收紧与准确原操作查证：migration、recovery、Worker、编译后 CLI 测试 |
| 跨进程执行 | 编译后独立 Worker 从持久授权领取原生合成来源任务；父进程独立读取安全结果，随后撤销 |
| 真实同会员双安装 | 两个真实 Auth0 安装已绑定同一活跃会员；独立 PA 隔离／重放和独立 Worker 撤销检查通过 |
| 真实来源只读 | Shopify、美团地点／地址、Luma canceled 状态读回通过；滴滴上游额度耗尽 |
| 常驻切换与切换后 PA 读回 | 未进行；当前 legacy 服务未修改，等待滴滴处理范围选择 |

新 native 测试使用有效期 15 分钟的合成登录登记，匹配现有提供者的常用访问令牌时长；领取租约仍按原运行代码检查。测试入口限制文件并发为 2，以减少大量来源／SQLite 测试同时争抢 CPU 导致的租约噪声。最新本地完整回归 687 项通过，完整编译后 E2E 11 项通过，类型检查、构建和差异检查通过。运行代码提交 `a0137be` 的 [GitHub CI](https://github.com/proerror77/eigos/actions/runs/40158415123) 全部成功，并通过独立 GitHub 工具回读。准确范围见本轮证据。

## 已准备的切换与回退步骤

私有切换包包含验证过的候选环境、准确目标目录、原设置／release 摘要、迁移清单、两个已绑定安装、签名验证过的同会员身份摘要，以及尚未满足的门槛。候选使用独立 foundation 数据路径；不改写当前 tasks.sqlite。发布包必须包括 `dist/packages/security/baseline.json` 和运行依赖；legacy `setup:pa` 已拒绝覆盖 foundation 设置。

1. 已完成 A／B 提供者设备确认、签名身份核对和会员准入。恢复操作时使用各自绑定安装的正常刷新流程，无需重新登记。
2. 已完成临时只读授权、两个安装的隔离／重放／撤销，以及上述真实来源查证。滴滴配额未恢复；已准备不引用其凭据的候选配置，待用户选择切换范围后继续。最终库按选定范围建立新的安装许可。
3. 核对本地／远端同一提交与该 SHA 的成功 CI，冻结包含 runtime JSON 的完整构建摘要。记录旧 launchd、进程、端口、环境、会员库、业务库、来源队列和私有产物。
4. 停止旧 Gateway／Worker／浏览器桥及此次隔离进程，确认端口与领取均已释放。重新捕获闭合数据库和来源文件，执行迁移并验证完整性。若存在未决非只读操作，先保留原身份与原操作查证路径，不重放或强行接管。
5. 新会员快照及明确审阅的授权独立于历史任务迁移；先核对预期会员／安装，重新建立新库许可。个人来源以该会员显式绑定，业务写入仍关闭。启动新构建和新数据路径，核对所有子进程、health、协议、来源身份和独立 PA 读回。
6. 切换前失败可保留所有证据并继续原服务。新库尚无新会员／授权／业务事实时，停止新进程并通过迁移验证后，可以恢复旧配置与原库。**一旦新库承接新的登记、授权、撤销或业务事实，不自动重开 legacy 数据 API**；保留新库和来源队列，停机修复或使用兼容 foundation 的已验证构建前滚／回退，避免丢失新事实或复活已撤销许可。

当前双安装与上述只读来源验收已完成，候选构建及其准确提交 CI 已核对；`readyForActivation=false`，常驻配置仍未修改。尚缺选定来源范围后的停机快照迁移、最终许可、launchd 切换及重启后的独立 PA 读回。
