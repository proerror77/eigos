# 美团跑腿只读接入（2026-10-15）

EIGOS 增加 `meituan.paotui.read`，通过已有 MCP/A2A 任务入口调用官方个人跑腿 CLI。仅允许 loopback 开发模式的固定开发身份，默认不启用；不适用于公网、多用户或商业生产环境。个人授权不得共享给其他会员。

## 开启与调用

先安装美团官方 [跑腿工具](https://github.com/meituan/MT-Paotui-For-Client)及其随附 pt-passport CLI，按官方流程完成本人美团账号授权。此次本机安装版本来源 commit `05ead232ae2b94b9b55b2a1e126e039a1cb6db00`，pt-passport 1.0.5。

在本机开发 `.env` 设置（要求原有 `EIGOS_AUTH_MODE=development` 与 loopback 绑定）：

```dotenv
EIGOS_PAOTUI_SKILL_DIR=/Users/proerror/.codex/skills/meituan-paotui
```

重启本地 EIGOS 后 `list_services` / Agent Card 会公布服务。MCP `submit_task` 参数：

```json
{"service":"meituan.paotui.read","goal":"{\"action\":\"authorization\"}","requestId":"unique-query-id"}
```

也支持 `{"action":"addresses"}` 和 `{"action":"search_address","keyword":"上海虹桥站","city":"上海"}`，作为 JSON 字符串传入 goal。A2A SendMessage 使用单个 data part，传同样的 service/goal；messageId 充当幂等键。MCP 返回 working 后用 get_task 查询；A2A 可等待结果或 returnImmediately 后查询。

返回 artifact.data.result 是只读业务结果。地址簿包含个人地址和姓名，只保存在本机用户拥有的任务库；电话脱敏。美团授权 Token 从官方本地缓存读取，不写入 EIGOS .env、任务、提示词、日志或输出；子进程错误统一处理，避免把原始凭据输出带入异常。

## 当前边界

- 操作白名单只有授权状态、地址簿、POI 地址搜索和费用预览。预览按地址簿 ID 在进程内解析联系人电话，不把真实手机号或预览 orderToken 返回给 Agent。
- 不向 Agent 开放真实手机号查询、提交订单、支付链接生成、支付或取消订单。
- 地址搜索不是餐厅菜单/商品搜索。
- agent.execute 仍为文档执行器；客户 Agent 需显式选择本服务，不能据此声称模型已获得任意外部工具。
- 非默认配置、已部署服务及公网实例没有被自动更新。

## 验证

`npm run check`、`npm test`、`npm run build`。

显式运行真实只读验证（临时 loopback 服务、内存任务库，无订单）：

```sh
EIGOS_PAOTUI_SKILL_DIR=/Users/proerror/.codex/skills/meituan-paotui node --import tsx examples/paotui-read.ts
```

2026-10-15 实际返回：授权获取成功；官方地址簿返回 10 条（未将明文地址归档为证据）；MCP 授权查询通过；A2A 上海虹桥站 POI 查询返回 20 条。真实订单 0，支付 0。上述证明只读接口及 EIGOS 链路可用，不证明下单、支付或履约能力已验证。

## 费用预览（2026-10-15）

通过同一服务提交以下 JSON 查询（作为 goal 字符串）：

```json
{"action":"preview","senderAddressId":"地址簿ID","recipientAddressId":"地址簿ID","goodsName":"文件","category":"文件","weightKg":1,"service":"ordinary"}
```

category 支持文件、快递、餐饮；service 支持 ordinary / express。仅接受授权地址簿中的同城地址。物品重量必须大于0、不超过50公斤。地址不存在、电话不可用、跨城或报价失败时返回失败，不会改为下单。

2026-10-15 本地 127.0.0.1:3000 已启动更新后的构建，使用实际 MCP Agent 客户端经过 submit_task/get_task 验证：授权成功，POI 搜索20条；两处本人同城保存地址、1公斤文件普通送报价52.5元、23.5公里。报价仅代表当时路线/时段，无订单、无支付。私有验证回执在 data/paotui-agent-verification.json（不进入Git）。实际25项测试、类型检查与构建通过。

## 后续订单准备

2026-10-15 已实现单独的待启用订单服务，当前生产下单与支付链接均关闭。见 [订单流程与验证边界](meituan-paotui-orders.md)。原 read 服务仍然只有查询/预览，不通过追加字段变成下单入口。
