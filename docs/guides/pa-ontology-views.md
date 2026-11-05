# 面向 Personal Agent 的本体分类与发现

PA 的目录围绕服务对象、目标约束、可用能力、方案依赖、授权、结果和核验依据组织。分类是定义的呈现元数据，字段授权、来源资格和业务执行权限仍由原路径检查。目录声明不证明本次有货、可预订、接受某种钱包或已经履约。

## 分类合同

对象类型可带以下可选元数据，通过既有定义管理接口与定义一起编辑、发布和激活：

```json
{
  "classification": {
    "version": "1",
    "purpose": "domain_detail",
    "domains": ["hotel"]
  }
}
```

`purpose` 取值为 `pa_core`、`domain_task`、`domain_detail`、`evidence`、`runtime_adapter`、`network_optional`、`integration_test`。`domains` 为去重的领域 ID，最多 12 项；它描述信息的用途范围，不表示供应商地域或接入覆盖。

v30 软件合同为现有 204 个类型固定分类：核心 30、领域任务 56、领域细节 19、证据 32、运行适配 42、可选网络 8、测试适配 17。七类是用途分组，不是新的业务继承树；也不增加 PA 的必填输入。跨来源身份、历史版本和证据关系仍保留原合同。

目前使用的领域包括 `hotel`、`ride`、`vehicle`、`dining`、`food`、`shopping`、`delivery`、`appointment`、`travel`、`events`、`documents`、`location`、`network`。组合旅行可明确选择多个领域；自由文本不会自动变成已确认的领域或业务事实。

## 发现方式

Gateway HTTP、Gateway MCP 和 Worker 的任务专属 MCP 共用相同选择项：

```json
{"view":"pa","domains":["hotel"],"limit":5}
```

在带分类的发布中，无搜索的默认类型目录采用 PA 视图：返回核心及明确相关的领域对象和共用接口，不默认展开来源包装、执行账本或测试类型。任务专属会话优先从获准的绑定引用推导领域；仅当已固定程序的动作输入／结果类型指向单一领域时，才把它用作补充提示。通用程序的多领域能力菜单不当作当前任务选择；Foundation 公开读取也可从当前数据授权的输入类型推导。没有可靠类型提示时保留核心目录，调用方可显式提供 `domains`。

关系列表也按所选类型范围裁剪，被裁剪时返回 `linksFiltered`。它不表示其他关系不存在，具体证据仍能通过获准的对象／关系查询和明确目录读取访问。

- `{"view":"all","limit":5}`：分页枚举完整的获准类型，包括内部实现类型；不会扩大读取权限。`all` 不与 `domains` 或 `purposes` 混用。
- `{"search":"RollingGoSearchTask","limit":1}`：明确搜索支持合同。未显式选择视图时，搜索保留原有范围；指定 `view:"pa"` 时搜索仍受 PA 范围约束。
- `{"view":"pa","purposes":["evidence"],"domains":["hotel"]}`：展开酒店及通用核验依据。只有 `purposes` 而无 `domains` 时，按用途查看全部获准类型。
- `after`、`limit` 沿用既有分页合同。`kind:"actions"`／`"functions"` 保留明确枚举入口，不因 PA 类型视图移除必需动作或函数。

返回的 `discovery` 标明视图、领域和过滤范围，`availabilityProof` 固定为 false。未返回内容不能被解释为服务不存在。分类、筛选、后续搜索、分页和数量均在授权范围内处理；隐藏类型的分类或领域不能影响可见结果。

尚未分类的自定义类型继续可被发现，其缺失分类不构成语义断言。元数据用于展示和定位，不提供访问授权。原始 schema、具名输入输出、来源时效和当前字段政策继续决定实际读取与执行。

## 酒店任务的边界

PA 使用酒店作为服务地点引用，按任务查询人数与床型、房价套餐、早餐、儿童条件、取消与付款条款、当次价格和库存。当前不要求建立建筑构件、资产折旧或内部部门层次。无障碍、资格及其他明确影响用户目标的条件仍需保存和核验。

商家与履约方的准确引用用于确认、取消、退款和责任归属；参考价、库存观察、已占房、已确认和已付款分别解释。公共本体用于校准语义，当前用途分类不表示正式 BFO／FIBO 公理对齐。

## 版本和发布

`createPaClassificationKernelDefinition` 构造独立的 v30 候选；`StagedKernelBuilder('30')` 为 PostgreSQL 路径重建相同受信合同。当前默认 v28 和可选语义检索 v29 的构造、指纹与职责保持原样。安装本次代码不会替换已有数据库的 active release。

元数据通过现有管理流程进入共享注册库：读取准确基线，创建草稿，为原类型添加 `classification`，检查完整差异和校验结果，再分别发布与激活。共享默认本体仍要求现有管理员权限；自有命名空间仍按 owner 鉴权。发布版本名称可能为 `release-N`，运行时固定准确 `releaseId / digest`，不依赖显示版本名猜测合同。

v28 的完整合同仅增加分类时，字段政策通过重建并核对准确原合同复用；对象、关系、动作、函数或字段的任何变动都不能借此获得旧政策兼容。对象写入指纹不包含用途标签，分类仍进入新模型与发布摘要。旧任务和已有事实继续按原发布及证据解释；本次不删除类型、不重写历史或自动开启来源。

使用 v29 的语义检索实例应保持其准确发布；本 v30 分类候选基于 v28，不隐式合并或替换检索版本。任何组合版本仍应单独审查、发布与验证。

### 正式 SQLite 操作员激活

正式入口须在 authority 的 `ontologyOperators` 中固定操作员的 issuer、client、subject 与 tenant，并保持原会员、连接和 native 安装有效。操作员只在 `/ontology/v1/pa-classification/query`、`/ontology/v1/pa-classification/commands` 获得 `ontology_operator` 元数据身份；它不依赖业务数据 grant，也不能读取任务、业务对象或供应商来源。签名 scopes、当前资格发布器、安装撤权与原 namespace 管理检查继续生效。CLI `status` 查询共享本体管理状态，不再要求业务 `/security/context`；分类 `query`／`command` 使用 `--pa-classification`。原通用元数据和 Pipeline 端点继续使用原业务授权路径。

该窄接口只管理 `eigos.business` 的 PA 分类：创建自己的草稿，逐个提交下列小请求，分页审查 diff 并校验，再发布和按原 generation 激活：

```json
{"operation":"put_pa_classification","ontologyId":"eigos.business","draftId":"ACTUAL_DRAFT_UUID","expectedRevision":1,"objectType":"HotelProperty"}
```

标签从已审查的 204 类映射中取得，调用方不能提供属性正文、替换标签或改变动作。发布和激活都会重新检查全部标签及去除标签后的完整合同；不完整或混入其他变化的发布会被拒绝。原有请求大小上限保持不变。此操作员 adapter 当前接入正式 SQLite runtime；尚未装配对应 adapter 的 PostgreSQL runtime 明确拒绝，不退回业务身份或绕过检查。
