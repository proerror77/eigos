# T08：需求发布、结构化回应与一跳推荐

2026-10-18。基于 T07 `4a57018`，交付分支 `codex/network-t08`。已核对远端 N2 最新已提交版本仍为 `bdb1ea2`，本分支已包含该版本与 T06/T07；原工作区正在进行的本体、规划和能力改动未复制、覆盖或提交。本轮没有部署、更新常驻 PA、开放公网功能或开启真实交易。

## 本轮能力

- 需求使用现有 `draft.create/update → publication.request_approval → 控制者 approve → publication.publish`。草稿是私有预览；没有发布许可不能共享。没有新增读取私有 Task、自动摘要或模型调用入口，助手只能提交允许的摘要字段。
- NeedPost 具有稳定 postId、当前 publication、内容版本和 open/closed/withdrawn 状态。过期由时间派生。关闭停止新回应，已批准且未到期的历史仍对原受众可读；撤回停止共享。
- 回应、问题、回答、讨论、推荐和服务引用全部使用相同的精确内容批准流程。自由文本不具有授权效力，不改变买方原始需求、PlanGrant、任务或执行状态。
- 推荐仅引用一份已审核且已获准共享的服务页。无可用 binding 的服务仍是“仅介绍”。推荐不调用来源、不邀请新成员、不转发原帖，不接受外部执行 URL，也不允许“推荐另一条推荐”。
- 默认一个需求最多三个不同会员的候选响应者，每位响应者最多两次澄清提问；到限额返回需要人工处理的明确错误。
- 需求搜索、主题详情、分页回应、HTTP、MCP 和会员页面共用相同的读取权限。没有开放任意对象查询、跨受众计数或私有任务导航。

这些是封闭试点工程能力。验证使用合成身份、需求和服务登记，不证明真实商户资格、真实 PA 协作效果、查价、交易或履约。

## 复用与数据责任

复用 T06 的身份归因、安装绑定、network scopes、会话/同源/CSRF 批准、单次 PublicationGrant、幂等回执、撤销 fence 和数据库租约。复用 T07 的圈成员 generation、受众快照、代表审核和服务详情过滤。

新增 `NetworkCollaboration` 只负责主题状态、引用校验、结构化消息和限额。它没有 TaskService、模型、提供者或执行器访问权。N2 的规划循环、对象函数、任务投影和 Worker 状态机均保持原职责。

`network_needs` 保存主题状态、当前发布引用及持久协作计数；`network_messages` 保存稳定消息身份、当前发布引用及已回答关联。正文仍只来自既有 draft/publication，不增加第二份可自动同步的公开正文。网络继续与 JobStore 共用业务 SQLite 连接。

发布对象、主题/消息引用、限额消耗、grant 消耗、已有 `network_events` 与命令回执在同一个事务中提交。故障注入验证所有这些写入一并回滚；没有新建第二条事件写入路径或外部消息队列。

T06/T07 的旧 need publication 在打开数据库时幂等补齐 NeedPost，postId 使用原 publication ID；原内容、许可、受众和截止时间保持。没有扩大旧许可。旧主题如果未将需求方本人纳入受众，就不能接收发回需求方的共享回应；需要通过精确批准的替换发布把自己加入受众。

## 当前接口

继续复用 `/network/v1/commands`、`/query`、`/receipts/get` 和 MCP `network_command`、`network_query`、`network_get_command`。写入固定 `version=1`、`asProfileId`、`requestId`；actor 始终从验证过的安装派生。

| 输入/操作 | 当前行为 |
| --- | --- |
| `draft.create/update`，content.kind=need | 原有 title/safeGoal/category/coarseArea/replyDeadline；增加可选 timeWindow（明确时区的 start/end）与 quantity |
| `draft.create/update`，content.kind=message | 下列严格消息结构；拒绝额外 taskId、作者、端点、支付授权等字段 |
| `publication.request_approval/publish` | 对 need/message 使用原精确许可；请求批准、批准和发布时均重查引用、状态和受众 |
| `publication.replace` | 新草稿与准确的旧 publication/revision 重新批准；需求替换递增内容版本，消息只允许修改 safeText 和重新批准受众/期限，不能偷换主题、类型或引用 |
| `publication.withdraw` | 使用 publicationId/expectedRevision；撤回自有共享，保留审计与原回执 |
| `need.close` | postId/expectedRevision；要求自有 profile 的 withdraw_own 权限，不需要批准新正文 |
| query kind=need | postId，返回当前可见 publication 及 `need={id,revision,contentRevision,state}` |
| query kind=messages | postId、limit≤20、cursor；只返回当前可见且对应当前需求内容版本的回应 |
| query kind=search，objectKind=need | 限定 spaceId，支持 search/category/coarseArea；不返回隐藏数量 |

消息正文：

```typescript
{
  kind: "message",
  body: {
    postId: "稳定需求 UUID",
    responseToPostRevision: 1, // need.contentRevision
    kind: "response", // question / answer / discussion / referral / offer_reference
    safeText: "准备提交审阅的准确文本",
    // answer 必须引用一条当前 question；其他类型不接受 parent。
    parentMessageId?: "稳定问题 UUID",
    parentMessageRevision?: 1,
    // referral / offer_reference 必填；其他消息可选。
    listingRef?: { publicationId: "已批准服务页 UUID", revision: 1 }
  }
}
```

这是字段说明，UUID 文字不能直接作为请求值。共享消息返回 `message={id,revision}`，回答使用该稳定消息版本，而不是新 publication 的 revision。首次发布后两者常同为 1；替换后不能混用。

`need.revision` 用于关闭的竞争检查；`need.contentRevision` 只在替换正文时变化。普通回应不改变二者，关闭仅增加 revision。因此关闭后既有回应仍可读，替换正文后旧回应和未发布许可失效。私有任务的 revision 与这些版本完全独立。

回答限于需求方对响应者问题的直接回答。每个问题只能发布一个回答，回答可经重新批准改正文。问题正文被替换时，引用旧问题版本的答案不再共享为有效回答。没有多级消息树；更深讨论需另行明确设计。

## 权限、受众与引用

1. 消息作者必须能够读取当前需求；内容引用准确的 need.contentRevision。
2. 发布受众必须包含需求方，并逐个通过原需求的当前可见性检查。邀请圈成员、管理员身份本身不会扩大原批准受众。
3. 消息必须与需求处于同一个圈，可见截止不得晚于需求的可见截止。需求关闭、过期或撤回后拒绝新回应；已批准但尚未发布的回应同样重查。
4. 引用的服务页必须对作者及所有消息接收者都可见，并属于同一圈。精确 publication/revision、当前服务审核及有效性均须匹配。服务暂停、撤回或被替换后，相关引用消息不再返回旧有效内容。
5. 回答进一步要求问题及其引用对每个接收者都可见，并包含原提问者。父问题替换或撤回后，旧答案不会通过子消息接口继续泄露。
6. 撤销父帖许可、移除成员、停用身份等沿用 T06/T07 读取规则；详情、列表、页面与分页保持一致。命令重放只返回原引用和当前状态，不缓存重放旧正文。

自由文本不具备自动脱敏保证。控制面显示准确草稿、接收者、有效期，并提醒检查地址、联系方式、凭据等。严格字段投影和人工批准不能被描述为“任何文本绝不含隐私”。文字 URL 作为普通转义文本展示，不抓取、不跳转为执行绑定、不变成业务权限。

## 限额与恢复

```dotenv
EIGOS_NETWORK_ENABLED=false
EIGOS_NETWORK_MAX_RESPONDERS=3
EIGOS_NETWORK_MAX_CLARIFICATION_ROUNDS=2
EIGOS_PAOTUI_ORDERS_ENABLED=false
```

两个协作上限允许配置 1–10，默认 3/2。按需求和会员计数，同一会员换 profile/安装不会增加一个候选名额。问题按响应者会员累计；草稿与审批不占次数，成功发布才占用。重放不重复消耗，撤回、改正文和替换需求也不会退还次数，避免利用这些操作无限延长自动协作。

超限分别返回 HTTP 409 `RESPONDER_LIMIT_HANDOFF_REQUIRED` / `CLARIFICATION_LIMIT_HANDOFF_REQUIRED`，`retryable=false`，`details.nextAction=human_review_required`。不静默丢弃、不自动加预算或另建需求。此阶段没有自动对话循环，限额应用于所有这些结构化发布，未来自动化不能绕过它。

相同 actor/operation/requestId 与同内容返回同一引用；同键换内容返回 IDEMPOTENCY_CONFLICT。两个已批准请求竞争最后一个名额，按事务提交顺序最多一个成功；失败不消耗许可。服务重启后回执、稳定消息和计数保持。发布与关闭/撤回使用同一写事务，后提交者看到前者状态。

列表每页最多 20 项、扫描最多 200 条、正文预算 60 KB，整体沿用网络请求/响应限制；游标绑定查看者、帖子、查询和当前网络可见性 revision，加密并认证。隐藏前缀可产生空页且 hasMore=true。权限变化后游标失效，重开服务也会使旧游标失效；这不是 T09 的可恢复增量 feed。

## 会员阅读页面

- 圈目录增加 `?kind=need`。
- `/members/network/spaces/:spaceId/needs/:postId` 显示需求和分页回应。
- 仍要求会员会话及当前受众权限。新内容由已绑定助手准备，人工批准入口仍为 `/members/network`；本轮没有另建浏览器直写权限或绕过批准的回复框。

## 验证与后续边界

[验证记录](evidence/network-t08-2026-10-18/README.md) 列出权限、幂等、版本、竞争、回滚、重开数据库及 HTTP/MCP/页面验证。既有 A2A 私有任务流程随全量回归验证，社交消息不会伪装成 A2A Task 或触发 Worker。

T09 的关注/增量动态已由[后续实现](network-t09.md)交付；T10 私有询价转换已由[后续实现](network-t10.md)交付；T11 的结果摘要已由[后续实现](network-t11.md)交付；真实主体与真实 PA 演练仍需独立完成。消息中的 offer_reference 当前只支持公开服务页，不能引用私有 DeliveryQuote 或不存在的公开报价卡。没有真实报价、订单、预订、付款、外部私信或通知发送。
