# 本体权限与受保护任务

`EIGOS_SECURITY_MODE=legacy` 是默认兼容模式；`foundation` 把成员／安装、资源、任务数据、来源和输出通道分别授权。切换模式不是普通代码升级，必须使用独立持久任务库、独立会员库和明确的 JWT Agent client。Gateway 与 Worker 必须使用同一任务库、模式和策略定义；Worker 不读取会员登录会话或 Bearer。

## 权限与撤销

成员资格、Agent 安装许可、资源角色、任务数据、来源绑定和模型／接收通道各自检查。父级编排许可不等于子服务来源许可。缺失、过期、撤销、未登记的来源或通道一律拒绝，不自动补发历史权限。

原生 Ontology MCP 的任务上下文还需要显式批准已审阅的元数据字段，例如 RequestSpecification、RequestInstruction 和 RegisteredCapability。准确清单由 [`taskContextFields`](../../packages/security/task-context.ts) 维护，并与当前字段策略取交集。来源结果许可不会自动授予这些元数据；缺许可时拒绝读取，也不能把整个 Job、私有调用参数或模型历史作为替代上下文。

Gateway 的资格协调器发布短期资格投影；Worker 在领取、心跳、派发和结果提交时重查。撤销先建立拒绝栅栏，再更新跨库状态；未完成栅栏保持拒绝。取消或撤权不能证明供应商动作撤销：已派发操作保留原身份，只能在独立恢复许可下查证，不能重发或重开终态任务。

内部安全封套可累计最多 2,000 条不同的数据血缘依赖，schema 与合并器使用同一上限。合并只去掉完全相同的项；超限、跨归属或不同提交指纹会拒绝，不能截断历史来取得输出。模型调用和结果回读仍逐项检查当前授权、字段标签与内容摘要。该容量独立于成员许可、任务输入范围和执行预算。

过期领取恢复时若触及血缘容量上限，系统记录明确的技术暂停并释放过期领取，保留原任务、授权及全部读取记录。输出继续拒绝，后续轮询不会反复写入同一失败；既有终态不因此重新打开。

会员本人在 `/members/permissions` 检查精确授权和来源资格；`/members/security/grants`、`/members/security/sources`、`/members/security/recoveries` 及任务 recovery-preview 是同一控制面。`npm run members -- approve/suspend` 读取数据库实际模式并复用撤销协调，不能因漏配环境变量绕过 foundation。

## 持续有效的授权

新开通的 PA 安装、来源及任务数据许可默认持续有效，直到本人主动撤销。合同使用明确的 `expiresAt: null`，页面显示“持续有效，直到你主动撤销”；不会生成一个虚构的未来到期日期。正常任务从长期安装许可继承长期任务许可，暂停、恢复和请求修订保留其有效性，MCP、A2A 与 HTTP 共用这些检查。

既有明确截止日期继续生效。历史暂停任务可通过权限页的“更新原助手的授权并设为持续有效”一次性转换：安装上限和选定来源必须允许长期访问，原 PA、请求版本、输入、处理权限及交付渠道保持准确匹配。该操作适用于没有操作账本、或现有账本及计划全部为读取／本地操作的暂停任务；现有意图和尝试原样保留，不由授权转换重放。批准后仍暂停，随后由原 PA 恢复。单独撤销的授权不会自动恢复，未知业务操作仍走原操作查证。

长期许可只改变用户同意的有效期。登录令牌、资格投影、Worker 领取、执行预算、观察委托期限、供应商报价和专用原操作恢复窗口仍有独立边界；撤销、取消、来源版本、字段、归属和结果时效检查照常执行。

已有 Foundation 数据库先在维护窗口停止 Gateway／Worker，保存一致性备份，再运行 `scripts/upgrade-persistent-consent-policy.mjs --database /absolute/private/database --expected-digest <当前摘要> --expected-revision <当前版本>` 预览，加 `--apply` 才升级。正式库须配置准确的 `EIGOS_AUTHORITY_FILE`。升级只启用新合同，不延长或恢复任何已有许可，也不调用模型或供应商；既有许可的长期转换由会员明确审阅。

旧策略在升级前继续执行原有有限期限；写入长期许可会明确拒绝，不能由启动过程自动采用新合同。旧历史策略指纹保持不变。SQL 到期索引对长期许可使用超出所有合法 JavaScript 日期的整数上界，权威 JSON 中仍为 `null`。回退到不认识该合同的代码需要明确的兼容处理，不能静默改回旧策略摘要。

## Foundation v2 协议

MCP 与 A2A 都使用 `eigos.task.v2`，不返回原始 Job、模型历史或内部计划账本。完成要求 Task completed、`accepted=true` 和允许接收的实际输出；`outputStatus=restricted`／`receipt_only` 不是可用业务结果。附件通过受控下载接口单独检查。

A2A 的许可在 `metadata.authorization`，v2 预约付款交接在 `metadata.payment`；legacy 仍使用其业务摘要中的 delegation 字段。回复携带当前 `revision` 对应的 `expectedRevision`。本体查询必须显式绑定 version 2 与 taskId：

```json
{"version":2,"taskId":"已获许可的任务ID","query":{"object":{"type":"ServiceRequest","id":"该任务ID"}}}
```

`evaluate_ontology` 使用 `call` 代替 `query`；`check_access` 只诊断当前许可，不授予权限。游标只用于原安装、任务及查询，不能用来恢复被隐藏字段。来源事实通过已声明的 observedData／authorizedInput 投影提供，不直接导出私有 snapshot。

`check_access` 需要已有 `taskId`，不是首次提交前的权限探测器。首次提交被拒绝时按接口返回的 `authorization` 指引处理；个人上下文不可用不等于缺少创建任务权限。两种协议的错误格式及处理见[接入指南](../integration.md#授权错误与下一步)。

`POST /security/context` 返回当前安装、AgentGrant 与 epoch。健康检查包含 securityStage；缺失资格协调器时 foundation 返回 unavailable，不能默默回退 legacy。

## 与主线功能的边界

legacy 保留原生本体注册表、会员网络、账号来源连接、用量汇总、技术续接与 Shopify PA 付款 v3。foundation 中未完成资源／任务／来源审查的注册表管理、网络、通用会员账号凭据上传、用量、外部草稿和 v3 付款入口保持不可用；不会因合并代码而继承 legacy 权限。受保护的任务提交、版本化回复、准确许可、取消、原操作查证及 v2 预约付款走共同 TaskSecurity。

foundation 已支持受控的 `amend_task` 与 `resume_task`，MCP 和 A2A 共用权限检查。`amend_task` 只更新原开放只读任务的显式 `personalContext`／`locationContext`，保留未修改事实并拒绝迟到旧结果。`resume_task` 只由原 PA 在运行前置条件恢复后，持当前任务版本、处理权限及对应执行授权续接技术暂停；保留历史、预算和授权期限，不把补问回复当成技术恢复。详见[原任务续接合同](../integration.md#任务接口)。

实际能力与 mode 以运行实例发现结果为准。代码合并、部署、数据迁移、来源资格和真实业务验收分别核验。

## 离线迁移与运行

构建后使用 `scripts/security-migrate.mjs plan --input <私有快照说明>` 规划；`apply` 另需未使用的 output 目录与准确 `--expected-source-digest`；`verify --output <目录>` 回读结果。工具只处理明确指定、已关闭的快照，不读 `.env`、不原地修改常驻库，也不自动创建授权。`security:s0` 核对当前模型与安全清单；模型指纹和历史定义不能为了通过检查而重写。

本机旧 `setup:pa` 会拒绝覆盖已启用 foundation 的实例。身份登记、模型和来源许可、受保护输出及重启读回分别验证后，才能按具体部署授权切换。历史运行证据保存在仓库外归档，不能当作当前实例的验收结果。
