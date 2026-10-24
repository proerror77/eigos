# 会员连接自己的服务账号

会员身份不授予服务器操作人的供应商账号。每个会员通过自己的 PA 获取来源凭据，并通过当前 EIGOS origin 的私有上传路径建立连接。凭据不得经过 MCP 参数、任务文本或模型上下文。

1. PA 读取 `list_source_connections` 与 `get_source_connection`。
2. `begin_source_connection` 返回当前身份绑定的上传请求。
3. PA 在本机取得本人凭据，通过 SDK `AgentConnector.connectSource` 的 `loadCredential` 回调上传。
4. 再次读取连接状态；需要继续任务时使用原 `taskId` 和当前版本调用 `resume_source_task`。
5. 撤销使用 `revoke_source_connection`；它不代表供应商账号本身已注销。

连接绑定 owner、客户端／安装、版本、期限和读取程序。私有业务库保存加密密文，密钥单独存放并限制文件权限。Gateway、Worker 和供应商 MCP 对配置、版本、有效期及撤权状态分别检查；会员读取不会回退到服务器操作人的凭据。

配置使用 `EIGOS_MEMBER_SOURCE_KEY_FILE` 和 `EIGOS_PAOTUI_SKILL_DIR`。显式单会员兼容模式使用 `EIGOS_PAOTUI_MEMBER_CONNECTION_FILE`，两者互斥。部署配置和身份要求见[会员指南](membership.md)及[配置模板](../../.env.example)。

已有地址选择只在来源证明同一账号、授权与所选内容仍有效时复用。来源变更使旧观察失效；恢复继续原任务并重新读取来源，不能生成新的业务许可。来源接入成功和真实查价完成分别判断。
