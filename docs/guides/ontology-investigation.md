# 本体业务说明与调查验证

对象说明应交代它代表的业务概念、适用范围、可沿哪些关系核实，以及哪些事实仍需独立证据。名称和类型存在本身不证明来源、库存、权限或履约已经接通。

## 发布和历史解释

v28 在同一共享本体发布中为原先只以名称作说明的 68 个业务可见类型提供 `businessDescription`。内容集中在 `packages/ontology/business-descriptions.ts`，与已有领域术语共同维护。`describe_ontology` 使用它作为对象的 `description`，并将内容纳入搜索；管理定义保留该发布的原始字段。

原 `description` 继续作为历史写入合同的一部分。`businessDescription` 只改变发现说明，不能改变数据校验、字段权限、接口、动作或关系。存储对象指纹保留原合同；模型及发布摘要同时固定当前说明与底层合同，防止说明遮蔽不同的事实定义。旧发布与旧任务继续呈现当时的说明。

新数据库采用 v28；现有库不会在启动时激活新版本。精确 v27 库可在已授权的维护窗口停止 Gateway／Worker、保存一致性备份后，构建并预览：

```sh
node scripts/install-business-descriptions.mjs --database /absolute/private/tasks.sqlite
```

实际应用须额外传入预览返回的 `--expected-digest`、`--expected-generation` 和 `--apply`。Foundation 还需准确的 `--expected-policy-digest`、`--expected-policy-revision`；正式库使用已有 `EIGOS_AUTHORITY_FILE`。策略升级与说明激活在同一业务事务内提交，保留同意期限、来源许可和字段标签；不发放新权限或调用供应商。其他前身或自定义发布需要另行核对兼容路径，脚本不自动跳过。

## 独立 Agent 调查

可复用的滴滴估价与酒店搜索题库通过现有连接器夹具和业务投影生成隔离、冻结的合成来源数据。它覆盖当前估价、后续观察取代、过期、同名不同酒店、缺少价格和酒店资料版本变化。题目不提供对象类型、关系路径或答案；通用接口只提供委托起点和本体工具。

```sh
node --import tsx examples/read-service-drill.ts /absolute/private/drill-run
```

每次运行使用新目录。独立参与者只读取该目录的 `access.json` 并通过本地 HTTP 使用 `/interface`、`/cases/:id/tools` 和 `/cases/:id/answer`。参与者不得读取实现、夹具、维护者测试、预期答案或其他参与者记录；维护者不得在提交首份答案前提供解题路线。真实执行时可用独立 Agent 会话承担参与者。

每题保存首次答案、实际查询与错误、证据、帮助需求及局限；记录从首次工具请求到提交答案的耗时，模型调度和排队另计。维护者随后按冻结数据核验事实正确性、来源和时效、身份边界、未知项及是否错误宣称已叫车／预订。可发现性或表达缺口修正后，以未获知上一轮答案的新参与者和变化后的样本复测，保留原失败记录。

关系较多时，`describe_ontology.linkSearch` 可按已返回关系的名称、目标 API ID 或说明筛选；结果标明 `linksFiltered`，不能据此断言未返回的关系不存在。过滤发生在元数据鉴权之后，不拓宽可见关系。

批量 `facts` 的自动评估只覆盖 `ObservedFact` 实现。其他类型保留已读内容，并列入 `needsEvaluation`，使用该类型已登记的函数另行核验；它不会中断其他事实或要求访问供应商。每条评估附准确对象引用。集合的 `refresh_required` 表示至少一项需重查，各项结果仍分别保留。直接函数评估的外层 `known` 只表示计算有结果，业务结论需读取 `value`；技术观察快照有效也不能替代当前事实是否已被新观察取代的检查。

这些演练检验独立调查路径，不能证明真实供应商调用、真实 PA 入口、付款或履约完成。Foundation 权限回归和实际来源接入分别验证。真人可使用同一问题和通用工具进行对照；Agent 演练不替代真人可用性测试。实际运行记录和研究报告保存在仓库外，本仓库只维护可复用夹具、工具和指南。
