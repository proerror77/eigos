# 支付与淘宝查询接入

这四类供应商通过同一 Ontology、任务、授权和 Worker 执行路径供 MCP／A2A 使用。默认全部关闭。当前实现只查询已有商户交易或商品，不创建订单、签约、付款、退款、关单或发送短信；也不读取 PA 钱包凭据。

| 供应商 | 能力与 Action | 执行入口 | 当前范围 |
| --- | --- | --- | --- |
| 支付宝 | `alipay.trade.query` / `QueryAlipayTrade` | 官方 `@alipay/mcp-server-alipay` 的 `query-alipay-payment` | 按原商户订单号查单 |
| 微信支付 | `wechatpay.trade.query` / `QueryWechatPayTrade` | EIGOS 普通商户 APIv3 适配器 | 商户订单号查单；请求签名、应答验签 |
| 银联 | `unionpay.trade.query` / `QueryUnionPayTrade` | `unionpay-mcp-server` 的 `query-unionpay-payment` | 直连商户，保留原订单号与交易时间 |
| 淘宝 | `taobao.catalog.query` / `SearchTaobaoProducts`、`GetTaobaoProducts` | TOP 官方 HTTPS API | 淘宝客商品搜索、指定商品详情 |

供应商工具与参数来源统一在 [`payment-commerce-readonly.json`](../../packages/ontology/definitions/payment-commerce-readonly.json)。其中微信、淘宝的 `server` 是 EIGOS 的逻辑适配器身份，不表示供应商另有官方 MCP 服务。Skill 是开发接入知识与流程，不能单独作为业务执行器或权限。

## 资格与边界

- **支付宝**：需要商户应用及匹配的私钥、支付宝公钥。已有的开放平台 CLI 登录与应用查询权限不能替代交易 API 资格。商户查询 MCP 与支付宝 AI 付 Skill 的商户入驻／收款流程分别管理。
- **微信支付**：本适配器只支持普通商户 APIv3 查单，验签使用已配置的微信支付公钥与公钥 ID；不是合作伙伴代查模式。链接中的 AI 支付还需要 SkillHub 企业入驻、SkillPay、商户 Skill、支持微信 AI 支付的宿主工具等条件，本实现没有启用 AI 专属卡、x402 下单或消费侧钱包操作。TypeScript 适配器是依据官方文档编写的参考实现，非微信官方维护的 SDK。
- **银联**：需要直连商户身份、业务权限、签名证书和验签证书。查询结果保留来源的 `responseCode` 与 `sourceTradeState`，不把签约／支付／退款等原交易的状态统一解释成“已付款”。返回中的 token、银行卡及持卡人信息被丢弃。
- **淘宝**：有[官方开放平台](https://open.taobao.com/)。当前连接淘宝客 API，需对应 AppKey、AppSecret、API 权限及搜索所需推广位。它不是淘宝全站无限制搜索或消费者自动购买授权，也不自动复用飞猪应用权限。返回价为观察时参考价，库存、邮费和结算总额不保证。

## 私有配置

Gateway 与 Worker 配置相同的 `EIGOS_PERSONAL_SOURCE_OWNER` 和以下所需变量：

```dotenv
EIGOS_ALIPAY_CONNECTION_FILE=/absolute/private/alipay-connection.json
EIGOS_WECHATPAY_CONNECTION_FILE=/absolute/private/wechatpay-connection.json
EIGOS_UNIONPAY_CONNECTION_FILE=/absolute/private/unionpay-connection.json
EIGOS_TAOBAO_CONNECTION_FILE=/absolute/private/taobao-connection.json
```

不使用的供应商不设置。连接与凭据文件必须是当前用户拥有、单硬链接、权限为 `0600` 的普通文件；不接受符号链接。运行配置要求已绑定来源 owner 的 Foundation／JWT、loopback 监听与 HTTPS origin；生产环境还须匹配正式运行权威。不向邀请制文档测试开放。源权限、安装身份、任务数据许可、Action 权限仍分别检查；配置文件不授予这些权限。

每家连接文件结构如下，以淘宝为例：

```json
{
  "version": 1,
  "provider": "taobao",
  "environment": "production",
  "credentialFile": "/absolute/private/taobao-credential.json",
  "credentialSha256": "<凭据文件原始字节的 SHA-256>"
}
```

支付宝额外需要 `mcpScript` 与 `mcpScriptSha256`，指向已安装并核验的官方包 `dist/index.js`，且必须明确选择 `production` 或 `sandbox`。银联也需要这两个字段，当前只支持 `production`。MCP 程序必须是当前用户拥有、不可由组／其他用户写入的普通文件，运行前检查指纹。运行期间不执行 `npx`、不下载依赖、不接受模型指定的命令、地址或路径。

已对照的发行版为 `@alipay/mcp-server-alipay@2.0.0` 和 `unionpay-mcp-server@1.0.6`。安装时核对官方来源并锁定发行版和依赖；SHA-256 由实际安装文件计算，不能复制示例指纹。不要在业务仓库提交这些运行时文件或凭据。

凭据 JSON 字段如下：

| 供应商 | 字段 |
| --- | --- |
| 支付宝 | `AP_APP_ID`、`AP_APP_KEY`、`AP_PUB_KEY` |
| 微信支付 | `merchantId`、`merchantCertificateSerial`、`privateKeyPem`、`platformPublicKeyId`、`platformPublicKeyPem` |
| 银联 | `UP_MER_ID`、`UP_SIGN_CERT_PWD`、`signingCertificateBase64`、`validationCertificates`；可选 `UP_TR_ID`、`UP_TOKEN_TYPE: "01"` |
| 淘宝 | `appKey`、`appSecret`、`adzoneId`（字符串，保留精度） |

微信的 `merchantCertificateSerial` 是商户 API 证书序列号，`platformPublicKeyId` 是微信支付公钥 ID，两者不能混用。请求通过 `Wechatpay-Serial` 明确选择已配置公钥签名的应答；商户订单号保留合法的 `|`、`*` 等字符。私钥与公钥均要求 RSA 至少 2048 位。

银联 `validationCertificates` 为 `[{"name":"root.cer","base64":"<证书文件字节的 Base64>"}]`。每次调用将证书写入独立私有临时目录，只向子进程传入当前供应商所需字段；固定 `UP_ACCESS_TYPE=0`，限制可用工具并将日志留在临时目录，结束即清理。支付宝同样只开放查单工具，并关闭其日志。调用方不能提供工具白名单、交易地址或其他环境变量。

配置或凭据变化会使原绑定失效。需让两个进程加载一致的新配置，再为后续任务重新取得来源许可；不能靠替换私钥文件让旧任务继续执行。

## 查询输入

```json
{"action":"QueryAlipayTrade","parameters":{"outTradeNo":"original_order"}}
{"action":"QueryWechatPayTrade","parameters":{"outTradeNo":"original_order"}}
{"action":"QueryUnionPayTrade","parameters":{"orderId":"originalorder","txnTime":"20261103120000"}}
{"action":"SearchTaobaoProducts","parameters":{"query":"雨伞","page":1,"limit":10}}
{"action":"GetTaobaoProducts","parameters":{"itemIds":["123","456"]}}
```

一次任务固定一家供应商、一个 Action 和准确参数。后续执行只提交已绑定的任务 `scope`，不能临时替换订单号、商户、查询词或商品 ID。淘宝详情支持最多 20 个显式 ID：全部为数字时使用比价场景 `2`，包含动态 ID 时使用场景 `1`；来源返回新别名时用 `input_num_iid` 与原输入精确关联。搜索单页最多 20 条；不做隐藏分页或跟随商品链接。

来源响应仅投影必要的交易状态、金额或商品数据。金额保留来源单位：微信使用整数分，支付宝和淘宝使用元的十进制字符串。银联的来源金额保留原样与 `provider_reported` 单位，不参与跨来源金额计算。支付宝沙箱回执标记为 `provider_mock`，注入夹具为 `synthetic`，均不提升成生产查询证据。观察的本地有效窗为五分钟，不代表报价承诺或供应商承诺。

## 配置检查与验证

```sh
node --env-file-if-exists=.env --import tsx examples/payment-commerce-status.ts
```

该命令只检查本机配置，不联系来源。`not_configured` 表示未配置，`configuration_invalid` 表示文件、字段或指纹检查失败，`configured_unverified` 表示配置检查通过但没有真实来源回执。它不会返回已连接、已付款等状态，也不输出凭据或私有文件路径。

合成测试覆盖真实 MCP 子进程接线、APIv3 签名与应答验签、精确订单身份、来源拒绝、响应大小、凭据变更、取消、隐私投影与原任务验收。合成通过不能替代真实商户联调。真实 APIv3 echo、商户权限、证书有效性、主备切换及现有订单状态仍需相应环境与凭据验证；本实现不提供支付／回调链路，不能据此宣称微信 AI 支付或资金链路通过上线验收。

## 本体发布与旧库

新建数据库使用 v27 内核。旧库启动不会自动激活新本体，也不会改变已有任务的 release：

1. 在离线备份上检查当前 namespace 与 generation，调用 `DefinitionStore.installPaymentCommerceReads(active, generation)` 预先验证追加发布。它仅添加两类技术对象、五个只读 Action 及其关系／状态函数，拒绝覆盖不同的已有定义。
2. Foundation 的 v26 权限合同须在 Gateway／Worker 停止、无有效领取／待处理授权栅栏时，使用 `upgradePaymentCommercePolicy` 的原 digest 和 revision 先预览，再应用。入口同时识别有限期与“撤销前有效”的既有合同，保持相同模式并原样保留原授权与到期时间，不授权任何新供应商 Action，也不将有限期授权转成长期授权。其他旧版本应先沿已有命名迁移逐步升级。
3. 核对本体 release、权限合同和相同的 Gateway／Worker 配置，再为明确的 owner／安装授予所需查询权限。已有任务继续读取原 release，不自动重放查询。

代码 PR、离线迁移验证和正式实例部署分别交付。没有正式部署与来源回读时，只能说执行接线已实现，不能说线上已经接通。

## 官方依据

- [支付宝 MCP 服务](https://opendocs.alipay.com/open/0h3gdq)、[官方 MCP 包说明](https://www.npmjs.com/package/@alipay/mcp-server-alipay)
- [微信 AI 支付介绍](https://pay.weixin.qq.com/doc/v3/merchant/4035576700)、[开发接入准备](https://pay.weixin.qq.com/doc/v3/merchant/4035576711)
- [微信支付接入 Skill](https://github.com/wechatpay-apiv3/wechatpay-skills/blob/main/wechatpay-payment-integration/SKILL.md)、[商户订单号查单](https://pay.weixin.qq.com/doc/v3/merchant/4012791880)、[请求签名](https://pay.weixin.qq.com/doc/v3/merchant/4012365337)、[公钥验签](https://pay.weixin.qq.com/doc/v3/merchant/4013053249)
- [微信支付公钥切换与请求头](https://pay.wechatpay.cn/doc/v3/partner/4012925289)、[微信订单号字符规则](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)
- [银联 MCP 智能支付服务](https://open.unionpay.com/tjweb/solution/detail?solId=613)、[MCP 包说明](https://www.npmjs.com/package/unionpay-mcp-server)
- [淘宝客商品搜索](https://developer.alibaba.com/docs/api.htm?apiId=35896)、[商品详情](https://developer.alibaba.com/docs/api.htm?apiId=24518)
- [淘宝动态 ID 的场景限制](https://developer.alibaba.com/support/hotProblemDetail.htm?id=696172&source=search)
