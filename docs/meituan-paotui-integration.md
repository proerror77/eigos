# 本人美团：独立本体、地址选择与只读估价

当前代码契约为 `ontology-execution-v15`。公共入口仍为 `eigos.delegate`，提供 `geo.search@1`、`address.book.read@1` 和 `delivery.quote@2`。PA 可提交“帮我查1公斤文件普通送运费，先让我选择寄件和收件地址”，无需技术地址 ID。

工具映射、参数来源、业务代码查表和依赖维护在 [`meituan-readonly.json`](../ontology/meituan-readonly.json)。维护方法见 [Ontology 数据包](../ontology/README.md)，总体边界见 [统一 MCP 说明](mcp-ontology-unification.md)。

## 模型规划与原子读取

初始化只创建 `MeituanReadTask`。模型读取本体和观察后，决定读取、补问、并行／分轮方式或完成。不存在候选准备时自动读地址、连接器自动补齐详情、报价后固定复查的流程。

| 本体动作 | 单次 MCP／CLI 业务操作 | 来源前提 |
| --- | --- | --- |
| `SearchMeituanLocations` | `search_poi` | 精确任务城市与关键词；配置白名单仍限制查询 |
| `ReadMeituanAddresses` | `get_address_list` | 本人地址查询或配送估价目的 |
| `ReadMeituanSenderDetails`、`ReadMeituanRecipientDetails` | 各一次 `get_address_info` | 当前地址观察、用户已确认的对应角色，模型已读取并评估来源 |
| `EstimateMeituanDelivery` | 一次 `delivery_preview` | 本体声明的当前地址簿、两端详情及明确物品／重量／服务 |

`requires` 是证据要求，不自动运行前置动作。两端详情可以并行或分轮读取。每次 MCP 业务调用只执行一个官方 CLI 业务读取；令牌读取、握手与模块校验属于鉴权和协议处理。模型、任务文本和本体文件不能打开订单、付款、取消或授权变更工具。

## 同一任务与私密选择

地址观察只让模型看到数量和选择是否就绪。原生 ID、地址选项、坐标、联系人和电话保留在 owner／taskId 私密上下文中。模型决定补问后，主机向原任务所有者展示真实问题和选项；PA 转述后，以原 taskId 回复用户选择。未真正展示的编号、虚构或歧义选择不能用于查询联系人和价格。

重启及来源排序变化不改变已经展示的编号。地址或门牌变化产生新一组选项并拒绝旧编号；不得把“1公斤”等数字当地址选择。同城、不同地址、原请求计价参数及来源角色在派发前核对。用户未提供的业务信息保持为空，不要求猜测手机号或地址 ID。

同一组地址与详情使用一致的私密凭据上下文；上下文变化会阻止混合使用旧来源，需要重新取得当前来源。值和指纹不进入模型。私密缓存与观察投影都受任务状态、revision、租约和领取令牌保护，取消后的迟到结果不能修改已显示选择或产生成功观察。

公开 POI 会映射为 `Place`；估价映射为 `DeliveryQuote`／`Parcel`／带来源版本的匿名路线标签，不把电话或地址选项投影给模型。估价不是完整最终费用或配送完成。PA 的报价交付只包含经检查的费用和业务参数。

## 运行与配置

Gateway／Worker 使用相同的 `EIGOS_PAOTUI_SKILL_DIR`；只有 Worker 在选定动作后启动内部 stdio MCP。`apps/ontology-mcp/main` 只暴露四个原子读取及纯元数据 `ontology_module`，没有 HTTP 监听。连接器校验本体模块版本和内容摘要，再验证所选操作的输入／结果回执。

`pt-passport` 和原有官方查询程序内部读取凭据。成功读取的安全元数据可写入绝对路径 `EIGOS_ONTOLOGY_AUDIT_PATH`，不含地址、电话或令牌。原始私密来源保留在受保护的任务存储中。只允许固定本人 loopback 开发身份，不共享个人凭据给 JWT 多用户。`EIGOS_PAOTUI_ORDERS_ENABLED=true` 启动即拒绝。

公开地点 `lat`／`lng` 仍按 CLI 契约将整数微度转换为度，显式标注 `coordinateUnit: "degree"`，不按数值大小猜测参考系。结果最多100项，未知调试／联系人字段不会进入公开结果。

`EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES` 保留为受信运行配置：最多16项精确的 `city`／`keyword`，格式与非生产 loopback 限制保持。非空清单约束新的公开读取程序，不再触发模型前的 DiscoverySource 读取。Gateway 不查询供应商，任务和模型不能扩展清单。查询区域表示 `search_area`，不证明每个 POI 都在行政区内，也不代表商家供给或配送目的地。构建、同步和常驻更新见 [运行说明](gateway-worker.md)。

## 验证与历史

当前测试覆盖模型前无外部读取、原子命令计数、原任务补问、实际已展示选项、排序／地址变化、跨城与跨任务防护、模型评估回执、私密缓存取消保护及凭据上下文变化。合成 CLI 和模型替身只能证明本地接线及边界，不能当真实供应商或 PA 证据。

v14 及更早任务保持只读，不迁移或自动重放。旧准备式实现已移入历史测试夹具，不进入生产执行目录。历史 [2026-10-17 两段 E2E](evidence/service-network-e2e-2026-10-17/README.md) 和 [2026-10-18 公开地点 PA 验收](evidence/public-geo-pa-2026-10-18/README.md) 保留各自当时的范围及来源。当前 `examples/observe-mcp-readonly.ts` 仅回读已有当前版本任务，不提交目标或调用供应商；旧格式观察器保存在 `examples/legacy`。
