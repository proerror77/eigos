# S2–S4：资源、任务数据与输出保护

本分支在显式 `EIGOS_SECURITY_MODE=foundation` 下实现 S2–S4，开放经过共同权限层的 HTTP、MCP、A2A。默认仍为 `legacy`。这是一套新库上的代码实现与合成验证；没有迁移常驻数据、部署、调用真实来源或执行付款。本文记录 S2–S4 交付当时的范围；后续离线迁移、客户端与来源适配进展见 [S5](security-s5.md)，常驻切换仍待真实会员验收。

S1 的身份、会员／安装撤销和跨库拒绝顺序继续复用。当前 foundation 数据库头为版本 **2**，任务队列标记为 `worker-security-v2`；S1 数据库与旧 Worker 不能自动接续。业务本体仍是 103 个存储类型、823 个属性；当前源代码清单覆盖 60 个入口和执行面。

## 三层检查

| 层次 | 实现与边界 |
| --- | --- |
| 资源 | Viewer／Editor／Owner 分别提供查看、编辑审阅、管理审阅。`action.execute`、`function.invoke` 单独授予；Owner 不自动获得业务执行或降密权。资源版本不符即拒绝。 |
| 任务数据 | 同会员的不同安装分别持有安装上限和逐任务 grant。现有资产固定对象版本、字段和用途；来源输出固定 program、配置摘要、binding、类型和字段。图可达性不能授予访问。 |
| 输出 | 实际输入的 lineage 与 mandatory markings 跟随函数、来源投影、模型输入和结果。分类取更严格级别，markings 取并集，渠道取交集；当前依赖、接收者与模型资格在读取和交付时复核。 |

OAuth scopes 只保留接口上限。资源角色、安装／任务数据许可、来源调用许可、现有 PlanGrant 和金额／收款方／环境检查相互独立。尚未配置的模型渠道、接收资格或字段策略默认拒绝。

资源定义仍由受信代码和版本化配置发布。新增本地 `review-definition` 命令用于检查候选摘要及编辑／管理资格；修改 Link 会同时检查旧、新两端类型，修改 Action 会检查旧、新输入和变更类型。它只试算权限与依赖，不编译完整候选 schema；返回 `published:false`，不提供在线本体编辑器或发布接口。

## 公共协议

三个协议都调用同一个 TaskService 和授权视图。foundation 不保留省略 taskId 的 owner-wide 数据查询兼容入口。

| 入口 | foundation 合同 |
| --- | --- |
| `describe_ontology` / `POST /ontology/describe` | 当前安装可见的定义；可选 taskId 再校验其任务资格。没有实例值、隐藏资源计数或完整内部模型摘要。 |
| `query_ontology` / `POST /ontology/query` | `{version:2, taskId, expectedRequestRevision?, query:{...}}` |
| `evaluate_ontology` / `POST /ontology/evaluate` | `{version:2, taskId, expectedRequestRevision?, call:{function,object,...}}` |
| `check_access` / `POST /ontology/check-access` | 本安装合法任务上的对象／字段、资源查看、函数调用、动作执行、导出检查；返回原因与版本，不签发许可。 |
| HTTP `/tasks`、`/tasks/:taskId`、reply／cancel／authorize | 与 MCP task tools、A2A SendMessage／GetTask／ListTasks／CancelTask 共用当前 TaskView。 |
| `GET /tasks/:taskId/artifacts/:artifactId` | 重新校验任务、导出操作、当前 lineage 和下载接收资格，返回受控文件字节；无原始磁盘路径。 |

查询示例：

```json
{
  "version": 2,
  "taskId": "<当前安装已获授权的任务 UUID>",
  "query": {"object": {"type": "ServiceRequest", "id": "<同一任务 UUID>"}}
}
```

对象、具体类型、关系两端和过滤字段在分页前筛选；Interface 不绕过具体类型权限。游标是服务端保存的不可读随机引用，绑定安装、任务 grant、当前策略、查询与五分钟期限。结果不返回 owner revision 或原始 scanned 数。函数所需集合不完整时返回 unknown，不能将隐藏成员当成零个。

TaskView 标记为 `eigos.task.v2`，仅含安全任务标识／状态、获准的目标、当前问题和已封装交付物。内部 delegation、plans、runs、原始结果、来源定位信息和账本不会作为公共 metadata 返回。写入 scope 不含读取许可时只返回最小 receipt；同 requestId 重放保存的是任务引用，响应重新授权，不重放旧 Job。幂等键包含 installation，原业务 operation key 继续独立防重复。

A2A 的安全付款交接路径是 `metadata.payment.request`／`metadata.payment.selection`，通过发现端点公布；该视图不包含 owner／来源配置摘要。合同存在不表示付款来源已经适配或获得真实支付授权。

## Worker、模型与来源

Worker 每次领取绑定当前执行授权、auth epoch 和 policy revision。模型前后、工具读取、派发事务、checkpoint 和交付均复核；当前策略版本是全局的，相关配置变化会保守地中止进行中的 foundation 领取。权限变更使旧会话与决策摘要失效，释放领取时关闭 foundation 模型会话。原始用户消息和结构化要求也计入模型输入保护，不只保护 ontology tools。

来源许可绑定实际已登记程序的配置摘要、操作、输出类型、安装父授权和期限。来源撤销停止调用，并撤销依赖其输出的任务 grant；来源输出范围或配置收窄也会阻止旧观察再次读取。重新批准安装上限不会恢复旧来源批准。`ExecutionCatalog.permitted(owner)` 的现有本机账号限制仍然有效。

受信程序的初始化／投影可以写入获准的 task output 类型并同事务建立 binding；模型没有写入接口。新绑定保留实际输入 lineage，重新授权读取时检查依赖，避免中间对象成为最终交付物之外的旁路。同一次有界依赖读取只在本次调用内复用验证结果，结束前再次复核；缓存不跨写入或异步回合。投影代码属于受信实现，新增程序仍须审查其原始读取、映射和受控写入范围。

混合内部快照目前只新增两种明确的业务投影：`DidiPlaceObservation.observedData` 和 `RideEstimateObservation.observedData`。它们只包含登记的数据、路线、观察／到期时间与证据种类；原 `snapshot` 仍是 internal_only。加在原 snapshot 上的 mandatory labels 同样限制投影。这里没有自动降密。模型不可读取配置绑定、原始 transport receipt、Key 文件路径或 private trace。

完整正向证明使用既有 DiDi 程序与注入的合成连接器：模型选择两次地点搜索和一次估价，经过真实 Coordinator／Worker／持久账本返回封装结果。没有访问供应商。其他旧程序的混合快照、raw preparation 或来源桥仍须逐项提供审查过的投影；未适配路径拒绝执行，不能据此宣称全部旧业务已支持 foundation。

## 会员审阅与本地管理

`/members/permissions` 复用会员登录、Origin 和 CSRF。页面提供安装上限、来源操作、固定输入、任务输出范围、渠道、期限、撤销与明确接管。

审阅内容保存在服务器，绑定会员、会话、五分钟期限和策略版本。最终提交仅接受 reviewId 和确认值，不能替换已展示的内容。版本检查与写入在同一事务。来源批准会读回当前操作／输出范围，撤销前列出受影响许可。正在领取或已发出非只读业务操作的任务不能直接接管；控制者接管创建独立 `member_controller` authority，不伪造 OAuth scopes。

平台角色、安装接收资格和模型渠道由受信本机管理员配置，会员数据授权不能制造这些资格：

```sh
DATABASE_PATH=/absolute/path/to/isolated/tasks.sqlite npm run security:admin -- status
DATABASE_PATH=/absolute/path/to/isolated/tasks.sqlite npm run security:admin -- grant-role /private/reviewed-role.json
```

先构建，再使用已有 foundation v2 库。所有写命令的 JSON 都要求 `expectedRevision`。支持 `grant-role`、`revoke-role`、`recipient`、`model-channel`、`restrict-object` 和只读 `review-definition`；grant-role 返回 roleId，供撤销使用。`restrict-object` 只能增加限制，不能删除已有 marking 或降低分类。命令不取得来源 token，不提供远程管理服务。

## 原操作查证

撤销／取消后仍不确定的已派发业务操作，可以由会员另行批准原操作查证。它使用独立上下文，接收精确 operation key／远端引用／旧程序摘要，不获得普通 graph、模型、任务数据 grant 或新派发能力。最多三次、一小时内有效，与普通 Worker 共享两路执行预算。

观察只追加 `applied=0` 的审计事实，不推进被取消任务，不重做业务操作。来源失效或没有登记专用 `observeOriginal` 时保持 unknown。目前没有为真实供应商实现这种观察器；专项测试使用合成观察器。普通 recover 方法不能替代它。

## 验证与 S5 边界

验证记录见 [S2–S4 证据](evidence/security-s2-s4-2026-10-24/README.md)。覆盖同会员 A/B 安装与 X/Y 任务、Interface／反向关系／过滤／分页、模型及接收者资格、来源收窄、标签升级与派生结果、幂等重放、受控附件、撤销与迟到事实、HTTP／MCP／A2A、原生审阅表单和编译后 CLI。

浏览器验证使用随机 localhost 域名、合成会员和独立临时数据库，覆盖批准／回显／撤销以及 390px 窄屏；该流程来源调用为零。正常 Worker 用例保留既有 10 秒租约和 30 秒测试期限。

S5 仍需离线迁移工具与快照一致性验收、参考客户端 v2 切换、各真实来源的安全投影适配，以及隔离部署的独立会员／Agent 回读。当前代码拒绝旧 foundation 版本、缺失策略表和定义摘要漂移；不能直接在旧库上切换环境变量。模型已经收到的数据和已下载文件无法撤回，系统只能阻止后续调用、复用及交付。
