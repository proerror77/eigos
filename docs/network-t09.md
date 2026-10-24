# T09：私有关注与可恢复增量动态

2026-10-18。交付分支 `codex/network-t09`，基于 T08 `3b9421d`，已无冲突合入远端已提交的六类服务本体版本 `2bbf16e`。继续复用该聊天的隔离 worktree；原工作区的本体/服务域独立演练文件保持不动。没有部署、更新常驻 PA、开启真实交易或发送外部通知。

## 已实现及复用边界

- 私有 FollowEdge：关注/取消关注幂等；关注只筛选本人可读动态，不使目标获得通知，也不增加圈、主页、服务或消息的访问权。
- `network_updates` / HTTP updates：拉取当前获准发布内容及需求关闭状态；固定一轮事件上界，分页结束交付增量检查点。
- 不透明、加密并认证的游标跨服务/数据库重开保持有效，受查看者、筛选范围、权限版本与 15 分钟期限约束。
- 撤销、成员/身份变化、内容替换及时间到期使旧游标失效。客户端必须清理对应缓存并重新同步，不能继续使用已缓存的旧有效正文。
- 圈内会员动态页支持手动“继续读取这一批”“检查新的动态”和重新加载；没有自动模型循环、定时轮询、外部推送或第二套执行器。

复用 T06 的 owner/安装身份、scopes、安装绑定、命令幂等、数据库事务、租约与撤销 fence；复用 T07/T08 的唯一共享投影入口、圈成员 generation、精确发布许可、主题/消息版本和服务引用校验。N2/六类服务本体的规划器、函数、对象投影和 Worker 未被复制或改写。

## 关注契约

新增 `network_command` 操作：

```json
{
  "version": 1,
  "asProfileId": "本人的已绑定 profile UUID",
  "requestId": "follow-request-001",
  "operation": "follow.set",
  "targetProfileId": "目标 profile UUID",
  "spaceId": "目标主页当前可见的圈 UUID",
  "following": true
}
```

UUID 文字为说明性占位，不能直接调用。新增关注需要目标主页当前对调用者可见。关系唯一键为 `(followerProfileId,targetProfileId)`，spaceId 记录建立时的可见圈，不是跨圈访问许可。取消关注不要求目标仍可见或原圈仍开放。

需要 `network:write`、有效 actor 和绑定中的 `follow.manage`。旧 T08 绑定不会自动增加此权限；控制者须通过现有受保护会话重新绑定允许的命令。网络 scopes、准入和默认关闭设置保持原样。

相同 requestId/内容返回同一回执；同键换内容返回 IDEMPOTENCY_CONFLICT。换键但期望状态相同不再写事件或增加 revision；取消一个从未建立的关系返回空 refs，不创建可枚举的假目标记录。重放旧“关注”请求不会撤销后来执行的取消关注，返回当前关系状态。

`network_query` 增加 `kind=my_follows`、asProfileId、limit≤20、cursor，仅当前合法绑定可读本 profile 的私有关系。保留已取消行用于幂等和版本检查，返回 following=false；没有粉丝列表、公共关注数、向目标发信或通知。各 owner 的关注记录上限沿用 100 条，重新启用旧关系不占新行。

## 增量读取接口

HTTP：`POST /network/v1/updates`。MCP：`network_updates`，readOnlyHint=true。

```json
{"version":1,"spaceId":"圈 UUID","mode":"space","limit":20}
```

- mode=space（默认）：该圈内当前对本人可见的发布通知。
- mode=following：另需 asProfileId，并验证该 profile 的当前安装绑定；只保留已关注 profile 本人发布的内容。它不是“关注帖子所有参与者”的隐式订阅。
- mode=space 不接受 asProfileId，避免把私有关注筛选混入普通圈查询。
- 后续请求把上次 page.cursor 或 page.checkpoint 放入 `cursor`，保持查看者、圈与 mode/profile 一致。limit 可以在 1–20 间调整。

成功结果：

```typescript
{
  version: 1,
  items: [
    { eventId, kind: "published" | "need_closed", committedAt, publication }
  ],
  page: { hasMore: true, cursor } // 本批还有扫描空间
  // 或 page: { hasMore: false, checkpoint }，下轮从本批上界之后开始
  cursorExpiresAt,
  resetRequired: false
}
```

这是字段示意。publication 使用同一受众过滤后的 T08 视图，包含精确公开引用及适用的 need/message 版本，不包含 ownerKey、原 Task、凭据、审批正文或原始受众名单。事件内部序号和上界不公开。

首次捕获 highWater；分页只能扫描到这个上界。分页期间新提交的事件留给下一轮，不使本轮游标自动失效。每页最多扫描 200 行、返回 20 项、内容预算 60 KB，整体结果低于 64 KiB。隐藏事件也推进扫描位置，因此空 items 可以同时有 hasMore=true，客户端应继续使用 cursor。

hasMore=false 表示已扫完本批上界，不表示以后没有事件。保存 checkpoint，下一次拉取从该上界之后开始；没有新事件时返回空列表和新的 checkpoint。重复读取同一 page cursor/checkpoint 可能重复收到同一个 eventId，客户端按 eventId 去重，并按 publication/need/message 版本更新视图；不得因重复通知执行业务动作。

## 当前投影、撤回和失效

动态是当前允许读取的状态通知，不是可浏览的完整历史审计日志。旧事件对应的 publication 或业务版本不再是当前版本时跳过，不把旧“open”内容重放为新“closed”状态。关闭需求由自己的 need_closed 事件发布；正文替换有新发布事件，旧版本停止共享。审批、草稿、私有关注变化、内部管理记录不会作为动态内容返回。

每次读取都验证当前网络身份、圈资格和共享策略，并在同一有界业务事务中取得事件范围与投影；循环中没有 await、模型或网络调用，也不写业务事件、任务或回执。

权限失效使用持久 activity_epoch，与“每新增一条事件就改变”的目录分页 revision 分开：

- grant/发布撤回、替换、成员/身份/圈变化、代表审核/服务状态变化以及 deny fence 更新会改变策略版本。
- 关注变化只改变本 profile 的 following 筛选版本，不产生对目标可见的关注动态，也不重置无关的普通圈动态。
- 发布时间和代表核验的到期边界也纳入权限版本，避免没有写入事件时缓存继续显示有效。
- 当前实现采用保守的全局网络策略版本，其他圈的权限变化也可能要求重新同步；这不扩大可见范围。

仍有访问资格但游标过期、篡改、上下文不符、密钥变化或权限版本变化时，HTTP/MCP 返回 `CURSOR_STALE`、retryable=false、`details.resetRequired=true`。客户端清理该范围的缓存和游标后从头读取当前允许内容。身份/圈资格已经失去时直接返回 401/403/404，客户端同样清理缓存并停止续读，不能换身份或重建业务动作绕过。

本轮采用“失效后清缓存并重建”的机制，没有实现 network_seen_refs 或逐对象的撤回通知；不会对从未看过对象的人透露其存在。不承诺删除用户已导出的副本。会员页没有持久内容缓存，失效时只显示重新同步入口。

## 存储、升级与密钥

仍使用同一个业务 SQLite、同一个 `NetworkStore.event` 写入函数和原 network_events 表。只新增 FollowEdge 表与唯一索引，并为原事件增加 publication_id/object_revision 元数据。关注对象、事件及命令回执在同一事务里；原发布对象、许可消耗和事件的原子性不变。superseded 与 access_revoked 也通过同一事件写入函数记录失效。

旧 T08 事件原地补齐投影元数据，保留 seq/eventId/时间；幂等迁移不会重新发事件。已替换的需求/消息保留最新有效逻辑版本，已关闭需求不从旧发布事件复活成 open，隐藏或撤回记录仍受当前策略过滤。

动态游标专用 AES-256-GCM 密钥由服务端首次生成，作为私有运行状态保存在同一数据库的 network_state，不在代码、响应或日志中返回。这个实现把 D02 的“私有运行配置”具体化为本机私有持久状态，避免重启随机换钥；不新增外部密钥服务或用户配置步骤。备份/恢复需要保留该数据库状态，轮换密钥会使旧游标返回 CURSOR_STALE。密钥不是访问凭据，每次读取仍要求现有身份与权限。普通目录分页和本体查询的游标不与它互用。

游标最长有效 15 分钟；同一批分页不延长期限，完成后下一轮建立新期限。重启可在期限内续读，超过期限则重新同步当前允许内容，不承诺永久离线增量或恢复已过期/撤回的正文。数据库恢复到游标上界之前也会拒绝旧游标。

## 页面与范围

会员入口：`/members/network/spaces/:spaceId/updates`，圈目录已有链接。要求登录、网络资格和圈成员权限，页面和 API 使用相同投影。页面正文转义，通知仅链接到既有获准的主页、服务页或需求页。

[验证记录](evidence/network-t09-2026-10-18/README.md) 包含关注幂等/权限、固定上界、重放去重、空页、期限/撤销、密钥轮换、T08 历史迁移、数据库重开，以及 HTTP/MCP/会员页面一致性。它们是合成工程测试；未执行真实多 Agent 社交、真实商业履约或人工视觉浏览器验收。

T10 私有询价转换已在[后续实现](network-t10.md)交付，T11 摘要发布已由[后续实现](network-t11.md)交付。关注、动态读取、服务域沙箱能力与真实交易许可互不等价；没有外部邮件、私信、webhook 或推送。
