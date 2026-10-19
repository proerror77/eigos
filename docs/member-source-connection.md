# 单会员个人来源连接

本文记录显式兼容模式。其他会员通过 PA 提交本人凭据的当前接入路径见[会员自有账号授权](member-source-authorization.md)，与本文配置互斥，不会借用操作人的凭据。

2026-10-19。接续 T12/T13 的 `e4647f4`，并合入主线 `fc00061` 的 Shopify／本体增量，补齐现有个人美团只读能力与 JWT 会员身份的衔接。实现不部署、不连接真实账户、不迁移凭据，也不开放真实交易。

## 当前实现

一个 EIGOS 实例最多把当前操作系统用户的现有 `pt-passport` 凭据环境绑定给一个明确会员。其他会员即使能看到同一服务介绍、同属一个圈或持有 tasks:write，也不能借用这份来源连接。没有共享凭据默认值、由请求正文指定 owner 的入口或会员自行认领来源的 API。

这里的连接记录由本机操作者保管，包含 connectionId、版本、memberId、受信 issuer／tenant／subject、当前系统 UID、只读用途、状态和到期时间；不包含令牌、手机号、地址或密码。它只表示操作者把现有个人凭据环境指定给这个会员，不声称供应商已认证该 JWT 身份。更换供应商账号前必须撤销连接，核对归属后建立新的连接。

Gateway 从会员库核对准确身份、已开通状态、issuer 和网络准入，并把无凭据的准入摘要写入业务库。准入摘要同时固定配置的读取程序目录。Worker 和内部 stdio MCP 只读业务库的准入摘要与既有会员撤权记录，不打开会员会话库。连接文件须为当前系统用户拥有的普通私有文件，权限 0600，拒绝符号链接、硬链接、多余字段和未知凭据模式。

原 `delivery.quote@2` 地址选择／补问流程、`address.book.read@1`、内部 Ontology MCP、官方 CLI、来源回执、Task、本体投影、Proposal 和精确发布许可继续复用。连接用途仅限本人地址读取及运费预览；不顺带开放公共地点发现、授权操作、下单或付款。

## 每次读取的检查

- 目录发现、来源候选和询价转换按请求的 owner 检查连接；不能从发布者身份或帖子取得调用权。
- Gateway 只声明能力和核对准入；调用其目录中的读取器会拒绝，不启动凭据工具或业务程序。
- Worker 在读取前后检查连接文件、状态、到期时间、固定摘要以及共享业务库的会员撤权记录。
- 内部 MCP 再检查相同连接；`pt-passport` 与每条官方 CLI 命令前后均重查。读取中途撤销后不继续下一条命令，不把已返回的结果投影进任务。
- 会员停用复用既有持久撤权记录；简单重新批准会员不自动清除撤权。Gateway／Worker 配置不一致或尚未建立准入时默认拒绝。
- 连接变更进入 capability binding 的 configurationDigest。旧计划和旧地址选项不自动跨连接恢复；需要重新取得当前上下文。

已经开始的只读请求无法被追溯取消，结果会在返回时重查并拒绝保存。取消与租约仍由原 Worker 处理，不建立第二套任务队列或恢复机制。

## 配置与操作

这条连接保持非生产、同机 loopback 范围，要求现有 JWT/OIDC、邀请网络准入、持久业务库及会员库；新建部署和公开多用户托管不属于本次交付。

先构建，再由本机凭据持有人明确选择本人已开通的会员编号，生成一个私有记录。以下是操作说明，本轮没有对真实配置执行：

```sh
npm run build
npm run source:personal -- bind --member <本人会员UUID> --file data/private/meituan-member.json --expires-hours 24
```

命令读取现有 MEMBERSHIP_DATABASE_PATH、OAUTH_ISSUER、EIGOS_NETWORK_MEMBER_IDS 核对身份；默认 24 小时，最多 168 小时，不覆盖已有文件，不读取或复制供应商令牌。输出只有连接 ID、会员 ID、状态和到期时间。

Gateway／Worker 使用相同业务库和连接配置：

```dotenv
EIGOS_PAOTUI_SKILL_DIR=/absolute/path/to/existing/official-skill
EIGOS_PAOTUI_MEMBER_CONNECTION_FILE=/absolute/path/to/data/private/meituan-member.json
EIGOS_PAOTUI_ORDERS_ENABLED=false
```

PUBLIC_URL 必须符合已有 JWT 的 HTTPS 要求且为 loopback 主机，HOST 也只允许 loopback。连接文件只在启动和读取时校验，不能通过任务或网络命令更改。需要真实 HTTPS／OIDC 环境时使用既有配置流程；本轮不修改常驻服务。

```sh
npm run source:personal -- inspect --file data/private/meituan-member.json
npm run source:personal -- revoke --file data/private/meituan-member.json
```

撤销不需重启：现有实例下一次访问检查即拒绝；在途返回也会被丢弃。续接或改用另一连接需要新的明确记录、Gateway 身份核对和一致的 Worker 配置，不自动恢复旧请求授权。旧开发模式在没有会员连接时继续只允许原 local-development 身份；JWT 没有连接文件时仍不能启用个人美团读取。

## 验证边界

测试使用两个 JWT 会员、独立 Gateway／Worker 数据库连接以及隔离的本地 CLI 替身。它验证真实代码、stdio MCP、凭据环境传递和 owner 拒绝路径；它不证明本轮真实供应商查询成功。原私人令牌、保存地址和生产来源均未读取。

人工非建模者演练继续单列。T13 的实际 PA／真实来源、真实异常和成本／时间对照仍需要在明确启用本人连接后实测；不因连接代码和 CI 通过就标为完成。

[本轮测试与边界记录](evidence/member-source-2026-10-19/README.md)。
