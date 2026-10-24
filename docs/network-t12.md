# T12：最小界面与协议一致性

2026-10-19。接续 T11 `54904cb`，已核对 `origin/main` 为 `aa50b2a`，后者已包含在基线中。复用现有圈、资料、需求、私有询价、Task、EvidenceCard 和控制面；没有新增业务状态机、部署或真实交易。

## 四个视图

| 入口 | 行为与边界 |
| --- | --- |
| `/members/network/workbench` | 本人的任务（每页 20 条）、私有询价、草稿、发布状态及摘要预览；邀请圈入口。草稿与发布分列，预览有效不等于获准共享 |
| `/members/network/spaces/:spaceId` 及已有详情页 | Agent 主页、服务目录、需求与回应、固定字段摘要、可恢复动态；继续使用相同受众与来源校验 |
| `/members/network/inquiries/:id` | 本人的原 Task 链接、来源是否仍可核验、选择快照、报价条件与未知项；过期或来源／要求变化的选择明确失效 |
| `/members/network/tasks/:id` 与 `/members/network` | 本人任务状态、问题、交付物、由 T11 证据规则计算的等级；身份绑定、精确批准与撤销继续使用原控制面 |

任务页刷新保留原 Task ID。页面使用转义的文本展示交付物，不执行其中的 HTML 或外部链接。已完成状态与目标验收、业务履约分开。读取页面不创建 EvidenceCard、许可、模型调用或来源请求。

原生页面沿用黑白样式，导航可换行、长文本换行、输入有标签及焦点提示。没有品牌重设计。

## 会员会话与 Agent 权限

新增网页入口只接受已准入且有效的本人会员会话。owner 由受信会员的 issuer／tenant／subject 派生；参数不能指定 owner，也不会伪造安装 actor。会员可查看自己的任务，与 Agent 读取同一 TaskService 数据。圈内内容继续经 NetworkService 的现有可见性规则。

网页补问使用 `POST /members/network/tasks/:id/reply`，仅支持本人任务的文字回复（最多 500 字符），需要同源 Origin、会话 CSRF、requestId、页面上的 expectedRevision 和 expectedUpdatedAt。它调用原 TaskService.reply；版本检查还在原写事务锁内复核，防止 Worker 在页面检查后更换问题。重复提交不会重复追加回复，旧页面冲突需刷新。

此入口不提供执行许可、下单、付款、任意 Action 或来源写入。auth-required 状态拒绝普通回复。Agent 继续使用现有 reply_to_task／A2A SendMessage，无须依赖 GUI；控制者批准发布与准确选择仍按原规则使用可信会话。

浏览器实测发现任务页继承 no-referrer 时原生表单会发送 Origin:null。现已为网络会员页设置 same-origin，沿用会员批准页做法，保留严格 Origin/CSRF 检查，不接受 null 或放宽跨域。

网页对不存在／撤回／过期内容、权限不足、旧游标、版本冲突和错误输入提供可读反馈。待批准内容当前失效或选择已过期时不显示可继续批准的按钮。HTTP/MCP 的机器错误格式保持不变。

## 验证与限制

[本轮联合记录](evidence/network-t12-t13-2026-10-19/README.md) 包含浏览器实际补问提交／刷新截图，以及网页、HTTP、MCP、A2A 同任务读回、跨 owner 拒绝、CSRF、旧问题竞态、报价失效和摘要撤回。

测试身份、模型决策和来源为合成材料。真正运行的是本地 Gateway、Coordinator、SQLite、协议与浏览器。它不证明真实 PA／渠道资格或履约；第一阶段完整验收仍见 [T13 门槛](network-t13.md)。
