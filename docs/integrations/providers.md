# 供应商与沙箱配置

完整变量与默认值见[配置模板](../../.env.example)。能力只有在明确配置和身份检查通过后才进入当前目录。

| 接入 | 主要配置 | 约束 |
| --- | --- | --- |
| 滴滴只读 | `EIGOS_DIDI_KEY_FILE`、密钥摘要、binding ID 与环境 | 来源绑定的地点和车型估价；不会创建真实行程 |
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
