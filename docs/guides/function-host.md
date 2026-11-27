# 函数宿主（F1）

这是 [Functions 实施方案](../architecture/plans/functions.md#f1函数运行时) F1 的第一部分：运行用户函数的宿主服务。函数由作者编译成 WebAssembly 组件，宿主在 wasmtime 中执行，每次调用都在调用方给出的上限内运行。

- `function-host/` 是 Rust 服务，基于 wasmtime 50 的组件模型。
- `packages/runtime/function-host.ts` 是客户端。
- `packages/runtime/component-functions.ts` 把宿主接入运行时，内容见下文的“组件函数”。

## 构建与测试

```bash
cargo build --release --manifest-path function-host/Cargo.toml
function-host/fixtures/build.sh /tmp/eigos-function-fixtures    # 需要 rustup target add wasm32-wasip2
EIGOS_FUNCTION_HOST_BIN=$PWD/function-host/target/release/eigos-function-host \
EIGOS_FUNCTION_HOST_FIXTURES=/tmp/eigos-function-fixtures npm test -- --suite=49
```

- **测试组件：** `function-host/fixtures/` 有三个 Rust 组件：
  - `echo-rust` 按输入回显、空转、分配内存、写长输出、写 stderr、返回失败或 panic；
  - `net-rust` 导入 `wasi:sockets`，`wrong-rust` 导出类型不对的 `invoke`，两者都应被拒绝。
- **测试套件：** `tests/49-function-host.test.ts` 覆盖：
  - 组件检查；
  - 每种上限和错误；
  - 重启后从磁盘恢复，以及淘汰后重新载入。

  没有上面两个环境变量时跳过。
- **CI：** 套件 49 的 job 先构建宿主和测试组件，再运行这个套件。
- **发布：** `Function host release` 工作流手动触发，输入一个 CI 已经通过的 main 提交。它在 ubuntu-24.04（x86_64，glibc 2.39，与生产主机相同）上编译。之后检查服务能启动、只监听 loopback，并能上传和调用一个测试组件。最后以 `function-host-<提交号前 12 位>` 发布二进制和它的 SHA-256。已有的发布不会被替换。

## 组件函数

作者自己把函数编译成组件。上传后，定义分支用组件的 SHA-256 引用它，审阅并发布之后，调用方像调用其他 Function 一样调用它。依据是 Palantir 的 Functions：代码“在服务端的隔离环境中执行”；发布者选择的版本“发布后不可变”（[overview](https://www.palantir.com/docs/foundry/functions/overview/)、[versioning](https://www.palantir.com/docs/foundry/functions/functions-versioning/)）。

1. **上传：**

   ```bash
   curl -X POST "$EIGOS/ontology/function-artifacts?ontology=Eigos" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/wasm' --data-binary @echo.wasm
   # {"sha256":"…","size":107276,"world":"eigos:function/handler@0.2.0","imports":[…]}
   ```

   - 需要 `ontology:write` scope 和该本体的 `edit_definition`。
   - 宿主先检查组件（导入和导出见下文“组件”），通过后才存入 `function_artifacts` 表。表按 SHA-256 去重，组件最大 16 MB。
2. **定义：**

   ```json
   {
     "apiName": "EchoPayload", "description": "Echo a payload through a component", "version": "1.0.0",
     "parameters": { "type": "object" }, "returns": { "type": "object", "required": ["echo"] },
     "implementation": {
       "kind": "component", "sha256": "…",
       "limits": { "fuel": 100000000, "memoryMb": 64, "deadlineMs": 2000 }
     }
   }
   ```

   - `limits` 的每一项都不能超过宿主的上限（下文“调用的上限”），schema 直接拒绝超出的值。
   - 组件函数必须有语义化版本 `x.y.z`。
   - 组件函数可声明 `edits` 供 Action 执行，或声明 `source` 读取外部源，见下文。
3. **准备发布：** 准备发布时，运行时依次检查：
   - 配置了函数宿主；
   - 宿主的上限不低于函数要求的上限；
   - 每个组件都已上传。宿主没有的组件，运行时从表中取出交给它，宿主再检查一次。
   - 版本规则，见下文“版本”。

   绑定由定义本身算出，包括契约、版本、组件摘要和上限，所以所有配置了宿主的运行时得到同一个绑定。
4. **调用：** `Functions.invoke` 依次执行：
   1. 照常检查 `execute_function`；
   2. 按契约校验参数；
   3. 把参数的 JSON 交给宿主。宿主没有这个组件（例如重启后），运行时从表中取出组件交给它，然后重试一次；
   4. 按契约校验返回值。

   Action 的提交条件、Agent 的 `evaluate_function` 和 HTTP、MCP 的调用都走这条路径。组件函数只读输入，所以离线的 Scenario 评估也可以使用它。

### 版本

依据 Palantir 的 [function versioning](https://www.palantir.com/docs/foundry/functions/functions-versioning/)：版本由发布者选择，发布后不可变；向后不兼容的变更要升主版本。准备发布时，运行时对组件函数检查三件事：

1. **不可变：** 同名同版本的定义必须与历史发布中的完全一致，否则要发布新版本。
2. **递增：** 没有发布过的新版本，必须高于当前活动发布中的版本。已经发布过的版本可以原样再次发布，例如回滚。
3. **破坏性变更：** 与活动发布中的版本相比，下列变更要求升主版本。1.0.0 之前升次版本即可：
   - 删除输入、改变输入的 schema、把输入改为必需、新增必需输入，或者不再接受其他输入（`additionalProperties: false`）；
   - 删除输出、改变输出的 schema，或者原来必有的输出变为可能缺失；
   - 返回值不是对象时，改变它的 schema。

   比较时忽略 `description`、`title` 等注释。新增可选输入、新增输出属于兼容变更。

   例如 `EchoPayload 1.2.0 is not backward compatible with 1.1.0 (input label became required): release it as 2.0.0 or later`。Palantir 提醒这类检查不可能穷尽：它能找出破坏性变更，但通过检查不等于一定兼容，所以作者仍要判断。

消费方接受的版本范围见 [Action 指南](action-api.md#函数的版本范围)。

### 错误

| 情况 | 错误 | HTTP |
| --- | --- | --- |
| 函数返回 `failure` | `FunctionFailed`，`code` 是函数给的代码，消息是函数给的消息 | 422 |
| trap，例如 panic | `FunctionFailed`，`code: 'trap'` | 422 |
| 输出不是 JSON，或不符合返回值的契约 | `FunctionFailed`，`code: 'contract'` | 422 |
| fuel、内存、截止时间或输出大小超限 | `ResourceExhausted`，`limit` 是 `fuel`、`memory`、`deadline` 或 `output` | 422 |
| 参数不符合契约 | 校验错误 | 400 |
| 没有配置宿主，或宿主不可用 | `ServiceUnavailable` | 503 |

依据：Palantir 区分三类错误，即给用户看的错误、运行时错误，以及 CPU 时间、墙钟时间和内存超限（[user-facing errors](https://www.palantir.com/docs/foundry/functions/user-facing-error/)、[error types](https://www.palantir.com/docs/foundry/functions/typescript-error-types/)）。前两类对应 `failure` 和 `trap`，超限对应 `ResourceExhausted`。

错误对象上的 `detail` 带有 `fuelUsed`、`ms` 和 stderr 的末尾，只供服务端诊断，不出现在公开的错误消息里。

### 运行时的配置

| 变量 | 说明 |
| --- | --- |
| `EIGOS_FUNCTION_HOST_URL` | 已在运行的宿主服务，生产使用 |
| `EIGOS_FUNCTION_HOST_BIN` | 没有 URL 时，进程第一次用到宿主时启动这个二进制。连不上时，下一次调用再启动一个新的 |

两者都没有时，组件函数不能发布，已发布的组件函数调用时返回 503。Gateway、Worker 和 Indexer 都要配置，因为 Indexer 运行的自动化和 Scenario 同步也会求值提交条件。

部署包含这个功能的版本时，激活步骤要建好 `function_artifacts` 表并授权：
- Gateway 的角色要有 SELECT 和 INSERT，Worker 和 Indexer 的角色要有 SELECT；
- 这张表不分 owner，与 `releases` 相同。

## 模板

作者自己构建组件，EIGOS 不在服务器上编译源码。仓库提供两个模板，都实现同一个示例函数：对 `values` 求和，空输入时返回 `failure`。

| 模板 | 构建 | 组件大小 | 上传时预编译 | 每次调用 |
| --- | --- | --- | --- | --- |
| [Rust](../../templates/function-rust/README.md) | `cargo build --release --target wasm32-wasip2` | 约 90 KB | 约 30 ms | 约 0.3 ms，4 万 fuel |
| [TypeScript](../../templates/function-ts/README.md) | `npm ci && npm run build`（ComponentizeJS） | 约 12 MB | 约 2 s | 约 2.4 ms，1000 万 fuel |

- 两个模板各带一份 `wit/handler.wit`。套件 49 检查它们与 `function-host/wit/handler.wit` 一致。
- CI 在套件 49 的 job 里编译两个模板，并在宿主上调用一次。
- 计算密集的函数用 Rust：StarlingMonkey 以解释方式执行 JavaScript，同样的计算约慢 40 倍。

## WIT world

```wit
package eigos:function@0.2.0;

interface types { record failure { code: string, message: string } }

interface ontology {
  use types.{failure};
  get: func(object-type: string, id: string) -> result<option<string>, failure>;
  follow: func(object: string, link: string) -> result<string, failure>;
  query: func(query: string) -> result<string, failure>;
  evaluate: func(request: string) -> result<string, failure>;
  aggregate: func(request: string) -> result<string, failure>;
  create: func(object-type: string, id: string, properties: string) -> result<_, failure>;
  update: func(object: string, properties: string) -> result<_, failure>;
  delete: func(object: string) -> result<_, failure>;
  link: func(link-type: string, %from: string, to: string) -> result<_, failure>;
  unlink: func(link-type: string, %from: string, to: string) -> result<_, failure>;
}

world handler {
  use types.{failure};
  import ontology;
  export invoke: func(input: string) -> result<string, failure>;
}
```

- 输入和输出都是 JSON 文本。宿主不解析它们，由运行时按函数的契约校验。
- 函数用 `failure` 返回自己的失败：`code` 是调用方可以据此处理的稳定代码，`message` 给人看。
- `ontology` 是函数读取 Ontology 的接口，见下文“Ontology 接口”。0.1.0 的组件没有导入它，仍可原样运行。

## Ontology 接口

函数执行时可以读取 Ontology（F2 的读取部分）。依据是 Palantir 的 Functions：函数在服务端读取对象、遍历关系、查询和聚合 Object Set，并且有对象载入量和聚合分组数的上限（[overview](https://www.palantir.com/docs/foundry/functions/overview/)、[performance](https://www.palantir.com/docs/foundry/functions/optimize-performance/)）。

| 导入 | 参数 | 结果 | 运行时执行 |
| --- | --- | --- | --- |
| `get` | 类型、ID | `{ref, revision, properties}`，不存在或不可见时为 none | `Objects.read` |
| `follow` | `{type, id}` 的 JSON、Link 名 | 对象数组 | `Objects.follow` |
| `query` | 对象查询 | 一页结果 | `Objects.query` |
| `evaluate` | `{set, view?, limit?, cursor?}` | 一页成员 | `ObjectSets.evaluate` |
| `aggregate` | `{set, groupBy?, metrics}` | 聚合结果 | `ObjectSets.aggregate` |

- **回调：** 运行时为每次调用开一个回调会话：只监听 127.0.0.1，并用一个随机令牌标识这次调用。宿主执行到导入时，把操作发给这个会话，调用结束后令牌即失效。
- **权限：** 会话用这次调用自己的 `Objects` 和 `Access` 执行操作，所以权限、遮罩、记录的依赖和出口分级都与调用者直接读取相同。宿主自己不做任何判断。经查询内核的读取照常经过内核。
- **上限：** 每次调用最多回调 1000 次，返回的对象合计最多 10 万个，单个结果最多 4 MB。超出时导入返回 `failure`，函数可以自己处理。
- **截止时间：** 宿主函数执行时无法被中断，所以等待回调的时长以这次调用剩下的截止时间为限。
- **错误码：** `permission-denied`、`not-found`、`invalid`、`conflict`、`limit`、`unavailable`。函数把它原样返回时，调用方得到同样 `code` 的 `FunctionFailed`。
- **协议：** 宿主协议 2 起支持回调。运行时只给协议 2 的宿主发回调；更早的宿主上，导入返回 `unavailable`。

### 编辑

| 导入 | 参数 | 运行时执行 |
| --- | --- | --- |
| `create` | 类型、ID、属性 | `Objects.create` |
| `update` | `{type, id, revision?}`、要改的属性 | `Objects.edit` |
| `delete` | `{type, id, revision?}` | `Objects.remove` |
| `link`、`unlink` | Link 类型、起点和终点的 `{type, id}` | `Objects.link`、`unlink` |

依据是 Palantir 的 [edits](https://www.palantir.com/docs/foundry/functions/edits-overview/) 和 [staged writes](https://www.palantir.com/docs/foundry/functions/typescript-v2-staged-writes/)。

- **只经 Action 生效：** 编辑只在 Function-backed Action 中生效。`edits: true` 的组件函数在 Action 之外调用时被拒绝。只读函数调用编辑导入时，得到 `conflict`。
- **写后读：** 编辑函数在它的 Action 的提交事务里运行，读取、Object Set 查询和聚合都走这个事务，所以在同一次调用内，之后的 `get`、`follow`、`query`、`evaluate`、`aggregate` 都看得到之前的编辑。这对应 Palantir 的 staged writes：“any Ontology data read will reflect all edits previously made in the function”。
- **原子提交：** 函数正常返回时，它的编辑和 Action 一起提交；函数失败或 trap 时，事务回滚，什么也不留下。Action 的结果是函数返回的对象引用。
- **版本号：** `revision` 缺省时取对象当前的版本。给出时必须一致，否则 `conflict`。
- **上限：** 每次调用最多 1 万次编辑。

## 接口

服务只监听 `127.0.0.1`。端口由 `EIGOS_FUNCTION_HOST_PORT` 指定；不设置时随机分配，启动后输出一行 `function_host_listening` JSON，报告实际端口。

| 请求 | 说明 |
| --- | --- |
| `GET /health` | 协议版本 2、world、内存中的组件数与容量、并发槽数、是否持久化，以及各项上限 |
| `POST /components` | 请求体是组件，`x-eigos-sha256` 头给出它的 SHA-256。宿主检查、预编译并保存它，已有的直接返回 `cached: true` |
| `POST /invoke` | `{ sha256, input, limits, callback? }`，宿主在新实例中调用 `invoke`。运行时可提供本机 Ontology 回调。 |

### 调用的上限

`limits` 是 `{ fuel, memoryMb, deadlineMs, inputBytes?, outputBytes? }`，每一项都不能超过宿主的上限：

| 上限 | 宿主上限 | 怎样执行 |
| --- | --- | --- |
| `fuel` | 2000 亿 | wasmtime 的 fuel，按执行的指令计数；测试机上每毫秒约 1500–2200 万，所以上限大约相当于 10 秒 CPU 时间 |
| `memoryMb` | 512 | 组件所有线性内存的总和；表的元素总数另有 100 万的上限 |
| `deadlineMs` | 30000 | 墙钟时间：epoch 每 10 ms 递增一次，到期就中断调用，所以精度是 10 ms |
| `inputBytes` | 1 MB | 输入超过它时拒绝调用，默认为宿主上限 |
| `outputBytes` | 1 MB | 输出超过它时，调用以 `output` 错误结束，默认为宿主上限 |

fuel 计的是指令，截止时间计的是墙钟，两者分别生效：等待 I/O 或机器繁忙时，截止时间先到；纯计算时，通常是 fuel 先用完。

### 调用的结果

调用运行了，就返回 200：

- **成功：** `{ output, fuelUsed, ms }`。
- **失败：** `{ error, fuelUsed, ms }`。`error.kind` 是下列之一：

  | `kind` | 含义 |
  | --- | --- |
  | `failure` | 函数返回了 `failure`，另带 `code` 和 `message` |
  | `fuel` | fuel 用完 |
  | `memory` | 内存或表的增长超出上限，随后函数 trap |
  | `deadline` | 截止时间到 |
  | `trap` | 其他 trap，例如 panic |
  | `output` | 输出超过 `outputBytes` |

`ms` 包括新建实例的时间。函数写到 stderr 的内容最多保留 64 KB，超出后流被关闭；结果里的 `stderr` 只带最后 2000 个字符。

调用没有运行时，宿主返回错误状态：
- 400：上限不合法，或 `sha256` 不是 64 个小写十六进制字符；
- 404：宿主没有这个组件，运行时应上传后重试；
- 413：输入超过 `inputBytes`；
- 422：请求有未知字段或类型不对。

## 组件

- **检查：** 组件只能导入下列 WASI 接口：
  - `wasi:cli`（标准输入输出、终端、环境与退出）；
  - `wasi:clocks`、`wasi:random`、`wasi:io`；
  - `wasi:filesystem`。宿主不预开放任何目录，所以函数打不开任何文件。TypeScript 组件会导入它。

  导入 `wasi:sockets`、`wasi:http` 或其他接口的组件，以及没有按 world 的类型导出 `invoke` 的组件，上传时返回 422。
- **环境：** 每次调用的 WASI 环境没有环境变量、参数和网络，标准输入为空，标准输出被丢弃。
- **预编译：** 上传时编译一次。TypeScript 组件冷编译约 2 秒，从预编译结果载入约 10 ms。
- **缓存：**
  - 内存中最多保留 `EIGOS_FUNCTION_HOST_COMPONENTS` 个（默认 16），超出时淘汰最久未用的。TypeScript 组件预编译后约 38 MB。
  - 设置了 `EIGOS_FUNCTION_HOST_DATA` 时，预编译结果也写入这个目录，文件名是 `<sha256>.cwasm`。重启或淘汰之后，宿主在第一次调用时从磁盘载入，不重新编译。
  - 磁盘上的文件如果属于别的 wasmtime 版本或配置，就无法载入；宿主删除它，并对调用返回 404。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EIGOS_FUNCTION_HOST_PORT` | 随机 | 监听端口，只在 `127.0.0.1` |
| `EIGOS_FUNCTION_HOST_DATA` | 不持久化 | 预编译结果的目录，只应由宿主的用户读写，每个宿主一个。启动时删除上次没写完的 `.partial` 文件 |
| `EIGOS_FUNCTION_HOST_SLOTS` | CPU 数 | 同时执行的调用数，多余的排队。最坏情况下内存约为槽数 × 512 MB |
| `EIGOS_FUNCTION_HOST_COMPONENTS` | 16 | 内存中保留的组件数 |

## 安全边界

- **数据与凭据：** 宿主不连接数据库，不持有凭据，也不保存 Ontology 数据。输入只来自运行时：运行时先按调用者校验参数，再把它们发给宿主。
- **认证：** 宿主自身不做认证，所以只监听 loopback，与查询内核相同。运行时接入后，只有运行时上传组件，上传要求 `edit_definition`。
- **数据目录：** 宿主信任其中的预编译文件，因为载入时不会再校验机器码。所以这个目录只能由宿主的用户写入。
- **wasmtime 升级：** 版本固定在 `Cargo.lock`。wasmtime 发布安全公告后，单独发一个 PR 升级。升级后旧的预编译文件无法载入，宿主会删掉它们，然后由运行时重新上传。


## 组件外部源

声明 `source: "Inventory"` 的组件通过 `eigos:http/outgoing@0.1.0` 的
`send` 导入读取该源。组件传入 JSON 请求，如 `{"path":"/v1/items"}`，
并收到包含 `status`、`contentType` 和 `body` 的 JSON。请求使用已配置的
HTTPS 主机、端口和路径前缀。默认方法为 GET，当前组件调用也支持 HEAD。
发布记录包含连接和出站策略摘要。修改连接策略后重新准备发布。

在 Gateway、Worker 和 Indexer 指定同一份 `EIGOS_COMPONENT_SOURCES_FILE`，
该 JSON 文件放在仓库外：

```json
{
  "Inventory": {
    "baseUrl": "https://inventory.example.com/v1/",
    "methods": ["GET"],
    "bearerSecret": "inventory_token"
  }
}
```

`networks` 可指定批准的 CIDR。未指定时仅连接公共地址，运行时核验 DNS
解析结果后固定连接地址并继续校验证书。生产配置由部署人员管理。发送前
再次检查调用者的 Source 权限。运行日志记录源名称、结果和 HTTP 状态码。

Bearer 密钥可以换成配置的 OAuth `client_credentials`。配置 `oauth` 的
`grant`、`tokenUrl`、`clientId`、`clientSecret` 和可选的 `scope`，其中
`clientSecret` 是密钥名称。令牌只供运行时使用。运行时通过
`EIGOS_COMPONENT_SOURCE_SECRETS_FILE` 和
`EIGOS_COMPONENT_SOURCE_SECRETS_KEY_FILE` 打开加密密钥包。使用
`node --import tsx scripts/seal-component-source-secrets.ts /path/to/key`
从标准输入读取密钥名到密钥值的 JSON，并把密文输出到配置路径。密钥文件为
32 字节随机数据。两个文件都只授予运行服务和部署人员读取权限。

### 授权码凭据刷新

外部授权流程取得的 refresh token 可作为 Source 的初始凭据。将令牌放入
加密密钥包，部署时在 Source 的 `oauth` 中引用密钥名称。

```json
{
  "grant": "refresh_token",
  "tokenUrl": "https://auth.example.com/oauth/token",
  "clientId": "eigos-inventory",
  "clientSecret": "inventory_client",
  "refreshTokenSecret": "inventory_approved_grant"
}
```

Gateway、Worker 和 Indexer 共用 PostgreSQL 中的
`component_source_oauth_grants`。同一 token URL、client ID 和初始密钥名
只允许一个刷新请求在途。重新发布连接、调整出口策略或重启进程后会读回
同一轮换记录。多个 Source 共用同一供应商授权时，应引用同一个初始密钥名。
访问令牌和轮换后的 refresh token 用 Source 密钥加密，数据库只保存密文。
部署时由升级角色建表，向配置了刷新授权的运行角色授予 SELECT、INSERT 和
UPDATE。恢复数据库时应保留对应的 Source 加密密钥。

若授权服务器已明确拒绝请求且授权仍有效，后续可重新请求。收到
`source-reauthorization-required` 时，应重新完成供应商授权，将新令牌用新
的密钥名写入加密包，再按更新的 Source 连接重新准备发布。网络中断导致
无法确认旧令牌是否已被轮换时也走这条恢复路径。 [OAuth 2.0 刷新规范](https://www.rfc-editor.org/rfc/rfc6749.html#section-6) · [刷新令牌轮换](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14)

读取外部源要求协议 3 宿主。旧组件继续使用原有导入。带外部源的组件与
Scenario 离线求值保持隔离。需要外部写入的业务流使用经授权的 Action 和
提交后的副作用。 [Foundry 函数的外部 API](https://www.palantir.com/docs/foundry/functions/api-calls/)

## 调用记录

工作台的「函数调用」按函数显示调用者最近 30 天的记录。表格列出版本、
结果状态、总耗时、宿主执行耗时、fuel、Ontology 回调的次数和耗时。
函数失败时记录错误码。记录只含运行元数据，输入、输出和 stderr 留在各自的调用路径。

运行时在独立连接上写入 `function_invocations`，因此可查看后来随 Action
事务回滚的 Function 尝试。记录写入与查询之间可能有短暂延迟。Indexer
每小时清理超过 30 天的记录。

上线时先完成 schema 升级。生产运行角色需要对 `function_invocations`
执行 SELECT、INSERT、DELETE，并需要对该表的 identity sequence 有 USAGE。
