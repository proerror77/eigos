# 权限 S0：冻结合同、完整清单与迁移 dry-run

日期：2026-10-24。依据[三层权限方案](ontology-permissions-implementation-plan-2026-10-24.md)的 S0；`eigos.security.v1` 与 `eigos.security-baseline.v1` 固定身份和政策合同。本页保留 S0 历史交付与快照：S0 没有安装运行时拦截或授予新权限。后续的身份控制面见 [S1](security-s1.md)，当前可选 foundation v2 的数据／输出保护见 [S2–S4](security-s2-s4.md)。

## 已交付

| 交付 | 位置／用途 |
| --- | --- |
| 会员／安装／Worker 身份合同 | [contracts.ts](../packages/security/contracts.ts)：AccessContext 判别联合；复用原 ownerKey 语义、会员 UUID、registration.id、任务 revision 和 scopes，不重建登录系统。 |
| 安装／任务数据／执行授权合同 | 同上：AgentAccessGrant、TaskDataGrant、TaskExecutionAuthority 的严格数据结构；已有 PlanGrant 保持原状。解析成功只证明结构有效，不证明权限有效。 |
| 安全标签与默认规则 | 同上：SecurityEnvelope、角色权限、无自动降密／跨会员共享／旧任务补权；运行时策略组合和撤销由 S1–S4 实现。 |
| 已审查模型清单 | [baseline.json](../packages/security/baseline.json)：112 个类型、889 个顶层属性的明确政策，模型和逐类型摘要；代码路径随 S1–S5 复核扩充到 95 个，S0 初次归档仍为当时的 30 个。 |
| 嵌套字段覆盖和变化检测 | [inventory.ts](../packages/security/inventory.ts)：枚举对象／接口／关系／动作／函数；属性树覆盖数组、union、开放 record 和未知结构。新定义／字段、嵌套 schema 变化、已限制字段降级、已登记出口变化使检查失败。 |
| 只读快照迁移报告 | [migration-audit.ts](../packages/security/migration-audit.ts)：直接 readOnly 打开显式快照，不构造会创建表的 JobStore／MemberStore，不执行迁移 SQL。 |
| 可重复入口和回归 | [security-s0.mjs](../scripts/security-s0.mjs)、[测试](../tests/security-s0.test.ts)：清单检查、合同反例、离线副本、隐私和无改写验证。 |

S0 交付时生产入口未导入 `packages/security`，Gateway、Worker、会员、安装、TaskService 和 PlanGrant 行为没有被 S0 改写。后续 [S2–S4](security-s2-s4.md) 已在可选 foundation v2 接入共同权限层。本文的历史快照与 S0 验证不自动代表运行实例的状态。

清单放在 `packages/security/`，与 `ontology/` 顶层可执行 MCP 定义包分开；不修改现有 `ontology:sync` 或发布加载器。

## 分类含义

| policy | 后续实施合同 |
| --- | --- |
| task_private | 原会员私有数据；Agent 仅在安装／任务／字段授权内可读。不是公开数据，也不是现在自动发放的读取权。 |
| task_sensitive | 涉及个人资料、位置、健康、财务或复合输入；需明确字段／用途及相应标签资格。第一版对无法安全拆分的复合结构整体保护。 |
| internal_only | 原 restricted 字段、来源 snapshot／data／subjects、授权元数据及开放内容；默认禁止 Agent 读取。S2 如要开放业务字段，须先新增经过审查的安全投影。 |
| derived_from_inputs | 计算只使用当前授权输入；输出继承实际依赖的限制，不通过“这是计算结果”获得读权。 |

每条字段政策覆盖整棵子树，具体 schema 摘要固定。共记录 3,625 条规范化 schema 路径（含父节点、数组和通配路径，**不是 3,625 个独立业务属性**）。开放 record 的所有未知键继承 internal_only；不能只根据已知 key 的名称放行其余内容。

类型行策略统一预定为 owner 与显式 task grant 交集；可复用资产不强制变成单任务实体。256 条关系要求两端与任务绑定；52 个动作独立检查执行许可并保留 PlanGrant；35 个函数沿调用者权限读取。三个接口不能绕过具体类型权限。定义摘要与安全策略摘要分开，现有业务证据 digest 不改写。

S0 的出口清单覆盖 HTTP／MCP／A2A、任务变更响应、等待／列表／幂等、会员／安装控制、模型输入与缓存、来源连接器／浏览器桥、临时文件、CSV／Markdown 交付及日志接缝。它是经过源代码核查的明确清单，不是静态污点分析器；后续增加入口或新渠道必须更新清单及测试。当前 83 个路径摘要包括 S1–S5 的身份、策略、Worker、安全出口、来源、客户端及离线迁移。报告中的 `enforcement=not_installed` 保留 S0 审计合同，表示本审计命令不安装权限；它不是运行状态探测。实际实例须独立检查 mode、数据库版本和 `/health`。

## 冻结的首期默认值

- 安装仅限 task-only，授予期限最长 30 天；任务数据与持久执行授权最长 24 小时，且不得超过父授权有效期。结构校验检查自身上限，父子权限／期限交集由后续策略层检查。
- Viewer 只含 resource.view；Editor 增加 resource.edit；Owner 再增加 resource.manage。action.execute／function.invoke 单独授权，角色不自动授予数据、降密或跨会员读取。
- 成为会员不会自动获得资源角色；旧 token scope 不转换成安装／任务 grant。原任务所有者键继续由 issuer／tenant／subject 构成，不混入安装 ID。
- AccessContext 保留签名已验证的完整 scope 列表，包括现有 members:write 和 OIDC scopes；接口检查仍只认可其明确要求的 scope。未知 scope 不意味着新增操作权限，身份字符串也不被当成授权通配符。
- 资格投影 lease 初始 60 秒、30 秒刷新；协调入口撤销不等待 lease 到期。这里只固定参数，不声称撤销协调已实现。
- `task.process`、`task.query`、`member_asset.read`、`task.result.read`、`artifact.export` 是不同 operation。write-only 提交未来只返回最小回执；其内部任务处理须有明确执行授权，不能扩大到已有会员资产。
- 模型渠道未登记或数据类别不匹配默认拒绝；安全标签初始类别是 member_private、personal_data、precise_location、health、financial、account_private；分类仅 private／sensitive／internal，没有 Foundry 全套 CBAC 的 OR／跨域语义。
- 解析合同不建立主体真实性、不查询当前会员状态、不验证父子 grant 子集、作用于当前对象的政策或当前时间是否过期；这些均是 S1–S4 的执行检查。合同不能被直接当成 `authorize()` 使用。

## 使用

只检查本地源码模型／出口与冻结清单，不读取环境变量、数据库或供应商：

```sh
npm run security:s0 -- --check
```

检查**已经准备好的离线快照**，生成私有完整报告：

```sh
npm run security:s0 -- \
  --database-snapshot output/security-s0/tasks-snapshot.sqlite \
  --membership-snapshot output/security-s0/members-snapshot.sqlite \
  --output output/security-s0/report.json
```

输出目录应预先建立；文件以 0600、排他新建方式保存，已有文件不会被覆盖。工具不自动读取 `.env`、常驻路径或安装凭据。两个快照必须是不同的既有普通文件；缺表、未知 schema、单表超过 50,000 行、jobs／objects 单表 body 合计超过 64 MiB 均拒绝。单个超过 1 MB 的 body 不解析，列为不可识别记录。只读审计不替代事务一致的切换备份。

报告只输出汇总、已登记类型和记录摘要标识；没有姓名、issuer/sub、任务正文、地址、令牌、源响应或原始对象 ID。摘要标识仍留在忽略目录；本次归档仅保留经检查的汇总。成员／安装统计只读相关状态列，不读取 session／access token 哈希表。

## 本次实际快照结果

对本机常驻的任务库和会员库分别使用 SQLite online backup，源连接为只读；随后在副本上运行工具。两个备份不是跨数据库原子快照，不能用于宣称运行时授权一致性。副本审计前后字节摘要相同。完整副本与逐记录报告保留在忽略目录 `output/security-s0-2026-10-24/`。

| 内容 | 数量／处置 |
| --- | --- |
| 任务 | 39：29 个旧后端合同保持只读；6 个无法按当前 request 合同解析；4 个当前合同仍缺明确安装授权。 |
| 对象 | 467：12 个具有当前直接任务关联候选，仍须复核来源证据；209 个任务证据过期或缺失；123 个无直接绑定；123 个定义摘要不符合当前模型。 |
| 关系 | 895；其中 367 个不能用当前定义／已验证端点直接确认，需要历史版本或关系复核。 |
| 会员与安装 | 所选常驻会员库均为 0；本机开发身份的数据不能推定归属于某个真实会员或安装。 |
| 其他出口 | 46 个缓存响应、28 个任务产物、31 个带模型历史的任务、89 个 ActionIntent；全部列入后续安全投影。 |
| 既有业务许可 | 3 个 PlanGrant；不等于新的安装或数据访问许可。 |

“不符合当前定义／合同”不等于数据损坏。工具不把历史 schema 按新模型解释，也不删除或重写记录。直接任务关联只是候选，不验证全部 provider receipt／来源证明，不沿任意图路径推导权限。即使当前会员或安装有效，也不能证明历史任务是该安装提交。

报告固定 `migrationReady=false`、`permissionsGranted=0`、`writes=0`。文件系统中的独立原始来源文件／附件没有逐文件扫描，已在源码路径清单中归为私有；S4／S5 需在明确迁移目标中盘点和重新投影。

脱敏机器记录见 [summary.json](evidence/security-s0-2026-10-24/summary.json)。结果证明 S0 清单与只读分析完成，不证明 S1 权限已生效或这些历史数据可直接自动迁移。

## 验证与接续

v20 只读数据流改造保留全部对象字段政策与逐类型指纹，新增 `selectDidiPlace` 纯函数，并复核模型上下文、协调、执行和定义接缝；额外登记延后绑定、数据流合同、首轮 scope 绑定及来源选择四个路径。模型整体摘要随动作／函数合同变化，历史 S0 快照统计仍按原版本解释；没有借更新基线授予权限或改写业务证据。见[数据流合同](ontology-read-dataflow-2026-10-24.md)。

回归覆盖定义／嵌套 schema 漂移、restricted 不降级、来源路径漂移、安装身份缺失、原始凭据注入、控制者不匹配、通配范围、许可超期、旧任务补权禁止、错误定义／任务版本、无隐私输出、快照不改写、缺表／缺文件和报告不覆盖。本地类型检查、601 项测试、构建、8 项进程 E2E、S0 清单检查和 diff 检查通过；最终清单目录下的 8 项 S0 专项另行复跑通过。远端 CI 和部署状态分别回读。

后续 S1 已复用 MemberStore 和 AgentRegistrations，接入验证后的 registration.id、AccessContext、最小资格投影、grant 存储及共用撤销协调；会员 UI、安装 revoke、连接停用和管理 CLI 使用同一拒绝边界。S1 的实现与当前限制见专门说明，不能把它称为三层权限全部完成。

模型分段测量已合入：仅保存客户端时钟、流式边界、计数与摘要，不保存隐藏推理文字；首输出前的合并等待不称为服务端排队或纯推理。
