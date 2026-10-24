# Palantir 权限语义整理与 EIGOS 适用边界

核对日期：2026-10-24，Asia/Shanghai。来源为 Palantir 官方在线文档；这是一份语义整理，不是 Foundry 配置认证，也不表示 EIGOS 已实现这些能力。实施设计见[三层权限方案](../ontology-permissions-implementation-plan-2026-10-24.md)。

## 1. 阅读范围与需要保留的语义

| 编号 | 官方来源 | 核心语义 | 对 EIGOS 的意义 |
| --- | --- | --- | --- |
| P01 | [Object permissioning overview](https://www.palantir.com/docs/foundry/object-permissioning/overview) | 本体资源定义与对象／链接数据是两类授权对象。 | schema、实例和执行许可分别建模。 |
| P02 | [Ontology permissions](https://www.palantir.com/docs/foundry/object-permissioning/ontology-permissions) | 项目管理资源的查看、编辑、管理；读取实例同时需要类型查看权和数据访问权。链接定义编辑还涉及两端类型；动作定义编辑涉及其修改的资源类型。 | 不能只靠 `tasks:read`，也不能把 schema Editor 当成业务数据管理员。 |
| P03 | [Managing object security](https://www.palantir.com/docs/foundry/object-permissioning/managing-object-security) | 推荐对象与属性策略；数据源策略是另一条路径。对象策略管实例，属性策略管属性值。外部引用资源需要自己的权限。 | 先建立对象／字段策略；附件、原始来源文件、模型输入不能依赖“隐藏引用字段”保护。 |
| P04 | [Object security policies](https://www.palantir.com/docs/foundry/object-permissioning/object-security-policies) | 策略编辑要求 Owner；属性策略叠加对象策略，主键不能加入属性策略，每个非主键属性最多属于一个属性策略。物化需考虑来源与策略的 mandatory controls。 | 安全元数据独立管理；可见对象的 ID 保持稳定；一个字段明确绑定一条有效属性策略，冲突拒绝。 |
| P05 | [Restricted-view-backed object types](https://www.palantir.com/docs/foundry/object-permissioning/configuring-rv-access-controls) | RV 从数据源行策略约束对象；OSv1／OSv2 的可见性要求不同，Ontology 编辑可能改变对象访问而不改变底层 RV。 | 来源访问、导入后对象访问、历史数据访问要有明确合同，不能把供应商令牌可用等同于对象授权。 |
| P06 | [Multi-datasource objects](https://www.palantir.com/docs/foundry/object-permissioning/multi-datasource-objects) | 当前支持 OSv2 的 column-wise MDO，输入为 dataset／RV；不可见来源对应属性显示为 null；不支持 row-wise MDO 或 streaming MDO。 | “多连接器”不等于 MDO；当前无需复制其物理数据模型。 |
| P07 | [Projects and roles](https://www.palantir.com/docs/foundry/security/projects-and-roles) | 项目是角色授权容器；mandatory controls 仍跨项目约束派生数据。 | 采用轻量资源命名空间承载角色，不把目录或 Git 仓库当作运行时数据策略。 |
| P08 | [Markings](https://www.palantir.com/docs/foundry/security/markings) | 普通 markings 是 AND 限制并沿依赖传播；满足 marking 不代替资源授权；资源 Owner 不自动有移除 marking 的 Expand Access 权限。 | 标签限制资格，grant 授予具体访问；降密／扩大受众另需独立权限。 |
| P09 | [Classification-based access controls](https://www.palantir.com/docs/foundry/security/classification-based-access-controls) | CBAC 可含分级、AND／OR 类别及环境特定规则；文件可发现性与数据分类不同。 | 首期只实现明确的 EIGOS 标签和分类子集，不宣称完整兼容 Foundry CBAC。 |
| P10 | [Access control propagation](https://www.palantir.com/docs/foundry/security/access-control-propagation) | 行列策略约束读取；函数结果、模型上下文、动作写入、API 响应、导出不会自动携带原行列策略。持续保护需要 mandatory controls。 | 设计模型上下文、结果和交付物的受控传播，并明确离开受控系统后的边界。 |
| P11 | [Action permissions](https://www.palantir.com/docs/foundry/action-types/permissions)、[Permission checks for Actions](https://www.palantir.com/docs/foundry/object-edits/permission-checks) | 查看／编辑动作定义与执行动作不同；执行还检查相关对象、数据和 submission criteria，具体规则依数据配置而定。 | 保留业务动作的精确许可、来源授权与副作用限制，不以资源角色替代。 |
| P12 | [Submission criteria](https://www.palantir.com/docs/foundry/action-types/submission-criteria) | 执行条件可组合当前用户、参数和上下文；缺失用户属性不能放行。避免用 NOT membership 形成准入，因为 scoped token 可能省略该属性。 | 策略默认拒绝；安装／任务授权只能缩小权限；成员资格使用正向判断。 |
| P13 | [Read and write authorizations](https://www.palantir.com/docs/foundry/action-types/read-write-authorizations) | Beta 功能：读授权限制可接收／读取的数据上限，写授权规定输出最低安全要求；两者都不授予用户权限。特定配置允许经批准的降密。 | 用于借鉴 Worker 输入上限和输出下限；EIGOS 首期不开放自动降密。 |
| P14 | [Function permissions](https://www.palantir.com/docs/foundry/functions/permissions) | 普通已发布函数的使用权限与其内部按最终用户权限加载对象是不同检查；函数输出不自动继承行列策略。function-backed Action 有专门例外。 | 内部计算必须沿用当前调用者／任务上下文；不让函数以平台超级身份读取后返回。 |

以上是本次阅读的摘义，不是文档全文。P13 的 Beta 状态及平台行为可能变化；实施时应再次核对。

## 2. 对最初整理的补充

1. “对象策略与数据源权限独立”指细粒度对象可见性不必沿用来源的 discretionary ACL；不能推导出可以移除来源 mandatory controls。P04 说明对象策略默认继承来源的 mandatory controls。
2. “Project Owner”是资源权限角色，不是“某个实例数据的所有者”。EIGOS 的 `ownerKey` 是私人数据分区键，不能直接映射成 Foundry Project Owner。
3. 数据源策略的适用场景还包括 Ontology 之外直接访问原始数据，以及需要不同构建／解析策略的 MDO；不应仅理解成 OSv1 的兼容路径。参见 P03。
4. P13 的写授权是校验输出最低安全要求，并不自动给输出加标签；其平台管理的 action log／edit history 还有例外。EIGOS 必须自己覆盖日志、历史和产物，不能从“Action 有权限”推出这些路径已被保护。
5. 跨系统下载后的 CSV、Markdown 或已发送给外部模型的文本无法靠本地策略追回。EIGOS 可以控制发送前准入和受控资源后续访问，不能承诺离线文件持续执行本地策略。

## 3. EIGOS 的采用与不采用

**采用语义：** schema 与实例分离；资源角色、行／属性策略、mandatory labels 叠加；读取与执行分离；访问者上下文贯穿函数；导出、模型和附件单独检查；撤销与策略解释可核验。

**EIGOS 自己定义：** 会员控制者、Agent 安装身份、每任务委托范围、现有 PlanGrant、来源账号绑定、跨进程撤销。Palantir 上述页面没有定义 EIGOS 的 Agent 委托协议，这些设计不能标作官方要求。

**本轮不复制：** Compass 文件系统、Foundry RV／MDO 索引管线、全套 CBAC 分类体系、Marketplace，以及在线 schema 编辑器。现有 TypeScript、SQLite、Gateway／Worker 和 Auth0 接缝足以承载第一版三层权限。

## 4. 建议采用的判定模型

对一个属性值，访问成立需要同时满足：当前主体有效、接口 scope、资源查看权限、对象访问策略、属性访问策略、mandatory controls；Agent 还必须满足安装授权与任务授权。服务端将这些限制取交集。

执行业务动作另外满足：动作可执行、输入／目标范围、submission criteria、来源能力与账号授权、当前 PlanGrant／预算／环境约束。导出或发布还要检查目标接收者与交付渠道。

这是基于 P01–P14 的 EIGOS 设计结论；实际合同、阶段与可证伪验收列在[实施方案](../ontology-permissions-implementation-plan-2026-10-24.md)。
