# 开发与运行

本仓库是一个 TypeScript／Node.js 工程，使用一份依赖锁和统一验证流程。目录职责见[仓库结构](architecture/repository.md)。

## 本地开发

要求 Node.js 22.13 或以上，并使用仓库的依赖锁：

```sh
npm ci
npm run setup:dev
npm run dev
```

`dev` 启动 Gateway 和 Worker 两个进程。也可分别运行 `npm run dev:gateway` 与 `npm run dev:worker`。构建后使用 `npm start`，或分别使用 `start:gateway`、`start:worker`。配置模板为 [`.env.example`](../.env.example)。

Gateway 负责协议、身份和任务入口。Worker 负责持久领取、模型、连接器、恢复和验收。模型及供应商凭据仅配置在需要它们的执行侧。能力开关应一致，构造目录不等于来源健康或任务已经执行。

Worker 的原生本体规划将任务专属 Ontology MCP 标记为必需服务：CLI 等待它初始化后才启动模型回合；初始化失败时停止本次调用。启动上限仍为 15 秒，单次工具调用上限仍为 30 秒。这样可避免可选 MCP 的初始目录等待窗口结束后，模型在缺少本体工具的情况下直接返回。规则见 [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 一个共享存储

Gateway 和 Worker 必须使用同一个持久 SQLite 文件，建议设置相同的绝对 `DATABASE_PATH`。分进程不能使用 `:memory:`，也不能把数据库复制到两个位置来扩容。当前实现面向同机持久磁盘；跨主机需要另外的共享存储方案。

本体定义、发布引用、任务、授权和执行账本处于同一业务存储。新任务固定准确本体 release；Worker、MCP、A2A 和回读按该版本解析。会员登录会话使用独立会员库，Worker 不读取会员会话。详见[共享本体](../packages/ontology/README.md)。

## 领取与恢复

领取、续租和结果提交绑定 owner、任务 revision、领取令牌及有效期。队列准备完成后才开始新租约；迟到结果不能覆盖取消、改版或失效领取。未知外部效果保留原操作身份，只进行原键查证。

有效补充信息和技术恢复沿用原任务，保留累计预算和已确认事实。异步来源的健康等待使用持久 `nextAt` 与有界退避。重复校验失败可以暂停并等待修复；不能通过重置任务或伪造用户回复绕开问题。

## 验证

```sh
npm run check
npm test
npm run build
npm run test:e2e:run
git diff --check
```

自动测试使用隔离数据库和合成模型／来源。进程级测试验证真实进程与协议接线，仍不能证明真实商家操作或履约。实际业务验收需要独立来源回读。

`npm run ontology:check` 校验可编辑的供应商绑定，`ontology:sync` 将验证后的数据放入生成目录。构建自动完成同步。`dist/` 是构建产物，不是另一份编辑来源。

## 部署

正式运行统一为一个主权威，公网和私有兼容地址只承担传输入口。Gateway、Worker、Ontology MCP 共用同一任务库和发布注册库，见[统一运行与路由](architecture/runtime-authority.md)及[部署说明](guides/deployment.md)。代码同步、进程更新、已有数据库迁移和真实业务操作分别验收。已有任务不能因为代码更新而自动重放。

## Foundation 运行边界

默认 legacy 保留已有接口。foundation 要求独立持久任务库、JWT Agent 安装和匹配的权限策略；Gateway 发布短期资格，Worker 按原授权检查，不能读会员登录库或通过旧接口回退。现有模式、迁移、副本验证和来源资格见[本体权限指南](guides/ontology-security.md)。切换或部署须按实际授权执行，本次代码整合不等于某个实例已经迁移。
