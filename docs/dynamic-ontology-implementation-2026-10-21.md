# 四类动态本体定义：实现与验证

日期：2026-10-21。对应[已批准的 P0–P6 计划](dynamic-ontology-metamodel-plan-2026-10-21.md)。当前状态：实现与本地验收完成。最终提交的 CI 与远端一致性按对应分支回读。本轮不部署、不真实下单付款。

## 运行结构

四类定义的权威来源已进入 SQLite 注册库。代码中的原有业务数组仅提供初始种子、明确版本的校验器和受信任实现；新任务读取命名空间的 active release，并保存准确的 `ontologyId / releaseId / digest`。后续规划、Action、数据投影、权限和结果读取使用同一任务版本。

- [定义契约](../packages/ontology/definition-contracts.ts)声明 Object Type、Link Type、Interface、Action Type 和受控 JSON Schema。
- [编译器](../packages/ontology/model-compiler.ts)检查依赖、接口实现、字段权限、动作规则和准确受信任处理器引用，生成不可变模型。
- [注册库](../packages/ontology/definition-store.ts)保存命名空间、稳定资源身份、追加修订、草稿、不可变发布、激活和审计。模型缓存只含静态定义；进程编译缓存、每个注册库的解析缓存和每个任务库的图视图均采用 16 项 LRU 上限。每次解析仍核对持久发布身份，事实与权限不进入该缓存。
- [管理服务](../packages/ontology/definition-service.ts)同时服务 HTTP、MCP 和基础审查页面；创建定义、发布定义和执行业务分别鉴权。
- [通用数据动作](../packages/capabilities/dynamic-ontology.ts)使用[受限声明式规则](../packages/ontology/action-dsl.ts)，复用现有 Task、Intent、Attempt、Observation、授权、Worker 领取、租约和取消检查。

`eigos.business` 是共享默认本体，查看需要对应读取权限，修改还需要 `ontology:admin`。新建本体归当前验证身份所有，独立命名空间中的同名类型和实例互不混用。命名空间授权发生在返回定义、数量、差异或历史之前。

## 原始模型与迁移

原始 `eigos.business@15` 固定摘要为 `efd2ef430b621b1c4f83b8d4e79a794126d24257bfa5022a5c1de8bdd6e48776`，包含 153 个对象类型、7 个接口、655 个关系、55 个动作、40 个函数。冻结快照和准确受信任校验器保留原始语义与指纹；不会把旧事实重新盖成新摘要。

[P0 审计](evidence/dynamic-ontology-2026-10-21/p0-migration-audit.json)发现 1,537 个属性中有 90 个含自定义校验、447 个含规范化处理；普通 JSON Schema 往返无法保留全部约束。审计反例包括小数件数、错误重量单位、无效时区和不一致的酒店早餐条件。种子因此使用版本化 `validatorRef`，保留原 Zod 校验；函数和已有来源程序也只接受准确注册合约。

当前内核版本 16 明确增加 `object_write` 和 managed 授权环境，与旧版本分别存储。首次初始化导入 v15 和当前内核；已初始化的数据库不会随进程启动自动替换 active release。旧执行契约 v16 且尚未记录发布引用的任务，继续解析为准确 v15，不向历史请求、计划或回执补写新 pin。其他旧后端任务仍遵守原历史只读政策。若显式回退到旧 v15，须先恢复支持 managed 授权的当前内核，才能发布声明式数据动作；不将不支持的动作留到执行时才失败。

## 发布、兼容与回退

草稿基于准确发布版本和 namespace generation 创建。逐资源修改需要预期 revision；发布生成不可变完整版本，激活单独进行。两个基于同一版本的草稿即使都先发布，激活第二个时也会检查其基线，不能覆盖已经激活的第一个。

发布前检查端点、继承、接口动作映射、声明式写入范围和数据兼容。原子激活前再次检查现有对象和关系的实际写入指纹及完整属性，防止草稿验证后数据变化。来源、主键、写入权或不兼容 schema 的改变返回 `migration_required`；本版没有自动迁移执行器，不丢弃字段、补默认值或批量改旧摘要。

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

现有 PA 自动接入仍默认请求原有任务 scopes，不自动申请建模、发布或管理员权限。建模客户端需要单独取得相应 OAuth scope。默认 Auth0 配置不登记 `ontology:admin`，共享本体管理员必须由可信发行者另行配置明确的操作人策略；本次未更改任何线上 OAuth 设置。

现有 `/ontology/describe`、`query`、`evaluate` 和对应工具支持 `ontologyId`、准确 `release` 或 `taskId` 上下文；任务引用和显式版本不能相互冲突。MCP 与 A2A 的业务任务共用 TaskService 版本解析。

基础页面为 `/ontology/manager`。页面只把访问令牌保存在当前页面内存，不写入 URL、浏览器持久存储或定义文档；所有数据和操作仍经过同一管理服务。页面内容包括目录、定义和依赖、差异、校验、发布／激活与历史。

## 数据动作与真实可用性

声明式动作可创建／更新受管对象、添加／删除受管关系和逻辑删除对象。参数、条件和变更是受限 JSON 数据，不接受任意代码、远程 schema 或未注册函数。Interface 可约束必需／可选属性、关系和动作；调用时根据实际对象类型解析准确实现及参数映射。

准备动作返回任务、预览摘要和准确目标／字段／revision 范围，不改变目标对象。批准需绑定 `planDigest`、完整 `objectWrite` 和过期时间；数据变化、取消、失效租约和权限撤销仍拒绝提交。Worker 在同一事务内写对象与执行观察，崩溃后按原 Intent 回读，不重复应用变更。最终任务结果来自已提交观察及实际对象回读；连续修改同一对象或关系时按已封存计划的实际序号核对最终状态，不按随机 Intent ID 排序。

显式 Agent/API 选择的数据动作记录为 caller decision；不会伪造 LLM 运行记录。普通自然语言任务仍由 Ontology + LLM 发现动作并生成计划，之后走同一授权与执行路径。

动作详情分开返回发布状态及运行可用性：`definition_only`、`handler_unavailable`、`executable`。后者只表示当前身份有匹配的配置运行程序，不能代替任务范围、参数和授权检查。可信外部动作仅能引用已经注册且版本准确的程序；没有在线安装任意连接器或处理器别名。

用户可扩展普通业务类型的显示信息和兼容可选字段；来源类型的新增字段标为 `sourceBinding: unbound`，直到受信任投影提供数据。创建字段、动作或关系不会取得供应商授权、制造库存／付款事实，或接通现实服务。

## 验证记录

本轮新增测试与可观察证据如下；普通回归测试使用确定性决策替身；另有一次实际原生 Codex 模型验收，范围仅为隔离的内部数据，不构成外部供应商接入。

| 验收 | 当前证据 |
| --- | --- |
| D01–D05 四类新定义和实际效果 | [HTTP/MCP 演练](../tests/ontology-management-gateway.test.ts)仅通过管理接口创建 3 个对象类型、1 个接口、1 个关系、5 个动作；执行 5 个任务，两个具体类型经同一接口动作分派，正反向关系回读一致 |
| D06 / D12 / D13 权限与来源 | [动作引擎](../tests/dynamic-actions.test.ts)、[调用执行](../tests/dynamic-action-runtime.test.ts)、[能力可用性](../tests/dynamic-catalog.test.ts)、[管理入口](../tests/ontology-management-gateway.test.ts)覆盖无绑定、独立发布／执行 scope、私有命名空间、来源字段、伪造摘要及撤权 |
| D07–D11 发布、回退、历史 | [注册库](../tests/dynamic-definition-store.test.ts)、[任务版本](../tests/dynamic-runtime-versions.test.ts)覆盖并发草稿、发布基线、原子激活、未使用资源退役、禁止身份复用、历史写入指纹、兼容回退、缺失版本暂停、准确旧版本与不可变审计 |
| D09 / D14 热加载与缓存 | Gateway/Worker 两个独立数据库连接及目录均先启动，再发布 R1/R2；原 Worker 无须重启完成各自固定版本的任务。18 次发布还验证 LRU 淘汰后准确恢复旧版本及实时撤权 |
| D04 持久效果与恢复 | 提交前崩溃整体回滚；提交后恢复只有一次写入；取消、过期许可和租约变化阻止提交；[多动作排序](../tests/dynamic-action-order.test.ts)验证创建后更新、建立后移除关系，即使 UUID 顺序相反也按准确计划回读 |
| D14 模型读取 | [Agent 运行](../tests/dynamic-agent-model.test.ts)验证动态能力发现、按需读取准确动作 schema、准确授权与完成前回读；补充信息不能丢弃已经提交的数据动作 |
| D15 旧业务与协议 | 全仓回归、原五类服务沙箱及编译后端到端验证；历史 v14→v15 测试明确使用原始冻结 v15，保留全部字段／来源／枚举反例和原始字节检查 |
| 基础审查页面 | 浏览器实际编辑名称、读取差异、校验、发布与启用；预览／批准受管记录并刷新至完成，另经对象 API 回读 revision=1；切换动作后旧批准控件不可见 |

[浏览器动作回读](evidence/dynamic-ontology-2026-10-21/browser-action-readback.json)仅包含隔离测试数据；[页面截图](evidence/dynamic-ontology-2026-10-21/manager-published.jpg)为本地验收状态。[本地验证记录](evidence/dynamic-ontology-2026-10-21/local-validation.json)保存命令、计数与源码内容摘要：全量回归 897/897；后续认证入口回归 24/24、模型协议回归 17/17、发布／版本／输入纠错及管理入口回归 22/22；类型检查、构建、编译后端到端 9/9 通过。这些后续检查覆盖了全量运行后补入的边界修复，最终提交由 CI 再次执行完整检查。

[真实模型验收](evidence/dynamic-ontology-2026-10-21/real-model-runtime.json)：Gateway、Worker 和目录先启动，再通过 HTTP 发布新定义，MCP 提交内部记录创建目标。实际原生 Codex 完成 8 次模型调用、5 次本体读取，形成 1 个计划、1 个准确 managed 授权、1 个 Intent、1 次写入和独立完成回读，约 95 秒。结果只有 `OfficeRoom/model-room`、名称“模型验收会议室”、revision=1；没有调用者伪造的模型决策或额外业务效果。CLI 未报告具体模型名，因此不推断型号。

[初次探针](evidence/dynamic-ontology-2026-10-21/real-model-runtime-initial-failure.json)原样保留为失败：初始化遇到未找到的上下文对象，尚未形成计划或数据写入。初次选择入参没有保存，不能据此断言具体引用。实现随后明确“已有上下文对象”与“待创建对象”的区别，并在当前任务中把可纠正输入交回模型；新增回归验证这个反馈路径。成功复测未改写模型决策。运行时源码由证据中的 SHA256 清单固定；其后追加的历史内核发布拒绝检查由上述 22 项回归覆盖，本地验证记录明确列出该差异。

可显式重跑模型验收：`node --import tsx examples/verify-dynamic-ontology.ts --run`。它使用已登录的原生 Codex，最多 10 次 Worker 领取／590 秒，仅自动批准写入一个固定的测试记录；CI 不运行该模型探针。最终提交的 CI 和远端一致性单独回读，不用页面状态代替。
