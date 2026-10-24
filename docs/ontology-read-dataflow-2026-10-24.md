# 模型选择的只读依赖图与条件验收

2026-10-24。运行契约 `ontology-execution-v20`，业务模型 `eigos.business@17`，滴滴读取模块 `didi.ride-estimate@2`。

## 目的与分工

LLM 选择动作、顺序、依赖、参数与可选的未来证据验收合同；Worker 在真实来源返回后执行已选的数据绑定和纯函数，并保持来源、权限、租约、取消与硬要求检查。`requires` 仍是证据前提，不会自动插入或调度上游动作。连接器仍只调用一次选定的供应商业务操作。

本轮首先在滴滴只读模块声明可选能力。没有启用真实叫车、订单、取消或付款，也没有把其它业务程序迁移为自动完成。

## 延后参数绑定

`AgentStep.inputRefs` 原有 `{stepId,targetKey}` 继续绑定前一步已接受的 `ObjectRef`。新增可选 `compute={function,path}`，从注册纯函数的结果值中取得一个字段：

```json
{
  "id": "estimate",
  "action": "EstimateDidiRide",
  "argumentsJson": "{\"scope\":{\"type\":\"RideEstimateTask\",\"id\":\"actual-task-scope\"}}",
  "dependsOn": ["origin", "destination"],
  "inputRefs": [
    {"stepId":"origin","targetKey":"originObservation"},
    {"stepId":"origin","targetKey":"originPlaceId","compute":{"function":"selectDidiPlace","path":["placeId"]}},
    {"stepId":"destination","targetKey":"destinationObservation"},
    {"stepId":"destination","targetKey":"destinationPlaceId","compute":{"function":"selectDidiPlace","path":["placeId"]}}
  ]
}
```

这是参数合同示例，scope 需要替换为真实任务引用。模型必须自行选择并列出所引用的搜索步骤；只选择 estimate 不会让宿主补上搜索。延后绑定的键从 `argumentsJson` 中省略，不能同时提供字面值；依赖必须先于使用者，字段路径不可包含原型链键。

目标动作在独立 Ontology 文件的依赖中声明 `derive`。宿主要求模型选择的函数和路径完全匹配声明，且选择 ID 与观察引用来自同一个上游步骤；函数输入类型必须兼容。只有只读动作支持这些绑定，写入继续要求实际已读事实与精确授权。

`selectDidiPlace` 是业务纯函数，不调用供应商、不调度动作：它验证来源、任务版本、城市和新鲜度，只对唯一精确名称或原请求中明确的唯一完整地址返回 `placeId`。多个同名地址、空结果、错误城市、单个非匹配地点和过期来源保持 unknown。unknown 会阻止消费步骤派发，并将实际观察与反馈交回模型；不会选择列表首项。

其它人工／模型地点选择仍走原有来源验证。新的纯函数是可选的选择规则，不能从「唯一候选」推导出缺失的用户授权。

## 首轮可选依赖图

`Grounding.initialSteps` 可以包含可选 `dependsOn` 和 `inputRefs`。模型解释用户目标时，可以同时选择一个有界只读图，或只选部分步骤再分轮决定。当前每图最多 4 步、每步最多 8 个输入引用。

scope 尚未创建时，每个草案继续通过 `scopeInputs` 明确列出要绑定程序 scope 的输入键，并从 `argumentsJson` 中省略这些键。宿主先验证解释，再纯初始化 scope、实际读取它，随后只绑定模型明确指定的槽。保存原始解释、模型回执、模型前的读取、初始化后的绑定读取和精确图摘要。没有提前生成来源 ID，也没有把后来的来源写成模型已知信息。

## 可选的条件验收

模块显式声明 `completion.planned=true` 时，模型可以在 execute 决策（包括首轮解释）中选择：

```json
{
  "plannedCompletion": {
    "argumentsJson": "{\"rationale\":\"按独立检查通过的来源返回所请求估价\"}",
    "inputRefs": [{"stepId":"estimate","targetKey":"observation"}]
  }
}
```

该字段选择一个未来证据绑定，不是完成主张。只有整张已选只读图全部取得确认结果，宿主才绑定实际输出，重新读取对象并执行模块状态函数，然后调用原有 `program.complete`，检查来源、请求模式、硬要求和结果条件。任何失败会留下反馈并回到模型决策。用户仍可选择普通的显式模型 complete；需要开放判断的任务继续分轮处理。

最终记录的 `agent.completion.mode=planned` 明确区分这种方式，`modelDecision.kind` 仍为原 execute，`modelRunId` 指向原模型选择；不会伪造一个观察过结果的模型回复。模型显式完成的记录保持原合同。

## 证据、恢复与权限

- `inputResolutions` 保存消费步骤的实际输入摘要和来源返回后的读取快照。每条读取使用 `origin=worker_context`，绑定当时的 owner、request revision、对象／关系摘要与函数定义版本。
- 模型前的上下文、实际模型回复、后来的 Worker 读取分别统计。纯函数计算不算模型调用；复用一个会话中的多次真实回复仍分别计算。
- 已固定计划仍校验模型决策摘要、定义摘要、业务绑定和 scope。写入许可没有扩大，旧版本任务不会自动迁移。
- 图和意图在派发前持久化；恢复时继续原图。已确认读取不重放；缺失／未知来源不会被插入替代动作。取消、租约丢失和请求改版阻止迟到结果生效。
- Gateway 不启动模型或执行业务；MCP 与 A2A 保持同一任务与同一验收结果。

新版本与旧 Worker 不得共享一个数据库混跑。升级常驻实例仍按既有备份和停机安装流程进行；本轮真实性能验证使用隔离实例。

## 验证与性能口径

回归覆盖模型一次选图、保留分轮选择、仅地点搜索、不同端点顺序、非首项精确来源、歧义／错误城市／缺失来源、非法函数与字段、来源混用、取消、持久图交接、硬要求与提前完成拒绝，以及 MCP／A2A 一致性。

真实验证必须使用真实模型与滴滴来源；合成测试不能证明延迟改善。比较相同自然语言目标，保留模型配置、每次真实回复、线程、token、调用方时间、服务端受理至验收时间及每次供应商往返。轮询间断可能延迟调用方观察，需与服务端完成时点分开。独立观察器按验收时点回放来源检查，并比较 A2A、MCP 和持久账本，不发起新业务请求。

本机原始来源、目标与完整回执保留在私密验证目录，仓库只归档去除地址与来源原文后的计数、时间和检查结论。结果见[真实对照验证记录](evidence/ontology-read-dataflow-2026-10-24/README.md)。

设计依据与 40 页官方文档阅读地图见 [Palantir Ontology 研究](research/palantir-ontology-execution-architecture-2026-10-24.md)。
