# 滴滴官方 Mock 下单测试

`ride.order.test@1` 由 `EIGOS_DIDI_ORDER_TEST_ENABLED=true` 显式启用，使用 `executionEnvironment="sandbox"` 与独立准确计划许可。它与既有 `EIGOS_DIDI_ORDERS_ENABLED=mock` 模拟预约能力不同，不能互相替换合同；两者都不授权真实派车或付款，公开会员滴滴连接仍仅用于估价。

测试固定为北京市北京西站 → 西二旗-地铁站、快车、目标 created。生产只读地图提供实际地点；估价、创建和原订单查询固定到官方 `mcp-servers-sandbox`。Mock 地图与订单可能返回固定示例，因此不能把这些结果当作真实行程或唯一交易。

模型经 Ontology 选择 SearchDidiTestPlaces、EstimateDidiTestOrder、CreateDidiTestOrder 和 QueryDidiTestOrder。展示模拟报价后取得准确 sandbox 许可，创建最多发送一次；仅使用该次创建返回的订单 ID 独立查询。无 ID 的未知结果不能猜测、查询账户最近订单或重复创建。手机号和 quote trace 只留在私有来源审计，禁止调用方覆盖手机号。

完成只表示官方 Mock 创建确认及原 ID 回查，证据为 provider_test。匹配中不代表司机接单、接驾或履约。文本回查未回显 ID 时会明确记录限制。来源、账号、版本、当前许可与迟到结果保护保留。

测速分别记录提交到可确认计划、收到精确许可到独立验收，以及两者相加的活跃时间。人工确认等待、模型处理、来源调用和客户端回读分别记账。地点回放／模拟延迟必须标为 fixture，不能直接推导生产速度。具体历史测试和失败记录位于私有归档，当前版本的速度须重新测量。
