# 函数宿主（F1）

这是 [Functions 实施方案](../architecture/plans/functions.md#f1函数运行时) F1 的第一部分：运行用户函数的宿主服务。函数由作者编译成 WebAssembly 组件，宿主在 wasmtime 中执行，每次调用都在调用方给出的上限内运行。

- `function-host/` 是 Rust 服务，基于 wasmtime 50 的组件模型。
- `packages/runtime/function-host.ts` 是客户端。

运行时还没有接入宿主：组件存储、`implementation.kind: 'component'` 的函数定义和 `Functions.invoke` 的分派是 F1 的下一个 PR。

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

## WIT world

```wit
package eigos:function@0.1.0;

world handler {
  record failure { code: string, message: string }
  export invoke: func(input: string) -> result<string, failure>;
}
```

- 输入和输出都是 JSON 文本。宿主不解析它们，由运行时按函数的契约校验。
- 函数用 `failure` 返回自己的失败：`code` 是调用方可以据此处理的稳定代码，`message` 给人看。
- F2 在同一个 world 上增加 Ontology 宿主接口。

## 接口

服务只监听 `127.0.0.1`。端口由 `EIGOS_FUNCTION_HOST_PORT` 指定；不设置时随机分配，启动后输出一行 `function_host_listening` JSON，报告实际端口。

| 请求 | 说明 |
| --- | --- |
| `GET /health` | 协议版本 1、world、内存中的组件数与容量、并发槽数、是否持久化，以及各项上限 |
| `POST /components` | 请求体是组件，`x-eigos-sha256` 头给出它的 SHA-256。宿主检查、预编译并保存它，已有的直接返回 `cached: true` |
| `POST /invoke` | `{ sha256, input, limits }`，宿主在新实例中调用 `invoke` |

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
