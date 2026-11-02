# 飞猪 FlyAI 只读查询

`fliggy.travel.search` 将飞猪官方 FlyAI 的机票、酒店、万豪酒店和万豪套餐搜索接入共用 MCP/A2A 任务流程。EIGOS 的 Worker 通过官方 CLI 调用 FlyAI MCP，不把 FlyAI 描述为已兼容 A2A 的远程 Agent。查询返回来源候选及链接；不创建订单、支付、出票、锁座、兑换或确认入住。

## 来源与配置

使用官方 `@fly-ai/flyai-cli@1.0.16`，固定包版本和执行文件 SHA-256。签名由官方 CLI 完成，代码不复制它的默认体验凭据或签名秘密。执行时禁止隐式读取用户的全局 FlyAI Key，只使用明确配置的私有 Key 或官方体验模式。CLI 的可执行预加载检查固定 HTTPS 端点、准确工具与参数、账户、单次调用、响应上限、超时和取消；不使用 shell，也不继承模型、调试地址或签名覆盖变量。

Gateway/Worker 使用相同配置：

- `EIGOS_FLIGGY_MODE=disabled`：默认不注册能力。
- `EIGOS_FLIGGY_MODE=trial`：明确启用体验查询；不需要用户注册 Key，结果可能受限或隐藏价格，不产生推广归因。
- `EIGOS_FLIGGY_MODE=key`：正式 Key 配置路径；必须同时设置 `EIGOS_FLIGGY_KEY_FILE` 和 `EIGOS_FLIGGY_KEY_SHA256`。文件需为当前用户拥有、权限不超过 `0600` 的私有普通文件，指纹针对去掉首尾空白后的 Key。Key 不进入模型输入、工具参数、任务结果或日志；轮换需更改指纹并重启两端。
- 启用时必须设置既有 `EIGOS_PERSONAL_SOURCE_OWNER`，并遵守其 Foundation/JWT/隔离配置；具体安装仍需来源、任务、字段和模型通道授权。配置 Key 不自动授予 PA 调用权限。从体验模式切换正式 Key 或轮换凭据后，程序配置摘要发生变化，需按新摘要重新核对来源授权和 Pipeline 验证，不能继承旧连接的验证结论。

本接入使用运营方获准的来源连接；不在客户接入流程收取客户第三方密钥。当前实施不申请账号、签署推广协议、修改正式实例或代用户购买。

## 输入

```json
{"kind":"flight","criteria":{"origin":"北京","destination":"上海","depDate":"2099-01-01","seatClassName":"经济舱","journeyType":1,"sortType":3}}
```

`journeyType` 的 1/2 表示直达/中转，不表示单程/往返；往返由 `backDate` 表达。还支持航班号、中转城市、起降小时范围、最大飞行时长及价格上限。当前 CLI 不暴露乘客人数和成人/儿童票价组合条件，不能把返回价当作全家含税总价。

```json
{"kind":"hotel","criteria":{"destName":"上海","checkInDate":"2099-01-01","checkOutDate":"2099-01-02","sort":"price_asc"}}
```

普通酒店可附星级、酒店类型、床型、周边地点、关键词和价格上限。`kind=marriottHotel` 使用万豪酒店搜索；本固定版本 CLI 未将文档列出的 `hotelBrands`/`hotelName` 参数传给该工具，因此接入拒绝这些字段，避免“请求了过滤但实际上被忽略”。

```json
{"kind":"marriottPackage","criteria":{"provinceOrCity":"上海","hotelName":"指定酒店名","sortType":"price_asc"}}
```

套餐支持 `keyword`、`hotelName`、`provinceOrCity` 中至少一个字段，及价格升降序。所用 CLI 实际提供的字段比旧版参考文档多；接入按固定版本实际工具参数校验。关键词和名称匹配不构成已验证的目的地/酒店身份，也不证明日期可约。

## 返回和证据

- 航班保留航段、航班号、起降城市/机场/航站楼/时间、舱等、时长、来源价格和跳转链接。空航站楼等来源缺值保留，不推断时区或剩余库存。
- 酒店保留 `shId`/`shid` 来源身份、酒店信息、展示价和详情链接。两种不同 ID 同时出现且不一致时拒绝接受。
- 套餐保留 `itemId`、标题、卖点、权益描述、展示价及链接。`itemId` 是商品/SPU，不冒充 SKU 或房型 ID。
- `ticketPrice`、`adultPrice`、`price` 按来源分别保存。“￥499起/1晚”“¥4xx”不转换成确定数值或可订总价；不猜测税费、计价单位、入住晚数、退款或会员资格。
- `status=0,message=empty,data=null` 是明确空结果；失败、缺失列表及不符合合同的响应不能变成空结果成功。结果至多交付 10 项，始终保留 `completeness=partial`；体验提示和未知状态也保留。

结果通过 `FliggySearchObservation → FliggyTravelOption → HotelProperty/TravelProduct` 及 `SourceReceipt` 投影。`fliggySearchStatus` 检查来源、请求版本、范围及五分钟本地时效；它证明观察有效，不证明套餐 SKU、库存或预订成功。任务必须读取并评估自己已接纳的观察才能完成。

## Ontology Pipeline 与套餐 SKU

`packages/ontology/pipeline/fliggy-products.ts` 的 `prepareFliggyProductPipeline` 为既有 `TravelProduct` 规范投影生成未验证的 PipelineIntake。它固定程序/配置/动作摘要、来源材料、字段映射和夹具，可沿用草稿校验、独立任务证据、发布和失效机制。它不访问供应商、不修改权限，也不经另一个来源写入口生成重复身份。

FlyAI API Key 与传统淘宝 TOP 的 AppKey/AppSecret 不是同一种凭据，不能互换；获取 FlyAI Key 也不自动获得传统商品 SKU/房型详情接口资格，须按账号实际权限核验。

本阶段只映射来源 SPU；缺少原生 SKU、房型、组合明细和日期库存时保持未知。下一阶段套餐组合与优化的设计边界见[酒店套餐 Pipeline](../guides/hotel-package-pipeline.md)。

## 推广与佣金

官方 [推广者说明](https://flyai.open.fliggy.com/docs/partner) 当前规定：正式 API Key、实名认证和推广协议是推广者前提；体验模式不识别推广者、不计佣；大部分酒店及度假商品支持分佣，交通类暂不参与。支付成功后的预估佣金与交易完成后可提现收益分别记录。

公开说明没有给出通用固定费率。`commissionMoneyYuan` 是来源字段，缺失/null 不转换为 0；本版本所见 `rate` 缺少明确字段语义，不当作已确认佣金比例。具体佣金率、计佣基数、归因窗口、扣费和结算须通过正式推广中心或有权限的来源数据确认。平台收入不自动折算为用户返现，也不进入用户最低房价计算。

## 既有业务库升级

代码内核前向增加 v27，保留准确 v26 及更早版本；本分支不依赖未合并的 RollingGo 机票分支。启动不会自动激活本体或增加来源权限。

部署操作先停止 Gateway/Worker 并备份私有业务库，完成到准确 v26 的既有升级。Foundation 策略使用 `scripts/upgrade-fliggy-policy.mjs`，传入准确旧策略 digest/revision 预览，再显式 `--apply`；它保留既有角色的动作/函数列表和期限，不授予飞猪能力。

随后使用 `scripts/install-fliggy-readonly.mjs --database /absolute/private/tasks.sqlite` 预览，以返回的 active digest/generation 加 `--expected-digest`、`--expected-generation` 和 `--apply` 激活。正式权威需加载既有 `EIGOS_AUTHORITY_FILE`。仅接受准确前身，拒绝未知修改/并发代次变化，重复安装幂等。两端和新任务读取同一发布；旧任务继续固定原版本。本次开发没有执行正式迁移或部署。

官方参考：[FlyAI](https://flyai.open.fliggy.com/)、[官方 Skill/CLI 说明](https://github.com/alibaba-flyai/flyai-skill)。
