# Ontology 中台

开发模式下访问 Gateway 的 `/ontology/manager`，使用现有 EIGOS 令牌连接。页面只提供静态壳；私有定义通过与 MCP 共用的认证元数据接口读取。令牌不进入 URL、HTML、浏览器持久存储或导出文件，断开连接后清除页面中的工作区内容。

## 浏览模型与执行合同

- 对象、关系、接口、Action 和 Function 在同一目录中搜索、分页和查看。默认包含内置定义。
- 对象显示属性含义、必填条件、值结构、来源、派生函数和写入方式。结构化字段不冒充独立的具名 Value Type 注册库。
- Action 显示参数 schema、效果、结果类型、提交条件、MCP 参数来源、前置证据及完成判定。`read` 来源操作与订单、付款等效果分别标记；浏览不会执行后端。
- Function 显示发布定义中的输入类型、受信任 handler 引用与版本。v34 的 `executionContract` 区分已校验合同和兼容实现：`rideEstimateStatus`、`selectDidiPlace` 声明完整调用 schema、业务值 schema、读取对象及关系，并在执行时验证；另外 52 个函数明确保留 `legacy` 状态，不把未审查的结果形状猜成 object 或 boolean。`known / unknown` 是结果信封，未知结果必须有原因且不能携带业务值。
- v34 Action 的 `criteriaBindings` 把每个提交条件关联到实际通用保护、声明式条件索引、受审个人上下文保护或精确受信后端。只有词表名称而没有检查绑定的动态动作不能发布。定义存在、实现已登记、当前运行配置就绪及本次调用获准分别展示和验证。
- `requiresApproval` 是兼容的静态效果授权提示，不代表每次都要重新询问用户。已批准的精确范围可以满足它；是否已有适用授权由执行入口重新核验。目录的 `authorization.current` 与 `runtimeReadiness` 明确为 `not_evaluated`，`false` 和定义只读浏览都不赋予执行权。
- “关系与依赖”展示当前定义的直接引用及反向引用，保留引用方向和参数角色。可筛选、翻页和点击节点继续导航。它是定义依赖视图，不是业务实例图或运行轨迹。
- “查询设计”生成精确的 `get_definition` 请求并支持导出。业务实例查询继续使用已有的任务和字段授权入口。

## 版本与变更

浏览版本固定到完整 release 引用（本体 ID、release ID、摘要），翻页与关系导航不会自动采用别的活动版本。开放草稿按 `draftId` 读取；历史版本与已发布草稿只读浏览。历史版本的 Action 不显示当前活动版本的数据操作预览入口。

“变更与发布”保留草稿差异、检查、不可变发布、独立启用和记录。检查仍为现有的结构、依赖与兼容性检查；本页尚未接入 OWL／SHACL 候选报告，不会将缺失的外部报告显示为通过。Function 后端仍由受信任注册库维护，不能通过通用定义写接口上传、修改或退役。

## Agent 与 HTTP 使用同一接口

使用 `query_ontology_definitions`，或向 `/ontology/v1/query` 发送带认证的 POST 请求：

```json
{
  "operation": "list_definitions",
  "ontologyId": "eigos.business",
  "kind": "function",
  "limit": 10,
  "offset": 0
}
```

先取得并固定对应的 `release`，再传到后续读取。可用的新增读取：

| operation | 用途 |
| --- | --- |
| `workspace_summary` | 指定版本的定义数量、字段和来源绑定统计 |
| `list_definitions` / `get_definition` | 五种只读目录；Function 的资源 ID 为 `function:<id>` |
| `list_definition_relations` | 指定 `kind` 和 `resourceId` 的直接依赖，支持 `search`、`limit`、`offset` |

所有读取检查 `ontology:read` 与本体归属；`draftId` 和 `release` 不能同时使用。分页返回 `total` 与 `page.hasMore`，没有将截断结果当作完整模型。读取不会赋予写入、供应商、Function 调用或任务执行权限。

## 当前运行边界

此中台扩展现有开发模式管理入口。Foundation 模式继续拒绝上述通用元数据读取与界面，不扩大其已审查接口。部署到正式权限环境前，需要沿正式运维管理接口完成单独审查和接线；本中台不建立第二份正式本体库，也不切换正式运行权威。
