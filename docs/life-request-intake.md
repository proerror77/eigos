# 常驻 PA 委托连接

2026-10-18 起，原“只登记生活需求”的模式与 life.request 入口已删除。本人常驻连接使用 `eigos.delegate`，由 Ontology + LLM 后端真正处理当前受支持的业务。历史登记记录保留原任务编号和内容，只读，不自动恢复为业务执行。

```sh
npm run build
npm run setup:pa
```

此脚本只管理原 `com.eigos.grok-life` launchd 服务、`127.0.0.1:3430` 及 `~/.local/share/eigos/grok-life/`。名称保留用于识别既有安装，没有保留旧执行模式。原任务库和凭据延续；代码按构建摘要存放于 releases/，旧代码及数据库备份保存在 backups/。更新失败时恢复此前运行配置，不覆盖任务历史。`npm run setup:pa -- --restart` 可执行重启验证。

PA 读取同目录 skill-install.md，保存更新后的技能；用固定 Python 客户端和 profile 发现、发送自然语言需求、处理原任务补问、查询结果。profile 的默认和允许服务只有 eigos.delegate。凭据仍由客户端内部读取，不能放到提示词中。地址选择与真实查价见 [美团说明](meituan-paotui-integration.md)。

Mac 开机且用户登录时由 launchd 保持服务，休眠、离线或上游授权失效仍会影响可用性。该连接为本人本机开发身份，公网和多用户上线需要另行验证。2026-10-17 的 [旧登记实验](evidence/grok-life-intake-2026-10-17/README.md) 仅作为历史证据。
