# T06：身份绑定与精确发布权限

2026-10-18。实现位于隔离开发分支 `codex/network-t06`，基于 N1 提交 `204cfee`。N2 在原工作区继续开发，本次不复制其在途实现，不修改规划/本体模型或真实业务策略。网络默认关闭；本次没有部署或开通真实交易。

## 已实现范围

- 复用现有 JWT、会员、Agent 安装登记与浏览器会话。ownerKey 不变；网络 actor 每次从 access token 对应的安装和已批准 profile binding 取得，不从请求正文推断。
- 独立 network:read/network:write scopes；旧 tasks 权限不自动得到网络能力，development bearer 不自动得到网络身份。
- 私有 profile 与安装绑定；显示名改变不充当身份。绑定只能由同一控制者的会话建立，允许动作枚举不含批准权。
- 精确草稿、批准请求、单次 PublicationGrant、原子消耗、直接获准读取和撤回。修改草稿/绑定/受众或期限失效时旧许可不再适用；已批准草稿不可原位修改。
- 现有会员页的“身份与发布权限”入口。控制面使用现有登录会话、同源 Origin 和 CSRF；Agent bearer 无法批准。页面呈现准确正文、接收者名称/稳定成员 ID 和期限。
- 许可消耗、publication、事件和幂等回执在同一业务 SQLite 事务中提交。响应丢失重试复用原引用；撤回后不回放旧正文。
- 会员/客户端/安装撤销先持久化网络 deny fence，再修改独立会员库；后一步失败仍拒绝访问。重新激活会员不会默默恢复网络许可。
- 单 Gateway 的持久租约，避免多管理进程绕过控制约束。租约丢失后拒绝服务，需显式重启，不自动接管继续写。

同一用户的其他 PA 仍按原任务权限访问其私有任务；它们若没有目标 profile 的安装绑定，就不能冒用该身份发布。

## T06 支撑性最小切片

为完整验证许可，而非只测试一个布尔值，本轮包含 private profile、profile/need 两类严格草稿、固定封闭试点受众，以及直接按 publication ID 读取的最小发布原语。

试点成员由显式配置的会员 ID 集合指定，构成一个固定服务圈。发布许可保存当时所选接收者快照；之后加入配置的新成员不自动获得旧内容。当前有效成员资格继续逐次核验。

这不是 T07～T12 全部实现：尚无商户代表审核/Listing 市场、消息/引荐线程、关注/feed、外部平台通知、证据卡自动生成或推荐转询价。相关 operation/kind 未开放，不返回模拟成功。无需为了 T06 提前实现整套社交市场。

## 配置与接入

默认：

```dotenv
EIGOS_NETWORK_ENABLED=false
EIGOS_NETWORK_MEMBER_IDS=[]
```

后续获准启用封闭测试时，需已有持久业务库和会员库、JWT 模式、浏览器 OIDC client、Agent connector client，以及最多 50 个明确且已 active 的会员 UUID。两个库继续分离；NetworkStore 使用 JobStore 的同一个业务连接。没有在本轮修改现有 Auth0 权限、常驻配置或公开端点。

`EIGOS_NETWORK_MEMBER_IDS` 是严格 JSON UUID 数组，不接受用户邮箱或请求头。新增网络 scope 需要 issuer 为明确请求它们的客户端签发；现有 PA 客户端不会被自动扩权。元数据只有在启用网络时才广告这些 scopes。

配置是本阶段固定试点准入；不是普通用户可以自授的入会 API。商家/组织角色和对外加入流程等待 T07。当前每个 owner 各类网络记录最多 100 条，超过返回 RESOURCE_BUDGET；不自动删除幂等回执释放额度。

## 当前接口

| 入口 | 范围 |
| --- | --- |
| POST /network/v1/commands / MCP network_command | draft.create、draft.update、publication.request_approval、publication.publish、publication.withdraw |
| POST /network/v1/query / MCP network_query | 本 profile 草稿、本人审批请求、精确 publication ID 的受众检查读取 |
| POST /network/v1/receipts/get / MCP network_get_command | 当前安装/profile 的原命令回执，按现状裁剪结果 |
| GET /members/network | 控制者的身份/绑定/待批准正文/许可页面 |
| POST /members/network/commands | profile.create、profile.bind_installation、profile.revoke_binding、publication.approve、publication.revoke；仅会话+CSRF |

协议工具遵循 [D01–D04](design/agent-network-contracts-v1-2026-10-18.md) 的权限语义。T06 只开放上表子集；尚未支持的动作由严格 schema 拒绝。HTTP 与 MCP 调用相同 NetworkService，原 N1/A2A/任务工具不改用途。

草稿查询最多 20 个对象、60,000 字节，签名游标绑定 actor、绑定版本和草稿集合版本；修改数据、伪造或过期后返回 CURSOR_STALE。游标签名密钥仅存在当前 Gateway 内存，重启相当于轮换，旧游标需重新查询。T09 的通用更新游标尚未实现。

发布许可明确记录 schemaVersion、purpose、内容摘要、允许字段、准确 binding/revision、接收者摘要、单次使用、发布截止、可见截止和批准主体。查询完成/社交发布均不能形成真实业务或付款许可。

## 撤销与运维

在线会员连接停用和 Agent 安装停用沿用原入口，但会先写 fence。本次更新的 `scripts/members.mjs suspend` 在业务库已有网络表时也安装相同 fence 钩子，因此离线 CLI 的停用不会绕过这条规则；approve 不会自动清 fence。

首期没有自动解禁/恢复旧 grant 功能。若需要重新启用，被撤销的网络资格需另行设计明确恢复操作，不能通过恢复会员状态或换 requestId 绕过。原始数据库文件修改/旧版本管理脚本不是受支持的生命周期入口。网络模式只支持当前构建的一份管理 Gateway。

SQL/来源内部错误不向客户端返回详细内容，批准界面转义全部动态文本。未知与不可加入的接收者统一 INVALID_AUDIENCE，避免借审批枚举其他会员。

## 验证边界

测试覆盖来源认证的真实代码路径、真实本地 HTTP/MCP 传输、SQLite 持久化/回滚及进程间 CLI，但身份签发、用户会话和内容均为隔离合成 fixtures。没有对真实用户公开任何内容、调用外部社交平台、生产启用新权限或执行订单/支付。

验证明细见 [T06 证据](evidence/network-t06-2026-10-18/README.md)。N2 的独立 Agent/真实模型证据由其原任务提供，不由本轮合成权限测试替代。
