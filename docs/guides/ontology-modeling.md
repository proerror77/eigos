# 四类动态本体定义：实现与验证

## 运行结构

四类定义的权威来源已进入 SQLite 注册库。代码中的原有业务数组仅提供初始种子、明确版本的校验器和受信任实现；新任务读取命名空间的 active release，并保存准确的 `ontologyId / releaseId / digest`。后续规划、Action、数据投影、权限和结果读取使用同一任务版本。

- [定义契约](../../packages/ontology/definition-contracts.ts)声明 Object Type、Link Type、Interface、Action Type 和受控 JSON Schema。
- [编译器](../../packages/ontology/model-compiler.ts)检查依赖、接口实现、字段权限、动作规则和准确受信任处理器引用，生成不可变模型。
- [注册库](../../packages/ontology/definition-store.ts)保存命名空间、稳定资源身份、追加修订、草稿、不可变发布、激活和审计。模型缓存只含静态定义；进程编译缓存、每个注册库的解析缓存和每个任务库的图视图均采用 16 项 LRU 上限。每次解析仍核对持久发布身份，事实与权限不进入该缓存。
- [管理服务](../../packages/ontology/definition-service.ts)同时服务 HTTP、MCP 和基础审查页面；创建定义、发布定义和执行业务分别鉴权。
- [通用数据动作](../../packages/capabilities/dynamic-ontology.ts)使用[受限声明式规则](../../packages/ontology/action-dsl.ts)，复用现有 Task、Intent、Attempt、Observation、授权、Worker 领取、租约和取消检查。

`eigos.business` 是共享默认本体，查看需要对应读取权限，修改还需要 `ontology:admin`。新建本体归当前验证身份所有，独立命名空间中的同名类型和实例互不混用。命名空间授权发生在返回定义、数量、差异或历史之前。

## 原始模型与迁移

原始 `eigos.business@15` 固定摘要为 `efd2ef430b621b1c4f83b8d4e79a794126d24257bfa5022a5c1de8bdd6e48776`，包含 153 个对象类型、7 个接口、655 个关系、55 个动作、40 个函数。冻结快照和准确受信任校验器保留原始语义与指纹；不会把旧事实重新盖成新摘要。

原有校验器包含自定义约束和规范化处理，普通 JSON Schema 往返不能完整保留。种子使用版本化 `validatorRef` 保留受信校验；函数和已有来源程序只接受准确注册合约。

历史内核 v16 引入了 `object_write` 和 managed 授权环境，与旧版本分别存储。首次初始化导入 v15 和当前内核；已初始化的数据库不会随进程启动自动替换 active release。旧执行契约 v16 且尚未记录发布引用的任务，继续解析为准确 v15，不向历史请求、计划或回执补写新 pin。其他旧后端任务仍遵守原历史只读政策。若显式回退到旧 v15，须先恢复支持 managed 授权的当前内核，才能发布声明式数据动作；不将不支持的动作留到执行时才失败。

## 发布、兼容与回退

草稿基于准确发布版本和 namespace generation 创建。逐资源修改需要预期 revision；发布生成不可变完整版本，激活单独进行。两个基于同一版本的草稿即使都先发布，激活第二个时也会检查其基线，不能覆盖已经激活的第一个。

草稿也可绑定[服务接入记录](ontology-pipeline.md)。接入摘要进入同一不可变发布，结构和映射需有当前验证；任务级执行证据另行核对。激活及回退不能移除已经治理的服务策略，退役执行使用明确的 `definition_only` 声明。未登记 Pipeline 的历史发布保持原有解释。

发布前检查端点、继承、接口动作映射、声明式写入范围和数据兼容。原子激活前再次检查现有对象和关系的实际写入指纹及完整属性，防止草稿验证后数据变化。来源、主键、写入权或不兼容 schema 的改变返回 `migration_required`；当前没有自动迁移执行器，不丢弃字段、补默认值或批量改旧摘要。

历史发布可以回退，但须兼容当前全部有效事实；不能通过回退隐藏新增类型的现存对象、恢复旧权限或删除执行历史。空且未被在途任务使用的自定义资源可退役，原 API 名称仍保留，不能借同一或另一个资源 ID 重新定义；需要恢复时显式激活兼容的历史发布。系统生成的执行关联只有在规范定义与原修订完全一致时才可自动恢复。历史发布、资源修订、身份占用和审计表通过数据库约束禁止原地更新／删除。

对象事实按真实 owner 和 ontology namespace 隔离；写入历史保留定义摘要与发布引用。逻辑删除隐藏普通当前查询，保留原对象、历史版本和受保护的执行关联，旧任务仍可通过原版本核对证据。

## 管理接口

HTTP 均返回 `{version:1,result:...}`，错误返回有界的 `{version:1,error:{code,message}}`：

| HTTP | MCP | 用途 |
| --- | --- | --- |
| `POST /ontology/v1/query` | `query_ontology_definitions` | 命名空间、四类定义、依赖、草稿差异／验证、发布及历史 |
| `POST /ontology/v1/commands` | `manage_ontology_definitions` | 创建本体／草稿，修改／退役定义，发布、激活、放弃草稿 |
| `POST /ontology/v1/actions/prepare` | `prepare_ontology_action` | 预览一个具体动作或接口动作，创建等待准确授权的任务 |
| `POST /ontology/v1/actions/approve` | `approve_ontology_action` | 授权准确对象写入范围，交由 Worker 执行 |

查询使用 `operation` 判别字段，资源按 `kind=object|link|interface|action` 读取。草稿读写绑定 `ontologyId + draftId`；发布／激活绑定准确 release 和预期版本。单次定义命令最多 48 KB，目录每页最多 50 项，单次响应最多 256 KB；超限要求缩小查询，不能用全模型绕过既有上下文预算。

管理权限：`ontology:read` 查看；`ontology:write` 编辑；`ontology:publish` 发布／激活；编辑者和发布者均可执行只读发布前校验；`ontology:admin` 管理共享默认本体或跨 owner 元数据。写入实例仍需要 `tasks:write` 与 `ontology:object_write` 的准确任务授权。管理员查看另一人的定义不改变对象实例的 owner。

现有 PA 自动接入仍默认请求原有任务 scopes，不自动申请建模、发布或管理员权限。建模客户端需要单独取得相应 OAuth scope。默认 Auth0 配置不登记 `ontology:admin`，共享本体管理员必须由可信发行者另行配置明确的操作人策略。

统一主实例的独立本体管理入口使用专用原生 OAuth 客户端。操作员在该入口的 `nativeClientIds` 中登记，并由可选的 `ontologyOperators: [{clientId, subject, tenant}]` 精确绑定现有会员身份；新增配置通过 authority 修订和原摘要校验安装。只有发行者已经签发的 `ontology:read/write/publish/admin` 能保留，`ontology:object_write` 不在此入口的管理权限中。安装、来源、任务数据与效果授权仍分别检查。

Auth0 操作员保护 Action 为 `integrations/auth0/ontology-operator.cjs`，单独部署并配置 `EIGOS_RESOURCE`、`EIGOS_ONTOLOGY_OPERATOR_CLIENT_ID` 和 `EIGOS_ONTOLOGY_OPERATOR_SUBJECT`。它只保留指定客户端与会员已获准的 scopes，不自动加权；其他客户端不能取得该入口的本体管理权限。先安装保护策略再开放 API scopes，保留现有身份 Action、连接和其他应用配置。

本机入口为 `node scripts/ontology-operator.mjs --profile /private/operator/profile.json login|status|query|command`。`query`／`command` 使用明确的 `--input` JSON 文件。profile 包含规范 `baseUrl`、`issuer`、`audience`、`clientId`、`subject`、`tenant`、`tenantClaim` 和 `callbackUrl`；回调须为固定端口的 `http://127.0.0.1:<port>/callback`。目录权限为 0700，profile 与独立 credentials 文件为 0600。登录使用授权码、PKCE、state 和 nonce，验证签名及精确会员身份后才保存令牌；登录不会发放来源或任务授权。

现有 `/ontology/describe`、`query`、`evaluate` 和对应工具支持 `ontologyId`、准确 `release` 或 `taskId` 上下文；任务引用和显式版本不能相互冲突。MCP 与 A2A 的业务任务共用 TaskService 版本解析。

基础页面为 `/ontology/manager`。页面只把访问令牌保存在当前页面内存，不写入 URL、浏览器持久存储或定义文档；所有数据和操作仍经过同一管理服务。页面内容包括目录、定义和依赖、差异、校验、发布／激活与历史。

## 数据动作与真实可用性

声明式动作可创建／更新受管对象、添加／删除受管关系和逻辑删除对象。参数、条件和变更是受限 JSON 数据，不接受任意代码、远程 schema 或未注册函数。Interface 可约束必需／可选属性、关系和动作；调用时根据实际对象类型解析准确实现及参数映射。

准备动作返回任务、预览摘要和准确目标／字段／revision 范围，不改变目标对象。批准需绑定 `planDigest`、完整 `objectWrite` 和过期时间；数据变化、取消、失效租约和权限撤销仍拒绝提交。Worker 在同一事务内写对象与执行观察，崩溃后按原 Intent 回读，不重复应用变更。最终任务结果来自已提交观察及实际对象回读；连续修改同一对象或关系时按已封存计划的实际序号核对最终状态，不按随机 Intent ID 排序。

显式 Agent/API 选择的数据动作记录为 caller decision；不会伪造 LLM 运行记录。普通自然语言任务仍由 Ontology + LLM 发现动作并生成计划，之后走同一授权与执行路径。

动作详情分开返回发布状态及运行可用性：`definition_only`、`handler_unavailable`、`executable`。后者只表示当前身份有匹配的配置运行程序，不能代替任务范围、参数和授权检查。可信外部动作仅能引用已经注册且版本准确的程序；没有在线安装任意连接器或处理器别名。

用户可扩展普通业务类型的显示信息和兼容可选字段；来源类型的新增字段标为 `sourceBinding: unbound`，直到受信任投影提供数据。创建字段、动作或关系不会取得供应商授权、制造库存／付款事实，或接通现实服务。
