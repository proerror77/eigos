# TypeScript 函数模板

用 TypeScript 写 EIGOS 的组件函数：输入和输出都是 JSON 文本，组件导出 world `eigos:function/handler@0.1.0`（`wit/handler.wit`）。构建用 [ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS)，它把函数连同 JavaScript 引擎 StarlingMonkey 打包成一个组件，并关闭 HTTP 和 fetch。上传、定义、版本和错误的完整说明见 [函数宿主指南](../../docs/guides/function-host.md#组件函数)。

## 构建

```bash
npm ci
npm run build
# 组件在 function.wasm
```

## 发布

1. **上传组件**，记下返回的 `sha256`：

   ```bash
   curl -X POST "$EIGOS/ontology/function-artifacts?ontology=Eigos" -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/wasm' --data-binary @function.wasm
   ```

2. **加入函数定义：** 在定义分支里加入下面的定义。`parameters` 和 `returns` 要与 `Input`、`Output` 一致。

   ```json
   {
     "apiName": "SumValues", "description": "Sum the given values", "version": "1.0.0",
     "parameters": { "type": "object", "properties": { "values": { "type": "array", "items": { "type": "number" } } },
                     "required": ["values"], "additionalProperties": false },
     "returns": { "type": "object", "properties": { "sum": { "type": "number" }, "count": { "type": "integer" } },
                  "required": ["sum", "count"] },
     "implementation": { "kind": "component", "sha256": "…",
                         "limits": { "fuel": 1000000000, "memoryMb": 64, "deadlineMs": 2000 } }
   }
   ```

3. **审阅并发布**定义分支。

## 编写

- **逻辑与失败：** `run` 是函数的逻辑。`fail(code, message)` 返回调用方看到的失败。ComponentizeJS 只把抛出值的 `payload` 当作失败返回，所以直接 `throw new Error()` 会让调用以 trap 结束，调用方得到 `code: 'trap'`。
- **单个文件：** ComponentizeJS 接收一个模块。函数分成多个文件时，先用打包工具合成一个文件。
- **读取 Ontology：** `import { get, follow, query, evaluate, aggregate } from 'eigos:function/ontology@0.2.0';`。参数和结果都是 JSON 文本，见 [Ontology 接口](../../docs/guides/function-host.md#ontology-接口)。读取按调用者的权限执行。
- **能读到什么：** 函数能读到输入和 Ontology（经上面的接口），既没有网络，也打不开文件。
- **规模：**
  - 组件约 12 MB。上传时宿主要预编译约 2 秒，之后从预编译结果载入只要约 10 ms。
  - 调用一次约 2.4 ms。在执行函数代码之前，就要先用掉约 1000 万 fuel。
  - 至少需要 16 MB 内存，模板建议 64 MB。
- **性能：** StarlingMonkey 以解释方式执行 JavaScript，计算密集的代码约比 Rust 慢 40 倍。这类函数建议用 [Rust 模板](../function-rust/README.md)。
