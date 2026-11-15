# Agent 回归评估

用真实模型执行代表性的自然语言 PA 请求，记录实际选中的 Action 和参数，并从隔离 PostgreSQL 读回对象、Link、Scenario 和外部操作记录。评估比较工具行为与本体差量，参考 Palantir 的 [Ontology edits 评估方法](https://www.palantir.com/docs/foundry/aip-evals/ontology-edits)。

## 运行

配置 Worker 使用的私有登录文件和已安装的 Harness，再显式运行评估。

```sh
export EIGOS_HARNESS_BIN=/absolute/path/to/dsh
export EIGOS_HARNESS_CREDENTIAL_FILE=/absolute/path/to/private-model-login.json
export EIGOS_HARNESS_MODEL=gpt-6.1-sol
npm run --silent eval:agent
npm run --silent eval:agent -- --case=pa-scenario-review
```

可通过 `EIGOS_HARNESS_REASONING_EFFORT` 选择推理强度，默认为 `low`。命令使用现有测试设施创建短生命周期的 PostgreSQL 17 容器，也支持已有的本地合成测试数据库。每例发布业务本体到独立 schema。只有模型推理使用已配置的上游模型，地点、报价和 PA 日历均使用合成数据。报告输出模型、发布摘要、用例状态和每条断言，任一断言失败时退出码为 1。可保留两次运行的 JSON 报告以对比模型或发布版本。

## 用例

| 用例 | 可核对结果 |
| --- | --- |
| `didi-ambiguous-place` | 按用户给的两个地点调用现有询价 Action，同名候选来自实际返回的来源对象。原任务等待用户选择，报价调用和正式询价编辑数量均为零。 |
| `didi-quote-retry` | 写入一次询价 Action 及其路线、地点、报价和回执 Links。原请求重试返回原任务，总计只发出一次报价请求。 |
| `pa-stale-calendar` | 授权 PA 向原任务回传已过期的忙闲快照，任务停止，正式活动、计划及关联编辑数量均为零。 |
| `pa-scenario-review` | 模型提交符合时段与时长的方案差量，保留活动和资源 Links 等待审阅。让日历在审阅后过期，再尝试提交，方案仍开放，正式日历活动保持为空。 |

所有用例还检查外部操作与投递队列。常规 CI suite 6 使用可复现的模型决策夹具，通过真实 MCP 测试同一套评分器，并包含任务状态看似完成但缺少实际 Action 的失败用例。需要验证真实模型决策时，运行上述显式命令。
