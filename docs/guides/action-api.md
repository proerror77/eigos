# Action 校验、批量提交与日志

这些操作通过现有 Ontology Services 提供。HTTP 客户端调用 POST `/ontology/services/<operation>`，MCP 工具名加前缀 `ontology_`。TypeScript 的 `OntologyClient` 提供对应方法。

| 服务 | SDK 方法 | 行为 |
| --- | --- | --- |
| `validate_action` | `validateAction` | 用当前发布版和指定 Scenario 检查参数、对象访问与提交条件。成功返回 `valid: true` 和 `phase: "submission"`。正式提交仍会检查权限、版本、规则和依赖的数据。 |
| `apply_action_batch` | `applyActionBatch` | 每批 1 至 20 条，按输入顺序执行当前发布版的声明式 Action。每条使用独立且可重试的 `requestId`，失败时回滚本批中新提交的对象、关系和收据。带编辑 Function、声明副作用或 Scenario 合并的 Action 走普通提交。 |
| `list_action_log` | `listActionLog` | 按提交时间倒序分页，支持按 Action 名称和发布版过滤。默认读当前发布版，可明确指定该 Ontology 的历史发布版。每条包含已提交 Action 的名称、请求 ID、时间和执行者类型。当前身份只能看到自己拥有且有定义访问权的提交。 |

校验只运行只读的提交条件，执行过程没有对象写入、供应商调用、Action 收据或副作用。正式提交的并发规则见 [执行与数据访问](../architecture/ontology.md#执行与数据访问)：同一 owner 编辑不同对象的提交按对象加锁、并行进行，含集合查询等无法按对象界定冲突的提交改用排他锁重跑一次，同一对象的并发修改返回修订冲突。Scenario 编辑以独立的 Scenario 请求保存，日志收录正式提交的 Action。日志可关联现有 `execution_trace` 服务读取授权范围内的执行证据。

实现沿用同一套 Action 执行与幂等收据。接口设计参考 [Foundry Validate Action](https://www.palantir.com/docs/foundry/api/ontology-resources/actions/validate-action)、[Apply Action Batch](https://www.palantir.com/docs/foundry/api/ontologies-v2-resources/actions/apply-action-batch) 和 [Action Log](https://www.palantir.com/docs/foundry/action-types/action-log)。

## 按执行上下文区分的提交条件

提交条件可以声明 `executionContext: 'scenario' | 'live'`，这一条只在对应的上下文中检查；不声明时两种上下文都检查。这与 Palantir 提交条件里的 [Execution context](https://www.palantir.com/docs/foundry/action-types/submission-criteria/) 条件相同。

```json
{ "function": "RequestIsOpen", "arguments": { "request": { "parameter": "request" } },
  "executionContext": "live", "message": "The request must be open" }
```

- **在 Scenario 中：** 跳过 `live` 条件，所以可以用更宽松的条件试运行 Action。
- **在正式数据上：** 跳过 `scenario` 条件。
- **合并：** `applyScenario` 在 Scenario 视图里重放 Scenario 中的 Action，但这些编辑落在正式数据上，所以每一步都按 `live` 重新检查。在 Scenario 中因放宽而通过的一步，合并时仍要满足 live 条件。

## 生成 TypeScript 类型

从目标环境读取经过当前身份过滤的发布定义，例如用 `OntologyClient.describe()`，将 JSON 写入本地文件，再生成类型。

```sh
node --import tsx scripts/generate-ontology-sdk.ts published-definition.json > ontology-bindings.ts
```

在应用中将生成的 `Bindings` 用于现有客户端。

```ts
import type { Bindings } from './ontology-bindings.js'
import { OntologyClient } from './packages/sdk/client.js'
import { TypedOntologyClient } from './packages/sdk/typed-client.js'

const client = new TypedOntologyClient<Bindings>(new OntologyClient({ baseUrl, token }))
const result = await client.query({ type: 'Place', limit: 10 })
```

生成类型提供对象属性、Action 参数以及读取 Function 的输入和返回值。服务端始终校验发布契约和权限。发布结构变更时，用目标环境的新定义重新生成类型。
