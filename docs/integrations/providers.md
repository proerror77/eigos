# 供应商与沙箱配置

完整变量与默认值见[配置模板](../../.env.example)。能力只有在明确配置和身份检查通过后才进入当前目录。

| 接入 | 主要配置 | 约束 |
| --- | --- | --- |
| 滴滴只读 | `EIGOS_DIDI_KEY_FILE`、密钥摘要、binding ID 与环境 | 来源绑定的地点和车型估价；不会创建真实行程 |
| 公网会员滴滴估价 | `EIGOS_DIDI_MEMBER_CONNECTION_FILE` | 邀请会员本人授权的私有绑定；仅该身份可以搜索地点和估价 |
| 滴滴模拟订单 | `EIGOS_DIDI_ORDERS_ENABLED=mock` 及沙箱配置 | 只适用于 mock；不能用来启用生产下单 |
| Shopify 目录 | `EIGOS_SHOPIFY_CATALOG_MERCHANTS` | 显式商家身份；匿名目录读取不能证明购买或配送资格 |
| Shopify 未付款结账 | `EIGOS_SHOPIFY_CHECKOUT_MERCHANTS`、私有审计目录、持久任务库 | 独立开关与准确草稿许可；不收集买方资料、不付款 |
| 免费报名 | `EIGOS_FREE_BOOKING_*` | 固定参与者、私有来源、完整零费用与在线操作代理 |
| Shopify PA 付款沙箱 | `EIGOS_SHOPIFY_PAYMENT_SANDBOX_*` 与沙箱开关 | PA 测试凭据与 EIGOS 来源凭据分离，只允许 loopback 合成来源 |
| 预约沙箱 | `EIGOS_BOOKING_SANDBOX_*` | 合成服务商；预约与付款分别回读 |
| 交易沙箱 | `EIGOS_COMMERCE_SANDBOX_*` | 独立合成提供方与凭据，无真实商家效果 |
| 通用及 UCP 沙箱 | 显式沙箱提供方与来源绑定 | 固定原操作、幂等回读和模拟履约 |

连接器只解释已经选定的动作与参数。私密来源、主机和只读权限由受信执行代码管理；编辑本体元数据不会自动扩大账号权限。

工具绑定数据集中在 [`packages/ontology/definitions/`](../../packages/ontology/definitions/)。操作结果仍需保留来源、任务版本、准确操作身份，并经过独立验收。实际来源检查须另行使用已授权的账号与业务范围。

## 公网会员滴滴只读绑定

邀请实例可配置一个本人明确授权的会员连接文件。它不是所有会员共享的服务器账号，也不改变现有美团凭据上传接口。文件须为当前运行用户拥有的 0600 普通文件；字段以 [`didiMemberConnectionSchema`](../../packages/core/didi-source.ts) 为准：`version=1`、`connectionId`、递增 `revision`、准确 `memberId` 与 `owner`（issuer／tenant／subject）、`localUid`、`purpose=ride_estimate_readonly`、`state`、`expiresAt`，以及 `binding`。后者包含既有私密 Key 文件路径、摘要、绑定 ID、`environment=production` 和独立私密审计目录。Key 内容不进入该文件、任务或模型。

Gateway 将绑定与实际有效会员核对，并在共享业务库登记准入；Worker 不打开会员登录库。跨身份、本机开发身份、过期、文件权限变化、撤销或轮换均拒绝读取；读取中发生撤销也不能接受迟到结果。撤销会员、客户端或安装会持久撤销该连接；恢复时必须明确更新连接 revision，重启不能恢复旧许可。订单开关必须为 false，只允许 `maps_textsearch` 和 `taxi_estimate`。

已有实例的业务库可能仍固定较早本体。先备份并在副本运行 `node scripts/install-didi-readonly.mjs --database /absolute/private/copy.sqlite`，核对返回的本体摘要和 generation，再带 `--apply --expected-digest <摘要> --expected-generation <版本>` 安装。它只追加受信的滴滴只读对象、关系、动作与核验函数，不替换原定义、不重放历史任务、不提供业务许可。验证副本兼容后，在受控停机和备份后对实际业务库执行同一安装，再更新 Gateway／Worker。新任务固定新发布，旧任务保留原发布。

PA 仍经原 MCP／A2A 委托“上海某起点到前滩太古里，只查估价，不下单、不付款”。完成须回读实际 `RideEstimateObservation`、`rideEstimateStatus=known` 和任务独立验收。估价不是最终车费、订单、车辆可用或接驾承诺。
