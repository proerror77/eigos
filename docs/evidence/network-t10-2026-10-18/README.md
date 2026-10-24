# T10 私有询价与方案工程验证

2026-10-18。隔离分支 `codex/network-t10`，继承 T08/T09，并已合入最新本体提交 `70aaa12`。原工作区在途改动未被覆盖；本轮没有部署或真实交易。

## 最终本地检查

| 检查 | 结果 |
| --- | --- |
| npm run check | 通过 |
| npm test | 380 tests / 380 pass / 0 fail / 0 skipped |
| npm run build | 通过 |
| npm run test:e2e:run | 8 tests / 8 pass / 0 fail / 0 skipped |
| git diff --check | 通过 |

T10 新增 19 项领域/执行/恢复测试和 1 项 HTTP/MCP/A2A/会话页面联调测试。完整套件包括新本体业务角色、六类服务域和 T06–T09 回归。最终本地运行约 11.4 秒，进程测试约 13.3 秒，仅为该次本机运行耗时。最终提交 SHA 的 CI 状态在交付消息中另外回读，不用旧提交 CI 代替。

## 已观察到的行为

- 准备选择不创建 Task、不访问报价来源。没有买方确认、错误摘要、其他会员批准、过期或撤销的选择均不能转换。
- 会话页面显示准确私有目标/所选来源；HTTP bearer 无法批准，错误 CSRF 拒绝，运营审核员没有批准他人私有选择的旁路。页面中的脚本标签被转义。
- 同一需求的两个已确认选择、两个安装和重复命令只建立一个 inquiry/Task。不同私有目标不能隐式重选。帖子撤回后仍能回读原关联，供应方不能读取买方 Task。
- 事件插入故障使 Task、N1 ServiceRequest、来源上下文、Inquiry、choice 消耗和命令回执全部回滚；恢复后原键只成功一次。
- 同库内部提交没有嵌套 BEGIN。缺少受控事务时拒绝；缺少较新 Node 原生事务状态 getter 的连接接口也能正确提交/回滚。这是兼容接口测试，不是另启动旧版 Node 的运行证明。
- 私有 buyerGoal 保持原文；帖子摘要和 SELLER_INJECTION_CANARY 不进入 Task 用户消息。provenance 只保留受控引用，正文 URL、伪造 adapter/授权字段不成为来源。
- 关联 input-required Task 保留原目标、消息和问题，增加版本并保持等待；原 reply 接续。已有领取、working、终态、其他 owner 和旧版本拒绝。
- 原 Coordinator/Resolver/ActionRuntime 在限制目录中完成两次合成只读查询，未触及旁边登记的备用绑定。恶意模型选择 brief 等其他能力被拒绝。
- 来源在读取途中暂停时，真实本地 Worker 拒绝迟到结果，不生成报价投影，不开始第二次读取。取消与租约丢失同样阻止迟到投影，保留原终态/失败行为。
- 配置摘要变化在 Worker 首次来源读取前拒绝。报价变化沿原 ReplanRequired 在同一个 Task/来源重新核验；旧价格不能继续作为当前选择。
- Gateway/Worker 使用重新打开的业务数据库连接恢复到原 inquiry/task/source，未生成第二单，原只读来源限制保持。
- 成功报价使用原 projectReadResult/projectTask，能够读回 DeliveryQuote、路线/包裹和 synthetic SourceReceipt；没有第二个报价映射。
- reviewed 不生成 Proposal；Proposal 需准确版本和硬前置条件成立，按既有本体关系写入不可变选择。Task/ExecutionPlan 不被重开或改写，无 Authorization/Payment/Order。
- 费用覆盖 unknown 时预算仍 unknown：reviewed 可保存，Proposal 被拒绝。过期/修改报价或要求版本不符不能选；历史选择显示 current=false。
- 最新本体角色保留在检查记录中，passenger_count 不用报价重量证明、deposit 不用总价证明；未映射角色保持 unknown。
- 在 quote_selected 事件插入点注入错误，Proposal、selectedProposal 关系、选择快照及 choice 消耗一并回滚，原键可恢复且只提交一次。
- HTTP/MCP 并发转换回到同一 Task；原 A2A GetTask 能继续读取完成的合成查价，其他 owner 被拒绝。公共动态不包含私有目标、Task ID 或私有报价。

## 证据性质与限制

身份、服务登记、代表审核、模型决策、报价回执和允许访问合成主体的 adapter 均为 fixtures。Worker、SQLite 事务、状态机、权限、HTTP/MCP/A2A 和本体投影使用实际实现；因此证明工程路径，不证明真实会员权限、商家资格、真实报价或履约。会员页面验证是 HTTP/HTML 断言，不是人工视觉浏览器验收。

当前只接已有 delivery.quote@1/@2 的受控配置绑定。未新增通用发现来源报价、商户接口或真实权限；个人美团适配器仍限制原本机身份。没有真实 PA 调用、来源 CLI 请求、订单、预订、付款、退款、外部通知或部署。

## 复查入口

- [T10 主回归](../../../tests/network-inquiry.test.ts)
- [合成来源/模型夹具](../../../tests/fixtures/network-inquiry.ts)
- [协议与会话联调](../../../tests/network-gateway.test.ts)
- [实现说明](../../network-t10.md)
