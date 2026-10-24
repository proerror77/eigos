# 会员本人账号：真实 PA 只读回路

2026-10-19，本人完成 Auth0 管理登录及验证 PA 的会员授权后，在独立私有 HTTPS 实例完成 **真实 PA → EIGOS v8 Worker → 本人连接的美团地址簿 → PA** 回路。任务为读取本人地址簿，未查询运费、修改地址、下单、付款或发布网络内容。

## 已验证结果

- 现有 Auth0 API 新增 `sources:read`、`sources:write`，原有 `services:read`、`tasks:read`、`tasks:write`、`members:write` 保留。独立读取 API 配置，并验签 PA 访问令牌的 issuer、audience 和业务 scopes；PA 登记及会员状态均为 active。[权限回读](authorization-readback.json)。
- 实际 PA 使用私有 HTTP 通道连接自己的来源凭据，并恢复同一个 Task。Worker 选择 `address.book.read@2`，完成验收；交付物包含 11 条本人地址记录。
- Worker 共 8 轮实际 `codex-exec` 模型调用，8 次本体读取全部成功，包含定义、对象及 `paotuiObservationStatus` 评估。只有 1 个已确认的 read 意图、1 次执行尝试、1 次 `get_address_list` 来源调用。
- PA 的最终 MCP `get_task` 读回、独立 A2A `GetTask` 和数据库中的交付物一致。使用实际发布代码重新执行完成验收，结果内容一致；查询证据回执与七字段摘要校验通过。
- 发布代码为 `522cc0f1ffdc38802c8e85fd7d59f60eeca28fda`，构建摘要 `64c499b15b7ff4cbdb52b778b5a8091b8ec4bed1077478de701d8259036d7e43`。132 个发布文件与工作区构建一致，私有 HTTPS 健康摘要吻合，精确 Tailnet 代理检查通过。[脱敏运行记录](verification.json)。

## 首次参数拒绝与续接

第一次 PA 已完成本人来源连接，但把提交任务的字符串幂等标识用于要求 UUID 的 `resume_source_task.requestId`。MCP 参数验证正确拒绝该调用，供应商读取尚未发生。调整验证提示后，第二个实际 PA 运行使用有效 UUID 继续原 taskId，没有新建任务，也没有由诊断程序代替 PA 发起供应商读取。记录保留两个调用侧线程和执行侧模型回执标识。

## 数据与结论边界

真实 Token、地址、联系人及原始模型／协议输出保留在忽略目录的私有证据中。Git 只归档状态、数量、摘要和调用元数据；没有发布原始地址簿、凭据或会员身份资料。七字段查询卡只进行了只读校验，没有发起发布。

此次证明本人提交的来源连接能被供应商接受，并完成一次真实地址簿查询。来源 Token 仍是会员 PA 的本人授权声明，不能据此声称供应商已经将账户实名身份与 EIGOS JWT 身份作原生认证绑定。其他会员的真实账号、真实报价和履约没有在这次验证中执行；其隔离与报价动作有[此前工程和合成模型验证](../paotui-agent-v8-2026-10-19/README.md)。

这次只更新 IdP 权限和验证证据，没有修改应用代码。此前 475 项测试、9 项进程级 E2E 与代码 CI 的证据继续有效；本次文档提交仍执行自己的 CI 检查。
