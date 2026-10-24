# 支付宝平台操作：CLI 优先流程

后续 EIGOS 的支付宝平台操作先走本流程。用户已授权按任务需要追加权限，无需逐项再次询问；权限只取当前任务所需。平台要求扫码、人工核身、接受协议或没有对应 CLI 接口时才交接给用户。此规则不扩大业务授权：当前真实下单、付款、免密和代扣均未授权；发布、删除、对外联系及其他外部写入仍按具体任务授权执行。

## 自动入口

在仓库根目录运行：

```sh
node scripts/alipay-platform.mjs ensure
node scripts/alipay-platform.mjs app-info --data '{"request":{"appId":"2021007109677510"}}'
node scripts/alipay-platform.mjs spaces
node scripts/alipay-platform.mjs whitelist
node scripts/alipay-platform.mjs templates
node scripts/alipay-platform.mjs abilities --data '{"request":{"workSpaceId":"2026101502102043600019445","pageNo":1,"pageSize":20}}'
```

入口自动检查 CLI、登录和查询需要的权限；会话失效时先尝试一次刷新，再按需发起登录或追加授权。凭据始终由官方 CLI 管理，脚本不读取、不保存或复制 Token、API Key、私钥。

`ensure --scopes app:read,skill:all,space:read` 可预检多种后续查询。普通查询自动选择 scope，不预先请求全部权限。`skill:all` 是当前官方查询要求的范围，也包含管理权限，获得它不代表授权执行管理写入。

| 返回 status | 代理下一步 |
| --- | --- |
| `ready` | 登录和所需 OAuth scope 已具备，继续当前授权任务 |
| `completed` | 当前查询的业务响应成功；根据实际数据继续判断，不能宣称底层业务已完成 |
| `needs_user` | 展示返回的官方 verification_url，打开扫码页；用户确认后继续原命令 |
| `failed` | 检查具体错误或业务拒绝，不盲目重试 |
| `unverified` | 返回中没有可确认的业务成功信号，保留结果并调查 |

扫码后在**原命令**末尾追加 `--complete login` 或 `--complete grant`，以返回的 `complete` 字段为准。例如：

```sh
node scripts/alipay-platform.mjs templates --complete grant
```

`pending` 是正常等待状态；代理按返回 interval 有界轮询，同一个授权流程不要反复重建。脚本每次只检查一次，避免占住用户交互。授权过期才重新发起。不要同时运行多个登录/追加授权流程，官方 CLI 的待完成会话由它自己管理。

扫码链接属于临时授权信息，只向当前用户展示，不写入版本库或共享证据。CLI 未安装时按官方文档安装可信发行版，不执行来源不明的安装脚本。普通平台操作不会要求用户每次重新网页登录；网页登录和 CLI 登录是独立会话。

## 其他已授权的平台操作

脚本只执行列出的只读查询，不是全部平台接口的封装。应用管理、Skill 管理、上传、小程序等有已核实 CLI 能力时，代理应继续直接使用官方 `alipay-cli`：

1. 从当前官方文档、对应 Skill 或本机 help 确认命令、参数及 scope；未知接口不猜测。
2. 使用同一 CLI 会话检查登录和权限，必要时 `auth grant --scope <当前任务所需范围> --non-interactive --json`；此前已授权的扩权无需再询问。扫码由用户完成。
3. 可用时先 `mcp list <server> --json` 查 schema。部分已知服务的 list 路由返回 404，但 tools/call 可用；此时可使用已核实的官方方法和参数，不能把 404 当成服务不存在，也不因此立即转网页。
4. 对有外部效果的操作先用 `--dry-run` 检查请求，再在具体任务授权范围内执行。dry-run 只验证请求构造，不证明权限或业务成功。
5. 写入后用官方查询接口回读对象、版本和状态。网络超时不自动重放创建/提交，先确认远端是否已生效；是否安全重试以官方幂等契约为准。

当前 helper 允许 app:read、skill:all、space:read。其他范围走以上官方 CLI 路径，不为调用方便默认申请 app:all 或支付权限。

## 何时转网页或请用户介入

- 支付宝要求扫码、短信/支付密码核身等本人操作。
- 需要接受有约束力的协议：说明具体协议并取得当次确认，不能用“允许追加权限”代替签约授权。
- 所需功能没有已核实的 CLI 接口；只把这一部分转网页，完成后继续复用 CLI 会话。
- 需要人工审核、运营开白名单或专项合作准入：先整理已有证据与明确缺项；已有申请/咨询先查状态，不重复提交。

## 成功与失败的判断

同时检查进程结果、MCP `isError`、`content.text` 内实际 JSON 的 `success` / `resultCode`。退出码 0、HTTP 200、工具调用成功或返回模板不代表业务执行成功。白名单拒绝要报告原始业务状态。

相同输入发生三次相同失败后停止该路径；新权限、文档或服务状态变化后才继续。健康状态、排队和授权 pending 不算失败。日志保留在忽略目录，分享前脱密。

阿宝 Skill 生产工具属于供给侧。CLI scope、EIGOS 应用在线、能查询模板不等于已获得阿宝/AHA 消费侧商家服务调用资格；没有正式端点和调用授权时，不猜测星巴克等商家的服务地址，不创建模拟结果冒充查询成功。

## 参考

- [Alipay CLI 官方文档](https://opendocs.alipay.com/ai/0k16jg?pathHash=ef356ee4)
- [官方 onboarding Skill 安装说明](https://opengw.alipay.com/alipaycli/skill/alipay-onboarding/setup)

此流程依据 CLI 0.2.0 的实际授权与查询行为制定；操作前仍以本机 help、线上 schema 和当前返回为准。
