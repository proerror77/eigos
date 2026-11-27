# Functions：F1–F5 的实施方案

本文是 [路线图](../roadmap.md) 线二的详细做法。Palantir 的依据见 [对标计划](../palantir-parity.md#functions差距最大)，宿主的选择见路线图的 F1 设计决定。

## 现状

- **实现：** 函数实现写在代码里。`Functions`（`packages/runtime/functions.ts`）按 `(apiName, version)` 注册处理函数。
- **发布：** 发布记录每个函数的契约摘要（参数、返回值、source、edits、依赖）和实现绑定（`bindings.functions`）。
- **调用：** `invoke` 依次检查：
  - `execute_function` 权限；
  - 实现在当前运行时可用；
  - Scenario 规则；
  - 编辑函数只能经 Action 调用；
  - source 权限；
  - 参数和返回值是否符合 schema。
- **读取：** 函数通过 `FunctionContext.objects` 读取对象：`read`、`query`、`follow`。它们已经经过查询内核（C4b、C5b），F2 的读取接口直接建在上面。
- **插件试点：** `extensions.ts` 从文件加载插件实现。spared 是用 Wasm 隔离执行的试点，不作为 F1 的宿主。

## F1：函数运行时

### 组成

1. **函数宿主 `function-host/`：** Rust 二进制，基于 wasmtime 的组件模型，独立运行为一个用户单元，只监听 127.0.0.1。
   - **状态：** F1 已全部实现：宿主、组件存储、组件函数的定义与调用、版本规则、模板，以及宿主二进制的发布工作流，见 [函数宿主指南](../../guides/function-host.md)。生产上线见下文“上线与回滚”。
   - 它不连接数据库，不持有凭据，也不保存 Ontology 数据。
   - 输入只来自运行时：已经校验并遮罩过的参数。
2. **WIT world `eigos:function@0.1.0`：**

   ```wit
   package eigos:function@0.1.0;
   world handler {
     record failure { code: string, message: string }
     export invoke: func(input: string) -> result<string, failure>;
   }
   ```

   - 输入和输出是 JSON 文本。
   - 组件不能导入网络。可以导入 cli、时钟、随机数、io，以及一个没有预开放任何目录的文件系统。
   - F2 在同一个 world 上增加 Ontology 宿主接口。
3. **组件存储：**
   - 新表 `function_artifacts(sha256 text PRIMARY KEY, bytes bytea NOT NULL, size integer NOT NULL, world text NOT NULL, uploaded_by text NOT NULL, uploaded_at timestamptz NOT NULL)`，按 SHA-256 去重，单个组件最大 16 MB。
   - 上传接口 `POST /ontology/function-artifacts` 需要 `edit_definition`。宿主先检查组件确实导出 `eigos:function/handler`，然后才入库。
4. **定义：**
   - `functionTypes` 增加 `implementation: { kind: 'component', sha256, limits }`，其中 `limits = { fuel, memoryMb, deadlineMs, inputBytes, outputBytes }`。
   - 组件函数的 `version` 必须是语义化版本。
   - 宿主规定上限的上限，第一版为：`memoryMb ≤ 512`、`deadlineMs ≤ 30000`、`inputBytes`/`outputBytes ≤ 1 MB`，fuel 的上限由实测折算。

### 执行

1. `Functions.invoke` 遇到组件函数时，在现有检查之后，把参数 JSON、组件摘要和上限发给宿主：`POST /invoke`。
2. 宿主按摘要缓存预编译的 `InstancePre`。每次调用新建一个 `Store`，并设置三项限制：
   - `Store::set_fuel(limits.fuel)` 限制 CPU；
   - `ResourceLimiter` 限制线性内存和表；
   - `epoch_interruption` 配合一个每 10 ms 递增 epoch 的线程，执行截止时间。
3. 宿主返回下列结果之一：
   - `{ output, fuelUsed, ms }`；
   - `{ error: { kind, message }, fuelUsed, ms }`，`kind` 是 `failure`（函数自己的失败，另带 `code`）、`fuel`、`memory`、`deadline`、`trap` 或 `output`。
4. 运行时把错误映射为稳定的错误码：超限是 `ResourceExhausted`，trap 是 `FunctionFailed`。随后照旧校验返回值。
5. 嵌套调用的深度不超过 8，由运行时在 `FunctionContext` 里计数。

### 版本与发布

**状态：** 已实现，见 [函数宿主指南](../../guides/function-host.md#版本) 和 [Action 指南](../../guides/action-api.md#函数的版本范围)。实现与下文的不同之处：一个发布里每个函数只有一个版本，所以消费方的范围在定义校验时检查，不在激活时解析。

1. **准备阶段：** `prepare` 检查：
   - 组件存在、摘要一致、导出正确的 world；
   - 参数和返回值的 schema 合法；
   - 与基线发布中的同名函数比较兼容性。下列变化是破坏性变更，要求主版本加一（`0.y.z` 允许次版本加一）：
     - 删除或重排输入；
     - 新增必需输入；
     - 输入或输出的类型改变。
2. **消费方：** Action、Automation 和其他函数用版本范围引用函数，例如 `^1.2.0`。
   - 激活时把范围解析为范围内最高的已发布版本，写进 `bindings.functions`，形式为 `component:<sha256>`，保证可复现。
   - 发布新版本就形成新的发布。
3. **生效：** 发布后的函数版本不可变，沿用定义分支的审阅和激活。

### 模板与工具链

**状态：** 已实现，见 [函数宿主指南](../../guides/function-host.md#模板)。

- **`templates/function-rust`：** 用 `wit-bindgen`，目标 `wasm32-wasip2`（rustc 直接产出组件），在 CI 里编译并调用一次。
- **`templates/function-ts`：** 用 ComponentizeJS 的 API，关闭 `http` 和 `fetch-event`。
- EIGOS 不在服务器上编译源码，组件由作者自己构建后上传。

### 技术验证（2026-11-27，已通过）

原型在丢弃分支 [`prototype/f1-function-host`](https://github.com/proerror77/eigos/tree/prototype/f1-function-host/function-host-prototype) 上，`./run.sh` 可以重现。环境是 Apple Silicon、wasmtime 50.0.1、wit-bindgen 0.63.0、ComponentizeJS 0.23.0。

| | Rust | TypeScript |
| --- | --- | --- |
| 组件大小 | 63 KB | 12.0 MB |
| 冷编译 / 预编译后反序列化 | 22 ms / 0.2 ms | 1.9 s / 10.4 ms（预编译产物 37.8 MB） |
| 每次调用：新建实例 + 调用 | < 0.1 ms | 0.6 + 0.1 ms |
| 100 万次循环 | 1.4 ms | 56.5 ms |
| fuel、内存、截止时间三种上限 | 都能中止 | 都能中止；内存超限时函数收到 `out of memory` 错误 |

**结论：** TypeScript 能在自建的 wasmtime 宿主中、按 EIGOS 的 WIT world 运行，三种上限都有效，所以 F1 以 TypeScript 为主，同时提供 Rust 模板。

验证得出的设计要求：
1. **预编译：** 组件在上传或发布时编译一次，预编译结果按 SHA-256 缓存。冷编译 1.9 s 不能放在调用路径上；反序列化只要 10 ms。
2. **fuel 的折算：** 两种语言在测试机上都约为每毫秒 15–22 M fuel，TypeScript 调用在执行函数代码前还要先用掉约 10 M。上限要在生产主机上按 CPU 时间重新标定。
3. **错误：** TypeScript 直接 `throw new Error()` 会让组件 trap。只有抛出的值带 `payload` 时，才会映射成 `err`。模板提供 `fail(code, message)` 来抛出这样的值。
4. **WASI 接口：** 宿主只链接 cli 的标准输入输出、终端、环境与退出，以及 clocks、random、io。TypeScript 组件还导入 filesystem，宿主提供一个没有任何预开放目录的文件系统；任何时候都不链接 sockets。
5. **构建工具：**
   - preview2-shim 0.31 默认没有任何预开放目录，模板的构建脚本要把工作目录开放给 ComponentizeJS 的拼接器；
   - `tsc` 要忽略仓库的 tsconfig。
6. **性能预期：** StarlingMonkey 以解释方式执行 JavaScript，计算密集的 TypeScript 约比 Rust 慢 40 倍。文档要写明这一点，计算密集的函数建议用 Rust。

### 测试与验收

- **宿主单元测试：** fuel 用完、内存超限、截止时间到、trap、输出过大，分别返回对应的错误；正常调用的 fuel 用量稳定。
- **运行时集成测试（新套件）：**
  - 上传组件，定义分支发布，Action 的提交条件和 Agent 都能调用它；
  - 权限不足时拒绝；
  - 参数和返回值不符合 schema 时拒绝。
- **兼容性检查：** 用表驱动的测试覆盖每一种破坏性变更，以及 `0.y.z` 例外。
- **版本范围：** 激活时解析为范围内最高的版本，发布了新版本也不影响已激活的发布。
- **验收：**
  - 作者编译的组件经审阅发布后，可被 Action 和 Agent 调用；
  - 超出上限的调用按约定失败；
  - 破坏性变更不能以次版本发布。

### 上线与回滚

- 函数宿主像内核一样，作为独立单元安装：使用发布的二进制，核对 SHA-256，用户单元只监听 127.0.0.1。
- 没有配置 `EIGOS_FUNCTION_HOST_URL` 时，组件函数不能发布，`prepare` 会报错。
- 回滚：停用宿主单元。已发布的组件函数调用失败，并返回稳定的错误码；代码内置的函数不受影响。

### 风险

- **组件体积与冷启动：** ComponentizeJS 打包 JavaScript 引擎，组件约 8–10 MB，冷启动较慢。缓解办法：按摘要缓存预编译结果，并在启动时预热已激活的函数。
- **wasmtime 安全更新：** 版本固定在 Cargo.lock；安全公告发布后，单独发一个 PR 升级。
- **fuel 不是墙钟时间：** fuel 计的是执行的指令，截止时间另由 epoch 执行。文档要如实说明两者的区别。

## F2：Ontology API 与编辑

**目标：** 组件函数在执行中读取对象、遍历关系、查询和聚合 Object Set，并暂存编辑。

**状态：** 读取和编辑都已实现，见 [函数宿主指南](../../guides/function-host.md#ontology-接口)。实现与下文的不同之处：
- 回调用每次调用一个的本机 HTTP 端点加令牌，而不是双向流，接口参数和结果都是 JSON 文本；
- 编辑按 Palantir 的 staged writes 语义实现：编辑函数在 Action 的提交事务里运行，所以读取、查询和聚合都反映之前的编辑，并与 Action 一起原子提交，不需要单独的编辑缓冲。

### 宿主接口

在 world 里增加导入接口 `eigos:ontology/objects`：
- `get(type, id) -> option<object>`；
- `follow(ref, link, as?) -> list<object>`；
- `query(json) -> page`；
- `evaluate(set-json, page) -> page`；
- `aggregate(set-json, metrics-json) -> result`；
- 编辑：`create`、`edit`、`delete`、`link`、`unlink`。

### 回调方式

一次调用是一个双向会话，宿主与运行时之间用一条 HTTP/2 流或 WebSocket：
1. 宿主执行到宿主函数时，向运行时发一条调用消息。
2. 运行时用这次调用的 `Access` 执行它：`Objects.read`/`follow`/`query`、`ObjectSets.evaluate`/`aggregate`，这些都经过查询内核。
3. 运行时回送结果。

权限、遮罩、行依赖和出口分级与直接调用完全一致，因为执行它们的是同一套代码。宿主自己不做任何权限判断。

### 上限

运行时为每次调用规定：
- 宿主函数调用的次数；
- 读取的对象数，默认 10 万；
- 单次结果的大小。

超出时宿主函数返回错误，函数可以自己处理。

### 编辑

- **暂存：** 编辑暂存在运行时为这次调用建立的编辑缓冲里，与 Action 的编辑上下文（`context.edit`）是同一套机制。
- **写后读：** 调用内按主键读取或遍历被编辑的对象时，看到暂存后的值。
- **搜索：** 搜索（`query`、`evaluate`、`aggregate`）是否也要反映暂存的编辑，在设计 PR 中先按 Palantir 的 [edits](https://www.palantir.com/docs/foundry/functions/edits-overview/) 文档确认语义再定。如果要反映，可以把编辑缓冲当作一个临时 Scenario 叠加层交给内核（C5a 的机制）。
- **提交：** 只有 Function-backed Action 会提交编辑，在一个事务里完成；普通调用的编辑在调用结束时丢弃。

### 验收

- **读取：** 函数内读到的数据、权限和记录的依赖，与在函数外直接查询一致。用套件 46 的差分方式比对。
- **编辑：** 只在 Action 提交时生效；调用内的写后读与直接读取暂存结果一致。

## F3：外部源

- **source 的组成：**
  - 连接：基础 URL；
  - 出口策略：允许的主机、端口和方法；
  - secrets：按名称引用，静态加密存储，只在运行时内存中解密；
  - 可选的 OAuth 出站凭据：client credentials，或带刷新令牌的授权码。
- **调用方式：**
  - 函数没有网络能力，外部调用通过宿主接口 `eigos:http/outgoing` 发起。
  - 运行时的出口代理负责：检查函数声明了这个 source、请求符合出口策略、注入凭据，并记录调用。
- **webhook：** webhook 函数挂在 Action 的副作用上（`effects`），在 Action 提交之后执行，沿用现有副作用的重试和幂等。
- **授权：** 对真实供应商的写操作，仍按项目规则逐次取得用户授权。测试只用合成供应商。
- **验收：**
  - 未声明的出站请求被拒绝；
  - 凭据不出现在函数可见的数据和日志里；
  - 出口策略拒绝的请求有记录。

## F4：测试与观测

- **测试框架：**
  - 包名 `@eigos/function-test`。它在本机用同一个函数宿主（测试模式）运行组件，Ontology 宿主接口由测试 stub 提供：对象、查询结果和主体。
  - 测试可以断言函数产生的暂存编辑。
  - 模板仓库自带示例测试，可以离线运行。
- **调用记录：**
  - 新表 `function_invocations` 记录每次调用：函数和版本、调用者、结果状态、fuel、墙钟耗时、宿主函数的次数和耗时（读对象、遍历、查询）、错误码。
  - 保留 30 天，在工作台按函数查看。
- **验收：**
  - 模板的测试能离线运行；
  - 工作台能查看调用记录和耗时分解。

## F5：模型与流式

- **模型调用：**
  - 宿主接口 `eigos:models/generate(alias, input) -> stream<chunk>`；
  - `alias` 映射到已配置的模型，受模型出口策略约束；
  - token 用量计入调用记录。
- **流式返回：**
  - 函数的返回值可以声明为流；
  - 调用方逐段读取，Agent 和 Gateway 用 SSE 转发；
  - 取决于 WASI 0.3 对流的支持，在此之前用分段回调实现。
- **向量生成：** 语义索引和查询调用已发布的只读组件 Function。组件遵守版本化嵌入契约（`packages/ontology/embedding-definition.ts`）。在 PostgreSQL 启用 pgvector 后，组件产生的向量可用于相似度排序。参见 [C5c 的决定](../query-kernel.md#向量检索的去留c5c-决定2026-11-26)。
- **验收：**
  - 模型调用受出口策略约束；
  - 流式结果可以逐段消费；
  - 组件嵌入函数产生的向量可以检索。

## 依赖与顺序

1. F1 不依赖其他线。
2. F2 依赖 F1 和查询内核 C4b、C5（已完成）。
3. F3 依赖 F1。
4. F4 可以与 F2、F3 并行。
5. F5 依赖 F2 和 F3。
