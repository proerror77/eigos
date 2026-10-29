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

原生模型调用在 `RunEvidence.nativeTiming` 和私有用量账本的同名字段中保留分段计时；超时、取消、进程失败和无效结果也保留已观察到的阶段。计时使用同一单调时钟，分别记录本地 MCP 准备、CLI 拉起、初始化与工具目录握手、首次工具调用、客户端工具等待、服务端请求／处理、模型输出和退出。缺失边界为 `null` 或省略，未结束的工具区间保留 `pending`，不补造完成时间。

`cliToTurnMs` 包含可能重叠的 MCP 握手，不能与握手耗时相加；`cliBeforeMcpRequestMs` 和 `mcpReadyToTurnMs` 可进一步定位握手前后的 CLI 启动耗时。`turnOutsideToolsMs` 包含模型、传输和调度等待，不代表纯推理时间。记录最多 96 个区间及省略计数，仅含固定阶段／工具名、状态、时间和输入字节数，不保存提示词、参数、结果内容或凭据；用量汇总接口不公开这些私有诊断。先依据这些边界定位问题，再调整具体实现。

输出边界是 CLI 的已完成消息，并非首个 token。`firstOutput` 可包含过程消息；仅当 CLI 标明 `final_answer` 时记录 `finalOutput`，否则该边界保持未知。最终结构化结果仍须读取并解析，业务决策仍须有本体提交回执，两者不能由计时记录代替。

## 一个共享存储

Gateway 和 Worker 必须使用同一个持久 SQLite 文件，建议设置相同的绝对 `DATABASE_PATH`。分进程不能使用 `:memory:`，也不能把数据库复制到两个位置来扩容。当前实现面向同机持久磁盘；跨主机需要另外的共享存储方案。

本体定义、发布引用、任务、授权和执行账本处于同一业务存储。新任务固定准确本体 release；Worker、MCP、A2A 和回读按该版本解析。会员登录会话使用独立会员库，Worker 不读取会员会话。详见[共享本体](../packages/ontology/README.md)。

## 领取与恢复

领取、续租和结果提交绑定 owner、任务 revision、领取令牌及有效期。队列准备完成后才开始新租约；迟到结果不能覆盖取消、改版或失效领取。未知外部效果保留原操作身份，只进行原键查证。

有效补充信息和技术恢复沿用原任务，保留累计预算和已确认事实。异步来源的健康等待使用持久 `nextAt` 与有界退避。重复校验失败可以暂停并等待修复；不能通过重置任务或伪造用户回复绕开问题。

只读任务可以由模型一次选择有界依赖图：独立查询并发执行，后续查询只使用原账本中已验收的具名输出。标量选择必须是动作定义中声明的纯函数，并与同一步、同一个输出端口的观察绑定；歧义、过期或权限变化会阻止后续查询，交回模型处理。

原生目标允许模型通过 `plannedGoalCompletion` 预先选择各组件的未来证据和固定目标对应关系，仅适用于明确支持该能力的只读模块。Worker 在来源返回后重新读取证据，运行组件验证器、完整目标检查和原权限校验；预先选择验收条件本身不代表任务完成。未通过验收的计划保留原结果并进入下一次决策，不重新派发已确认的查询。

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
