# T11 获准摘要工程验证

2026-10-18。隔离分支 `codex/network-t11`，接续 T10 `d729913`，已合入 `1650545` 本地 UCP 接入及最新 `aa50b2a` Shopify 只读准入探针。原工作区文件未改动。

## 最终本地检查

| 检查 | 结果 |
| --- | --- |
| npm run check | 通过 |
| npm test | 423 tests / 423 pass / 0 fail / 0 skipped |
| npm run build | 通过 |
| npm run test:e2e:run | 8 tests / 8 pass / 0 fail / 0 skipped |
| git diff --check | 通过 |

T11 新增 15 项结果/权限/事务/隐私/恢复测试和 1 项 HTTP/MCP/会员页面联调。全量回归包括 T06–T10、本体、UCP 与新 Shopify 准入模块。最终本机全套约 14.1 秒，进程套件约 13.1 秒，不作为生产性能结论。最终提交 SHA 的 CI 终态另在交付消息中回读。

## 可观察结果

- 本人已有查询结果可生成私有卡片；未批准时其他成员搜索为空。外部主体不能引用他人的 Task 生成摘要。
- 客户端添加 body、safeSummary 或 evidenceLevel 等字段被严格 schema 拒绝；等级和摘要来自服务器受控投影。
- 获准共享恰好七个字段：serviceKind、observedOn、timeZone、resultKind、outcome、evidenceLevel、safeSummary。
- 私有 Task/inquiry/回执 ID、原始目标、精确地址、订单标记、凭据、邮箱、URL、ownerKey 没有进入共享详情、列表、动态或 HTML；网络事件只出现随机公开卡片/发布引用。私有验收 reason 和凭据夹具的注入不被自由摘要或拼接。
- fixture 来源为 synthetic_validation；把内部反馈标签改成 live_fulfillment 不能升级它。带 live_readonly 标记的受控形状夹具只用于验证 live_query 判别，结果仍明确不代表订单/付款/履约。
- 本地 UCP mock 商家实际执行一次测试 checkout 和一次测试 completion，卡片始终为 simulated_execution；共享内容不含 merchant ID、checkout/order ID、地址或模拟支付 token。没有真实购买、付款或交付。
- 本地 brief 完成显示 local_generation/local_artifact，不把原始业务目标写为已完成。未完成工作拒绝生成 result 卡；取消状态和参与者声明不会变成成功履约。
- 同一个 owner/Task 经 Task/inquiry 两种引用回到一个 cardId；换 profile 不能复制。并发/重复发布只产生一个当前共享，其他批准草稿不能绕过重复检查；未开放总分/全局计数。
- 任务/反馈纠正使旧卡详情不可读，旧 feed checkpoint 返回 CURSOR_STALE。刷新后必须用新卡片版本及新许可显式替换，旧公开版本不再返回。
- 单独修改 SourceReceipt 摘要会阻止待发布投影；重新生成后只能得到证据不足，不能继续保留 query_completed。
- 最新行动观察改变但旧 Task 仍为 completed 的反例，旧卡和缓存失效；刷新不会把旧验收状态当成当前证明。
- tasks:read 丢失后，准备、草稿重放、私有预览和回执读取不能旁路；原安装绑定撤销、许可撤销、错误 CSRF 和受众不符均拒绝。
- 撤回/撤销后共享不读旧正文，旧回执只给不可用状态；同圈已批准但未发布的重复草稿不能复活已撤回卡片。新的明确批准可再次共享同一逻辑卡。
- 在 published 事件写入点注入失败，发布对象、grant 消耗和网络回执一并回滚；恢复后原键只成功一次。
- 重开数据库和服务仍使用原 cardId；准备、批准、发布、读取和撤销不增加提供者调用次数，不运行模型、不改变私有 Task 或开启新业务。
- HTTP/MCP 和会员目录/详情/动态页使用同一投影。只有 network:read 的获准接收者可以读共享字段，但不会因此取得作者的私有任务权限；发布者也不能绕过自己设定的受众。

## 证据性质

全部主体、来源和模型均为隔离测试夹具；UCP 使用本机 mock 线协议商家。测试中的 live_readonly 形状在临时数据库中构造，**不是实际外部查询**。本轮没有真实履约材料；live_fulfillment 的充分证据门槛不得被描述为已经通过生产/真实履约实测。

真实运行的是本地 SQLite/权限/发布事务、已有 Worker/结果投影代码和 HTTP/MCP 路由。页面验证为 HTTP/HTML 断言，未做人工视觉浏览器验收。新增源写入失效机制复用可见性版本，不把私人数据写进共享事件。

没有部署、实际 OAuth 扩权、新商户接入、真实来源调用、真实交易或外部通知。网络继续默认关闭。

## 复查入口

- [结果与隐私回归](../../../tests/network-evidence.test.ts)
- [协议及会员页面联调](../../../tests/network-gateway.test.ts)
- [实现与等级门槛](../../network-t11.md)
