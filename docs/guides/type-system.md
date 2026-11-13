# Ontology 类型定义与资源包

发布定义保留原始 JSON 和摘要。`Ontology.document` 用于保存、审阅和发布身份。`resourceDocument` 展开具备准确摘要的共享定义导入，`resolvedDocument` 展开属性类型和 Interface 继承。运行层的对象、Interface、Action、Function 和来源映射使用编译后的契约。

## 可复用属性和值类型

`sharedProperties` 定义具名属性，包含 `apiName`、`description`、`schema`，以及可选的 `valueType`、`struct`、格式和显示元数据。对象或 Interface 的属性通过 `sharedProperty` 引用定义，仍使用自己的属性名和 `required`。

```json
{
  "valueTypes": [{"apiName":"Email","version":"1","description":"Email address","schema":{"type":"string","format":"email"}}],
  "sharedProperties": [{"apiName":"ContactEmail","description":"Contact email","valueType":{"name":"Email","version":"1"}}]
}
```

属性声明可使用 `{"sharedProperty":"ContactEmail","required":true}`。Value Type 必须固定名称与版本。属性、Action 参数、Function 参数与返回值的 JSON Schema 均可嵌入 `"valueType":{"name":"Email","version":"1"}`。来源映射写入同一对象契约，因此也执行这些约束。Value Type 与局部约束取交集。引用不存在、版本重复、递归引用和不兼容基本类型会在发布前失败。

## Struct 与元数据

`structTypes` 定义标量 `fields`、必填字段 `required` 和可选 `mainField`。属性通过 `struct.type` 引用。`struct.array` 为 true 时可配置 `reducer`，操作为 `first`、`last`、`min`、`max`，后两者还需要比较字段 `field`。`propertyDisplay` 先选择 Struct 值，再读取主字段和应用格式。原始属性仍保留完整结构。

`format.kind` 支持 `number`、`date`、`currency`、`percent` 和 `text`，可指定 locale、currency 和小数位。对象及相关定义支持 `typeClasses`、`renderHints` 和 `status`。状态为 `experimental`、`active` 或 `deprecated`。`typeGroups` 提供具名对象分组，对象可通过 `groups` 关联分组。所有分组引用都会校验。

## Interface 继承与 Action 契约

Interface 使用 `extends` 指定父接口名称数组。多重继承支持共享祖先的菱形结构，循环、同名成员约束冲突和可选性冲突会被拒绝。对象实现子接口后，通过同一映射获得祖先接口的查询与操作能力。显式祖先映射必须与继承映射一致。

对象属性必须满足 Interface 属性约束。具体 Action 必须接受 Interface 所允许的参数输入，不能增加未映射的必填参数、将可选输入收紧为必填输入，或缩小允许的值域。复杂 JSON Schema 约束无法证明兼容时，发布会明确失败。参数映射和运行时输入校验继续生效。

新发布检查组合条件的同级约束、`oneOf` 的互斥性、额外属性以及数值的开闭区间。已有发布快照保留早期运行时接受的基本类型契约与原始摘要，保证升级后仍可读取历史对象；新候选始终执行当前完整校验，旧 Function 实现不能借此在新运行版本中执行。

派生属性在 `derived` 中声明查询时计算表达式。它们不存入对象，无法成为主键、标题或必填存储字段，写入时会被拒绝。表达式支持属性、字面量、算术及 Link 路径聚合，计算入口由查询服务提供。

## 打包、共享导入与定义迁移

`OntologyPackages.export` 接收 `{ontology,resources}`。每个资源用 `{kind,name,version?}` 定位，Value Type 要提供版本。导出会补全类型、属性、Interface、Link、Action、Function 等依赖，并逐个检查读取定义的权限。返回包包含 `format`、来源 Ontology、版本、摘要和定义快照。

代码实现的 Function 通过 `dependencies` 声明它使用的 `objectTypes`、`interfaceTypes`、`linkTypes`、`functions`、`dataSources` 和 `actions` 名称数组。纯计算函数可以声明空对象 `{}`。发布前会验证每个声明的资源，导出会沿这些声明递归补全依赖，命名空间导入同步重映射声明。旧 Function 定义可以继续加载，但缺少依赖声明时，导出会明确要求补充声明。Value Type 的定义权限按名称与版本检查，例如 `Eigos/valueType/Email@1`。

`OntologyPackages.import` 接收目标 Ontology、命名空间、资源包和分支名。默认 `mode: shared` 保存摘要和版本固定的共享快照导入，`mode: copy` 复制为本地具名定义。命名空间作为资源名称前缀，属性名称保持原有业务含义。导入创建可审阅的 Governance 分支，随后使用现有 prepare、review、merge 流程发布。

`OntologyPackages.migrate` 从一个已发布的 Ontology 导出所选依赖闭包，通过显式 `mapping` 将各资源映射到另一个 Ontology 的名称，并创建目标提案。映射必须覆盖每个依赖，未知源名称、重名、摘要错误和未授权依赖均被拒绝。

资源包携带定义。Function 实现和外部来源连接仍由目标运行环境注册，发布时检查实现绑定。跨 Ontology 定义迁移通过目标提案完成，实例数据迁移仍需明确的数据转换与授权。
