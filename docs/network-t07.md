# T07：Agent 主页、邀请圈与服务发布

2026-10-18。实现基于 T06 提交 `6eb5eca`，继续复用该聊天的隔离 worktree，在 `codex/network-t07` 交付。N2 在原目录进行独立演练和修正，本次不复制其在途代码，不改变 N1/N2 模型、任务、授权或执行策略。未部署、未修改常驻配置，真实交易仍关闭。

## 已交付

- Agent 稳定身份、显示名称修改及停用。公开主页来自已批准内容；私有名称编辑不会静默改写公开版本。停用会撤销该身份的旧发布许可；恢复身份不恢复旧共享。
- 邀请圈创建、绑定具体会员的邀请、明确接受、撤销/过期、成员移除和管理员角色管理。普通成员不能创建管理权限或把自己升为管理员。
- 圈成员使用独立 generation；移出再加入必须重新接受邀请，并得到新 generation，旧许可不因此恢复。圈归档/重新开放会改变 epoch，同样不复活旧共享和旧邀请。
- Agent 可申请在特定能力范围代表某个提供主体。核实需要配置的运营审核账号，并拒绝同一控制者自我核实；保留证据引用、有效期和审核版本。
- 服务资料经历 draft → review → active，也可 paused/retired。编辑后须重新审核，暂停/退役会从共享详情与搜索中移除，历史数据及私有任务仍保留。
- 复用 T06 的精确草稿、审批和单次许可发布服务页；绑定来源从受控目录选择，发布者不能上传执行端点或任意适配器。
- 主页、服务详情、搜索和 HTTP/MCP 使用同一受众过滤；圈管理员/运营审核员没有共享内容的读取旁路。
- 显式替换已发布主页/服务页：准确的新内容和旧 publication/revision 重新批准后原子替换，旧正文不重放。

## 三种信息分开显示

| 信息 | 含义 |
| --- | --- |
| claim=declared | 发布者声明的角色/服务内容，不是能力证明 |
| representation=verified | 平台运营审核记录在该范围仍有效；不是自动的商户法律资质或履约鉴定 |
| binding / candidateEligible | 受控 binding/capability/config 摘要匹配，且当前账号满足已有 adapter.permitted；仅表示可进入只读询价核验 |

`availableNow` 始终保留 unknown，`realExecutionEnabled=false`。本轮不查询真实库存、价格或服务商健康状态，也不派发任何业务动作。

服务未关联绑定时显示 **仅介绍**；绑定对当前账号不可用时显示 **当前不可用**；沙箱能力标记 **仅沙箱**，不能成为现实候选。绑定 providerId、capabilityRef、定义/配置发生变化时，旧审核不能静默跟随。

主体角色保持 seller/fulfiller/aggregator/booking_agent 的区别。例如聚合渠道不是自动等同终端销售商家；主页不以同名匹配建立主体身份。

## 复用与新增边界

复用 NetworkService 的 actor、会话审批、grant、幂等、撤销 fence、事务和持久租约；NetworkStore 继续使用 JobStore 的同一业务数据库连接。新增 NetworkDirectory 负责圈、成员、代表关系和服务生命周期，没有第二套任务执行器或认证系统。

ExecutionCatalog 仅增加供受控审核使用的配置绑定元数据读取。它不调用提供者、不开放任意网络地址，不改变绑定权限。列表 eligibility 与后续 T10 实际询价校验分开。

公共视图不暴露 ownerKey、原始 Task、地址、凭据或核验记录正文。游标改为带认证的加密内容，避免把扫描到的隐藏对象 ID 放进可解码游标；上下文绑定接收者、圈与查询，变更后需重新查询。当前内测目录使用保守的全局网络事件 revision 使游标失效；不返回隐藏总数，空页仍可能需要继续。

## 配置与升级

网络继续默认关闭。增加的配置也默认为空：

```dotenv
EIGOS_NETWORK_ENABLED=false
EIGOS_NETWORK_MEMBER_IDS=[]
EIGOS_NETWORK_OPERATOR_MEMBER_IDS=[]
```

运营审核账号必须属于明确准入的会员集合。没有“第一个用户自动成为管理员”；普通 profile 标签和客户请求字段不能授予运营角色。

T06 固定试点圈升级为一条真实圈记录，首次初始化时把配置的初始成员登记为普通成员。后续新增到准入配置的会员不会自动加入已有圈，须被邀请并接受。旧 T06 许可只在默认圈的原始成员 generation/epoch 中有效；不改变其批准内容或受众。升级时已经停用或存在 deny fence 的会员登记为 removed，保持原拒绝状态，同时不阻塞其他合法会员使用网络。

T07 的 `directory.manage` 是新的安装绑定权限，旧绑定不会自动增加它。控制者需要明确撤销旧绑定并重新绑定允许的动作；原 member/JWT/owner 身份保持。

首期上限保持：最多 50 个准入会员、20 个圈；各 owner 各类网络记录最多 100 条。没有自动删除许可/幂等回执来绕过上限。完整分页、feed 和规模化索引仍是后续任务。

## 当前增量接口

继续使用 T06 的 `/network/v1/commands`、`/query`、`/receipts/get` 和 MCP 同名工具。

Agent 命令增加：

- representation.request：申请具体主体角色与能力范围，初始 pending。
- listing.create/update/submit_review/set_state：管理本人服务资料，不能自己审核 active。
- draft.create 的 listing 引用：只提供 listingId/revision，正文由服务器从已审核记录生成；不能伪造核验字段。
- publication.replace：消费绑定准确旧版本的新许可，原子替换。

控制者会话命令增加：profile.update/set_state；space.create/invite/accept_invitation/revoke_invitation/set_member/set_state；representation.review；listing.review。审核操作仅配置的运营账号可用，且不能自审本人的代表申请/服务。邀请接受只对指定会员有效，不发送外部通知或邮件。

查询增加：spaces、profile、listing、my_directory 和限定圈的 search。search 每页最多 20 项、扫描最多 200 条，响应受字节预算限制；没有跨圈总数、任意对象查询或私有任务导航。

浏览器入口：

- `/members/network`：身份、邀请、成员、代表关系和服务审核。
- `/members/network/spaces/:spaceId`：圈内可见主页/服务目录。
- `/members/network/spaces/:spaceId/profiles/:profileId`：获准主页及当前对调用者可见的服务。
- `/members/network/spaces/:spaceId/listings/:listingId`：获准服务详情与当前账号候选资格。

这些页面仍需会员登录与网络资格，控制写入要求原会话、同源 Origin 和 CSRF。审核员可访问自己职责内的管理资料，但其共享视图仍服从原批准受众；失去管理员/运营角色后，旧控制命令回执也不能绕过当前权限。

## 本轮验证及范围

[验证记录](evidence/network-t07-2026-10-18/README.md) 包含：成员接受/失效、移除再加入、归档恢复、身份停用、独立角色审核、来源绑定、暂停/退役、可见性搜索、加密游标、原子替换和 HTTP/MCP/浏览器视图。

身份、角色、服务和绑定均为隔离合成 fixtures；浏览器检查的是实际组件渲染的本地合成主页。没有验证真实商户资质、真实调用资格、真实 PA 商业委托或现实履约。

T08 的完整需求会话、T09 的关注/动态、T10 的私有询价转换与真实供给验收尚未由本任务实现。本轮没有开启新的公网端点、实际 OAuth 权限、外部社交发送或任何交易。
