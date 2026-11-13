# 四类动态本体定义：实现与验证

## 运行结构

正式运行从共享 PostgreSQL 本体库读取命名空间的当前发布。新任务保存准确的 `ontologyId / releaseId / digest`，后续规划、Action、数据投影、权限和结果读取都使用该发布。代码提供初始种子、版本化校验器和受信实现。SQLite 注册库仍用于兼容旧数据和本地测试。

- [定义契约](../../packages/ontology/definition-contracts.ts)声明 Object Type、Link Type、Interface、Action Type 和受控 JSON Schema。
- [编译器](../../packages/ontology/model-compiler.ts)检查依赖、接口实现、字段权限、动作规则和准确受信任处理器引用，生成不可变模型。
- [PostgreSQL 发布解析](../../packages/postgres/ontology-release.ts)从持久发布读取任务版本。关系导航从该版本的 Link Type 和 Interface 映射解析端点。模型缓存只保存已编译定义，事实与权限仍由任务作用域查询取得。
- [管理服务](../../packages/ontology/definition-service.ts)同时服务 HTTP、MCP 和基础审查页面；创建定义、发布定义和执行业务分别鉴权。
- [通用数据动作](../../packages/capabilities/dynamic-ontology.ts)使用[受限声明式规则](../../packages/ontology/action-dsl.ts)，复用现有 Task、Intent、Attempt、Observation、授权、Worker 领取、租约和取消检查。

`eigos.business` 是共享默认本体，查看需要对应读取权限，修改还需要 `ontology:admin`。新建本体归当前验证身份所有，独立命名空间中的同名类型和实例互不混用。命名空间授权发生在返回定义、数量、差异或历史之前。

## Function与Action Type的边界

领域概念按对象、业务决策和可观察结果划分，代码中的类名、函数名和步骤 ID 只能作为实现线索。Palantir 的 Function 可读取属性、遍历关系、返回对象集和计算结果，也可访问外部系统，或通过 function-backed actions 描述本体编辑。因此“Function 一律只读”不是通用定义。[Palantir Functions](https://www.palantir.com/docs/foundry/functions/overview)

**EIGOS 当前的注册本体函数采用只读查询／计算子集**，受控实例写入通过独立的 Action／Worker 提交路径完成；这是一项实现边界，不能表述为已经具备完整的 Palantir Function、外部函数或 function-backed action 能力。Action Type 应表达可提交的对象、属性、关系变更及规定副作用；本体事务不自动使供应商 HTTP 调用具备同样的原子性。[Palantir Action types](https://www.palantir.com/docs/foundry/action-types/overview)

MCP 工具、供应商端点和运行步骤不是业务 Action Type 的同义词。当前[滴滴读取模块](../../packages/ontology/definitions/didi-readonly.json)把 `SearchDidiPlaces`、`EstimateDidiRide` 固定为来源读取合约，分别绑定 `maps_textsearch`、`taxi_estimate`；[程序](../../packages/capabilities/didi/program.ts)检查来源、所选地点角色、读取凭据和有效期。即使这两个 ID 已登记为运行模型中的动作资源，也不能仅凭名称认定业务边界已与 Palantir 对齐。

下面是出行业务的**拟议概念映射**，不是新定义已经发布、接口已经实现或真实服务已经接通的声明：

| 业务概念 | 应表达的身份、状态与关系 | 当前模型可参考的对象 |
| --- | --- | --- |
| Place | 来源限定的地点及身份依据；同名不自动合并 | `Place`、`DidiPlaceObservation` |
| Route | 有方向的起终点及其选取依据；不证明实际接送 | `RideRoute` |
| Quote | 对准确路线和条件的价格、条款及观察期限；费用缺项仍未知 | `RideEstimate`、报价相关接口；估价不能升级成最终报价承诺 |
| TripRequest | 用户的出行需求、约束、所选方案与申请状态 | `ServiceRequest`；是否细化为独立类型待设计 |
| Order | 供应方确认的订单及请求、确认、取消等状态和证据 | 需单独核对出行业务定义与供应方绑定；本表不新增通用 `Order` ID |

查询地点、计算路线、取得估价和比较候选，可作为查询／计算 Function 的领域职责；外部读调用还需明确来源绑定和证据契约。用户选择准确报价、请求出行或申请取消，才是需要明确变更范围、提交条件及副作用的业务决策边界。选择报价不等于已经下单，申请取消也不等于供应方已取消。这些是拟议职责，不是对现有 ID 的改名方案。[概念参考](https://www.palantir.com/docs/foundry/ontology/core-concepts)

来源采集与[事实投影](../../packages/ontology/ride-estimate-projection.ts)保存“来源在何时说了什么”，可以产生来源观察及关联事实；它们不代表用户已选择方案、建立订单或完成出行。当前仍不允许真实下单或付款。扩展到业务 Action Type 前，需核对实际对象／关系变更、原用户授权、供应方回执、幂等、撤销、取消与迟到结果，而非给现有读取步骤换名称。

现有滴滴读取 ID 仍由 v35 发布解析。读取结果落为 `RideEstimate` 后，可以按 `MonetaryFact` 查询价格，通过 `route` 和 `sourceReceipts` 读取路线及来源。独立验收依据原任务的来源回执与函数结果。

## PostgreSQL与pgvector语义检索目标

迁移目标包含 PostgreSQL 上的 **pgvector 语义检索**，用于召回与当前问题相关的定义、说明或获准业务资料。pgvector 提供向量相似性检索；相似度既不是权限判断，也不证明实体同一性、来源真实性或业务执行成功。[pgvector 官方说明](https://github.com/pgvector/pgvector)

落地时必须保留以下边界，当前均需实现与联调验收：

- 生成 embedding 的材料与返回给模型的检索结果，均受 owner、命名空间、任务发布版本及字段可见性约束；不能将不可见原文或内部字段先发给 embedding 服务，再以结果过滤代替授权。
- 向量记录应能追溯原对象／定义及其准确版本、内容摘要和 embedding 模型版本。命中后通过原有授权查询重新读取允许的字段；撤权、字段收紧、来源失效或版本变化必须反映到实际返回结果。
- 相似候选仅供发现。RAG、重排、对象集数量或缓存均不能绕过 owner／版本／字段过滤，不能从未返回候选推定全域不存在，也不能据此发放来源、模型或动作权限。
- embedding 供应商、模型、维度、索引方案、费用及私有资料外发许可仍为 `unknown`，需明确后才能配置；本要求不自动引入新的收费供应商。

文档中的目标不证明扩展已安装、向量已生成或查询已接通，须以实际目标库、权限否定用例和端到端回读确认。语义召回与业务 Action Type 的提交、供应方授权及结果验收分别验证。

## 领域边界与SQL查询预算

本体 Function 用于可复用的领域查询、计算和明确契约的逻辑，不要求把每条 SQL 行过滤、claim、租约或字段授权检查都暴露为 Function。存储与安全层保留完整检查；将读取命名为一个 Function 或 Action，也不会自动消除重复查询或网络往返。

完成入口认证后的热态任务根对象读取预算为 8 次数据库请求。实际 PostgreSQL 回归通过查询服务读取当前任务的直接绑定根对象，并将事务控制和独立资格连接计入预算。普通根对象读仍需核对准确发布、对象及字段授权、来源和输出证据，提交前后重新检查原授权。

关系、函数和完整任务流程的预算应按数据规模及具体请求分别测量。记录初始化、来源读取、规划验证、Kernel 许可与独立规范投影的 SQL 条数、往返和时延，同时核对有效期、撤权、取消及迟到结果。生产时延以真实运行链路和业务回读为准。

## 原始模型与迁移

原始 `eigos.business@15` 固定摘要为 `efd2ef430b621b1c4f83b8d4e79a794126d24257bfa5022a5c1de8bdd6e48776`，包含 153 个对象类型、7 个接口、655 个关系、55 个动作、40 个函数。冻结快照和准确受信任校验器保留原始语义与指纹；不会把旧事实重新盖成新摘要。

原有校验器包含自定义约束和规范化处理，普通 JSON Schema 往返不能完整保留。种子使用版本化 `validatorRef` 保留受信校验；函数和已有来源程序只接受准确注册合约。

### 已审阅内核发布

每一层都可按版本重建。v28 用于默认权限基线，业务版本由 PostgreSQL 当前发布决定。v36、v37 保留为可重放的定义，v37 的来源和 writeback 注记还未接入运行。

| 版本 | 内容 | 指纹常量 |
| --- | --- | --- |
| 26 | 单次读取 | `SINGLE_READ_KERNEL_MODEL_REF` |
| 27 | 支付与商务 | `PAYMENT_COMMERCE_KERNEL_MODEL_REF` |
| 28 | 业务描述（当前默认） | `BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF` |
| 29 | 语义检索（向量链强制要求） | `SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF` |
| 30 | PA 分类标签 | `PA_CLASSIFICATION_KERNEL_MODEL_REF` |
| 31 | 领域词表（行程域改用运行时拼写） | `DOMAIN_VOCABULARY_KERNEL_MODEL_REF` |
| 32 | 本体合同与受审动作条件 | `CONTRACT_CLOSURE_KERNEL_MODEL_REF` |
| 33 | 可执行动作的效果范围 | `EFFECT_COVERAGE_KERNEL_MODEL_REF` |
| 34 | 函数执行绑定及两项已验证合同 | `EXECUTABLE_CONTRACT_KERNEL_MODEL_REF` |
| 35 | 全部 54 项函数合同验证 | `FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF` |

v35 保留已有函数的业务语义版本，为此前处于兼容模式的 52 项函数绑定输入校验、结果结构与读取范围。运行时按任务固定的发布检查调用、实际读依赖和结果。目录向调用方展示当前角色可见的依赖与投影后的结果结构。宿主安装受信实现后，选择 v35 的任务仍需对应版本角色。旧任务沿用自己的不可变发布。

`npm run ontology:integrity` 逐个重建可选定版本并核对指纹，同时检查悬空关系、孤立类型、分类词表闭合、每域可发现性，以及"没有实现的动作必须显式声明"。CI 的 `ontology-integrity` 任务在 `packages/ontology/`、已审阅模型兼容层或词表契约文档变更时强制运行；新增可选定版本却没有指纹常量会直接失败。

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

实例查询的公开合同仍是按类型、准确对象或单条命名关系读取，支持既有标量筛选与游标；默认按 `(type,id)` 排序。`path`、`hops`、`aggregate`、`groupBy`、`orderBy` 不是公开参数。注册 Function 可以组织多次获准读取，但不能把未读取或不可见的范围说成空集。

PostgreSQL 的 `postgresQueryAuthorizedRelationPlan` 是宿主内部合同，不注册新工具。它最多接受 8 个起点、3 跳关系，每跳完整的获准前沿最多 50 个对象，授权查询／分页调用最多 64 次；每个前沿成员分别通过原来的对象、字段、关系与证据授权，只有可见结果可以进入下一跳。返回的 `authorizedQueryPages` 记录这些调用／分页次数，不是数据库往返数，也不是单条 SQL 完成整个多跳。普通单跳查询复用同一参数化关系候选编译器，完整性检查使用准确 owner／namespace 下的物理关系数，隐藏或悬空端点不会被当成完整业务证据。

当前正常执行路径已消费单跳候选编译和关系完整性计数。完整的多跳、自定义排序和聚合计划已有宿主级 PostgreSQL 验收，但尚未绑定新的业务 Function；不能将这项内部接口描述为对外通用查询已经支持相应参数。

内部终端在获准值上执行 SQL `count`、整数／定点小数 `sum/min/max` 和稳定排序。数字不转浮点，小数按六位定点比较；时间先按现有 JavaScript 毫秒语义归一化，字符串按 UTF-8 字节序排列，最终以 `(type,id)` 打破并列。数值聚合必须明确列出需保持一致的单位字段，缺失值、单位冲突和非规范值拒绝计算；它不推定参考价格可相加为应付总价。内部结果窗口最多 50 条，窗口位置只用于重新执行同一获准计划，不替代公开游标或持久授权。

基础页面为 `/ontology/manager`。页面只把访问令牌保存在当前页面内存，不写入 URL、浏览器持久存储或定义文档；所有数据和操作仍经过同一管理服务。页面内容包括目录、定义和依赖、差异、校验、发布／激活与历史。

## 数据动作与真实可用性

声明式动作可创建／更新受管对象、添加／删除受管关系和逻辑删除对象。参数、条件和变更是受限 JSON 数据，不接受任意代码、远程 schema 或未注册函数。Interface 可约束必需／可选属性、关系和动作；调用时根据实际对象类型解析准确实现及参数映射。

准备动作返回任务、预览摘要和准确目标／字段／revision 范围，不改变目标对象。批准需绑定 `planDigest`、完整 `objectWrite` 和过期时间；数据变化、取消、失效租约和权限撤销仍拒绝提交。Worker 在同一事务内写对象与执行观察，崩溃后按原 Intent 回读，不重复应用变更。最终任务结果来自已提交观察及实际对象回读；连续修改同一对象或关系时按已封存计划的实际序号核对最终状态，不按随机 Intent ID 排序。

显式 Agent/API 选择的数据动作记录为 caller decision；不会伪造 LLM 运行记录。普通自然语言任务仍由 Ontology + LLM 发现动作并生成计划，之后走同一授权与执行路径。

动作详情分开返回发布状态及运行可用性：`definition_only`、`handler_unavailable`、`executable`。后者只表示当前身份有匹配的配置运行程序，不能代替任务范围、参数和授权检查。可信外部动作仅能引用已经注册且版本准确的程序；没有在线安装任意连接器或处理器别名。

用户可扩展普通业务类型的显示信息和兼容可选字段；来源类型的新增字段标为 `sourceBinding: unbound`，直到受信任投影提供数据。创建字段、动作或关系不会取得供应商授权、制造库存／付款事实，或接通现实服务。
