# 滴滴官方 Mock 下单测试

运行契约 `ontology-execution-v23`，业务模型 `eigos.business@20`。本功能测试创建订单与回查的完整任务闭环，不派真实车辆、不支付费用。依据[滴滴官方 API 说明](https://mcp.didichuxing.com/api)与[官方工具契约](https://github.com/didi/didi-ride-skill/blob/main/references/api_references.md)区分生产和 Mock 端点。

## 使用与完成含义

启用既有本机只读地图绑定，再设置 `EIGOS_DIDI_ORDER_TEST_ENABLED=true`、`EIGOS_ACTION_SANDBOX=true`。默认不开启测试能力；生产订单开关仍只能为 false。Gateway 只装载目录，Worker 读取私有 Key。MCP 和 A2A 均提交 `eigos.delegate`，环境 sandbox，可显式指定 `capabilityRef={id:"ride.order.test",version:"1"}`。

官方固定示例输入为北京市、北京西站 → 西二旗-地铁站、快车、target=created。其他路线或真实派车目标不能通过这个测试能力被宣称完成。Mock 地图返回固定示例，因此地点坐标来自生产只读 maps_textsearch；估价、创建、查询全部严格固定到 `mcp-servers-sandbox`，不支持重定向到生产。

模型通过 Ontology 选择 SearchDidiTestPlaces、EstimateDidiTestOrder；展示来源模拟报价后，再选择 CreateDidiTestOrder、QueryDidiTestOrder 及条件验收绑定。创建等待 PA 对准确计划的独立 sandbox 许可。零元许可表示测试无真实费用，不能转换为支付权限。禁止覆盖叫车手机号。

回查仅使用本任务创建返回的原订单 ID。Mock 会重复返回固定订单 ID，回查目前可能只返回固定状态文本、不回显 ID；证据显式记录这些限制。完成仅指官方测试端点确认创建并通过原 ID 独立查询，证据为 provider_test，不证明生产下单、司机接单、接驾或行程完成。原始带手机号／trace 的回执留在私有审计目录，公开任务与模型上下文只含脱敏结果。

## 延迟优化与目标覆盖

只在 PA 明确指定能力，且能力注册为 registered_fixed_input、输入 Schema 全部为必填常量的封闭对象时，使用一个实际模型响应核查原始目标与预先固定的能力范围，并选择首轮只读依赖图。模型不生成范围后自行批准。新增自然语言约束若不在注册范围内，必须澄清或拒绝；已有结构化约束保留并继续验证。普通可变输入保留独立目标核查响应。

GoalCoverage@2 记录 reviewOrigin、完整响应摘要、原始消息逐段引用及所用输入／条件，固定范围核查绑定真实 grounding 响应；普通核查绑定独立 goal_coverage 响应。缺少固定范围核查时仍走独立核查，不跳过。完成后的统一结果、反馈、本体投影与两种协议回读保留。

模型可以在报价后同时选择一次创建、原 ID 回查与条件验收；批准后不再为既定步骤增加模型响应。主机依旧重新读取实际结果、检验来源与硬条件。不确定的结果返回反馈，不能伪造成功。

## 故障与恢复

创建最多发送一次，不做自动重试。若收到 ID 后丢失领取权，迟到结果只作为审计；恢复只能查询保存的原 ID，取消任务不能重新打开或投影完成。若响应丢失且无可信 ID，保持结果未知，禁止再创建、猜 ID 或查询账户最近订单。此策略不声称供应商支持幂等键。过期估价不能创建。

## 测速口径

分别记录：首次提交到报价及精确计划可确认；收到测试许可到创建后独立验收；两者相加的系统活跃总时间。用户阅读／确认等待时间不计入活跃总时间，但客户端墙钟时间单列。实际模型、官方 Mock 与生产只读地图用于端到端实测；单元 fixture 结果不作为性能证据。测试不保证生产链路或司机响应达到同样时间。具体样本见[完整测速记录](evidence/didi-order-test-latency-2026-10-25.json)。初始成功三轮为 43.40–44.28 秒；优化成功三轮为 33.10、23.50、26.31 秒。两轮后续验证因地图配额拒绝而未下单，不能剔除后声称稳定达标。低于 20 秒尚未证实。
