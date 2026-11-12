# datasource 推导（第二遍：四路扫描）

- 对象类型 204
- 已推导出 datasource：136
- 仍缺：68

## 已推导的分布

- `api://` 81（写入点在 `packages/capabilities/<provider>`）
- `dataset://` 25（写入点在投影/agent 模块）
- `internal://` 28（网关/核心内部写入）
- `store://business` 2（postgres 写入）
- 94 个类型有多处证据（需人工择一，不自动挑）

## 仍缺的 68 个（按能力系列分组）

- 其他 系列：31
- Vehicle 系列：6
- Transport 系列：5
- Food 系列：5
- Hotel 系列：5
- Itinerary 系列：5
- Ride 系列：4
- Appointment 系列：4
- Medical 系列：3

这些类型的写入点用模板拼类型名（`${subject.type}…`），字面量扫描不到；下一步按「能力系列 → provider」映射，逐个列出证据，仍然不猜具体单类型。

## 逐类型明细

`datasource-derived.json`（含 evidence 文件路径）
