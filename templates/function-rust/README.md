# Rust 函数模板

用 Rust 写 EIGOS 的组件函数：输入和输出都是 JSON 文本，组件导出 world `eigos:function/handler@0.1.0`（`wit/handler.wit`）。上传、定义、版本和错误的完整说明见 [函数宿主指南](../../docs/guides/function-host.md#组件函数)。

## 构建

```bash
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2
# 组件在 target/wasm32-wasip2/release/eigos_function.wasm
```

## 发布

1. **上传组件**，记下返回的 `sha256`：

   ```bash
   curl -X POST "$EIGOS/ontology/function-artifacts?ontology=Eigos" -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/wasm' --data-binary @target/wasm32-wasip2/release/eigos_function.wasm
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
                         "limits": { "fuel": 100000000, "memoryMb": 32, "deadlineMs": 1000 } }
   }
   ```

3. **审阅并发布**定义分支。

## 编写

- **逻辑与失败：** `run` 是函数的逻辑。`fail(code, message)` 返回调用方看到的失败，其中 `code` 是调用方可以据此处理的稳定代码。
- **panic：** panic 会让调用以 trap 结束，调用方得到 `FunctionFailed`，`code` 为 `trap`。所以可以预期的失败要用 `fail`。
- **读取 Ontology：** 调用 `eigos::function::ontology::get(type, id)`、`follow`、`query`、`evaluate` 或 `aggregate`。参数和结果都是 JSON 文本，见 [Ontology 接口](../../docs/guides/function-host.md#ontology-接口)。读取按调用者的权限执行。
- **能读到什么：** 函数能读到输入和 Ontology（经上面的接口），既没有网络，也打不开文件。
- **规模：** 模板编出的组件约 90 KB。调用一次约 0.3 ms，用约 4 万 fuel。
