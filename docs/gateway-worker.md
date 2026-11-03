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

原生规划和结构化审查均使用进程专属的私有 Codex 配置与业务角色说明，排除宿主的全局 `AGENTS.md` 和无关技能目录。配置仅引用经过文件权限检查的原 Codex 认证文件；清理临时目录不会删除原认证存储。Gateway／供应商凭据不传入模型进程，模型选择、当前数据许可和 Worker 的执行／验收检查仍分别处理。技能排除使用 [Codex 的逐技能配置](https://learn.chatgpt.com/docs/build-skills#enable-or-disable-local-codex-skills)，不修改操作者的技能文件或全局配置。

原生模型调用在 `RunEvidence.nativeTiming` 和私有用量账本的同名字段中保留分段计时；超时、取消、进程失败和无效结果也保留已观察到的阶段。计时使用同一单调时钟，分别记录本地 MCP 准备、CLI 拉起、初始化与工具目录握手、首次工具调用、客户端工具等待、服务端请求／处理、模型输出和退出。缺失边界为 `null` 或省略，未结束的工具区间保留 `pending`，不补造完成时间。

`cliToTurnMs` 包含可能重叠的 MCP 握手，不能与握手耗时相加；`cliBeforeMcpRequestMs` 和 `mcpReadyToTurnMs` 可进一步定位握手前后的 CLI 启动耗时。`turnOutsideToolsMs` 包含模型、传输和调度等待，不代表纯推理时间。记录最多 96 个区间及省略计数，仅含固定阶段／工具名、状态、时间和输入字节数，不保存提示词、参数、结果内容或凭据；用量汇总接口不公开这些私有诊断。先依据这些边界定位问题，再调整具体实现。

输出边界是 CLI 的已完成消息，并非首个 token。`firstOutput` 可包含过程消息；仅当 CLI 标明 `final_answer` 时记录 `finalOutput`，否则该边界保持未知。最终结构化结果仍须读取并解析，业务决策仍须有本体提交回执，两者不能由计时记录代替。

## Harness 执行适配（POC）

Worker 可显式选择 `EIGOS_EXECUTOR=harness`。适配采用 Super-agent 原型的独立 Executor Session 边界，通过 DeepSeek Harness 的 `sdk-minimal` JSON-RPC 接口运行模型；不启动原型的 GitHub／飞书来源、第二套 Ticket／Policy 引擎或独立正式任务库。EIGOS 继续负责持久领取、当前授权、取消、原操作恢复与结果验收。Gateway 只按相同开关公布文档能力，不启动 Harness，也不需要模型凭据。

已验证的外部运行版本为 `@deepseek-ai/dsh@0.2.1-rc.5`，使用 Node.js 22.22.3。运行环境与项目依赖分开安装，例如 `npm install --prefix /opt/eigos/harness-runtime @deepseek-ai/dsh@0.2.1-rc.5`。配置入口见 [`.env.example`](../.env.example)；Worker 必须设置绝对路径 `EIGOS_HARNESS_CREDENTIAL_FILE`，文件须由运行用户拥有、权限不大于 `0600`，不能是符号链接。

`codex-oauth` 读取现有 Codex 登录 JSON 中当前的 ChatGPT access token，通过 Harness 的 `openai-codex` 通道调用所选模型；不把 refresh token、原 Codex home、Gateway 令牌或供应商凭据传入模型进程。原登录仍是刷新凭据的唯一写入方。远程副本过期时调用停止，须由原登录刷新后更新私密副本；不能以重建任务、切换凭据来源或自动换模型掩盖失败。`api-key` 使用私有纯文本文件和明确的 DeepSeek 模型；两种方式都不会在缺失或过期时回退至其他模型。

每次调用使用新的私有 home、随机会话 ID 和只含当前任务的配置。Shell、文件工具和工作目录工具在宿主配置层关闭；原生规划仅接入 Worker 创建的 loopback Ontology MCP，并保留实际服务端读取与决策回执。文档及单次只读决策不接入工具。调用只在原提示已入会话、唯一模型回合成功结束、输出符合 JSON Schema 后返回；入队、空闲通知或模型文字不能单独证明业务完成。初始化最多 15 秒，MCP 单次调用最多 30 秒，总调用仍受原执行截止约束。

SDK 没有单会话取消接口，因此每次调用独占进程；取消、超时和关闭会终止并回收该进程组，再清理私有 home。外部来源返回后的执行与验收仍独立检查 EIGOS 原任务权限和领取身份。Harness Worker 固定一个并发领取，原 Codex Worker 保持已有两个并发上限。

Foundation 使用独立的 `harness-native` 模型通道。现有 `codex-native` 许可不会自动赋予它；启用前须审核实际模型接收方与数据出口许可，并通过已有管理入口配置相应通道及授权。部署预检按所选执行器核对通道，不自动修改权限策略。真实模型、Linux 候选部署、正式实例切换与业务完成须分别验证。

上游接口与边界：[Super-agent 执行说明](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)、[Harness SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)、[多模型与 OAuth](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md)。

## 一个共享存储

Gateway 和 Worker 必须使用同一个持久 SQLite 文件，建议设置相同的绝对 `DATABASE_PATH`。分进程不能使用 `:memory:`，也不能把数据库复制到两个位置来扩容。当前实现面向同机持久磁盘；跨主机需要另外的共享存储方案。

本体定义、发布引用、任务、授权和执行账本处于同一业务存储。新任务固定准确本体 release；Worker、MCP、A2A 和回读按该版本解析。会员登录会话使用独立会员库，Worker 不读取会员会话。详见[共享本体](../packages/ontology/README.md)。

## 领取与恢复

领取、续租和结果提交绑定 owner、任务 revision、领取令牌及有效期。队列准备完成后才开始新租约；迟到结果不能覆盖取消、改版或失效领取。未知外部效果保留原操作身份，只进行原键查证。

有效补充信息和技术恢复沿用原任务，保留累计预算和已确认事实。异步来源的健康等待使用持久 `nextAt` 与有界退避。重复校验失败可以暂停并等待修复；不能通过重置任务或伪造用户回复绕开问题。

Agent 的同类校验／完成失败在没有新投影来源证据或已核验 scope 恢复时，累计三次即技术暂停。改写模型解释、改变 JSON 排版或提交另一个同样失败的参数不会重置计数；原反馈及输入摘要保留。新的已验证来源结果允许继续修正，但不会清除累计任务预算或放宽最终验收。

Worker 每次心跳仍检查当前权限，并通过同步状态列提前察觉取消；该轻量提示不授予任何执行权限。完整任务正文、版本、权限与租约判定继续用于续租、派发和提交，只到续租时点才重查并续租原领取。标量领取检查保留重复 JSON 键的 `JSON.parse` 最后值语义和损坏记录拒绝行为，不把完整历史复制到临时大对象表。超时／关闭后的恢复写回使用独立 scope：保留原角色、授权、版本和租约校验，移除的仅是已中止的执行截止检查；原执行 scope 继续拒绝迟到结果。授权失效或租约已过期时，写回仍不得提交。

恢复元数据写回最多 45 秒，原任务执行截止时间、15 秒默认领取租约、来源新鲜度和业务授权期限均不因此延长。`run-local.mjs` 在关闭时最多等待 50 秒，再强制停止仍未退出的直接子进程；正式主实例的 LaunchAgent 显式设置 `ExitTimeOut=60`。当前 macOS 将更长的配置限制为 60 秒，因此必须同时回读配置和系统有效值，保持应用退出宽限在该上限内。关闭前后的恢复状态必须从原任务回读，不能仅以进程已经退出作为成功依据。

任务控制对象的来源证据与追加式读取审计分别维护。相同对象版本、正文和出向关系未变时，重复保存保留其原始输入证据；后来的读取不会反向成为旧记录的输入。关系改变、新对象或新版本仍合并当前完整输入约束。新模型产出使用新的计划、尝试或观察身份，不能仅因显示值相同复用旧来源；业务输出及验收结果继续记录当前模型信息约束。

来源复用不复用访问许可。同安装、同请求版本的替换授权可以保留已记录的来源，但字段、当前成员关系、来源权限、撤销和到期仍独立检查。旧绑定首次加入来源摘要时保守保留其已有依赖；不会为了提速删改历史约束。当前实现仍使用 SQLite 的同步读取边界，不能把它当成已完成 PostgreSQL 异步事务迁移。

只读任务可以由模型一次选择有界依赖图：独立查询并发执行，后续查询只使用原账本中已验收的具名输出。标量选择必须是动作定义中声明的纯函数，并与同一步、同一个输出端口的观察绑定；歧义、过期或权限变化会阻止后续查询，交回模型处理。组合步骤的每个 `inputRefs` 都须包含 `port`，包括计算标量的引用；缺少端口的原生提案在 MCP 提交时拒绝，模型可在同一会话内修正，Worker 的语义与权限检查继续独立执行。

原生目标允许模型通过 `plannedGoalCompletion` 预先选择各组件的未来证据和固定目标对应关系，仅适用于明确支持该能力的只读模块。Worker 在来源返回后重新读取证据，运行组件验证器、完整目标检查和原权限校验；预先选择验收条件本身不代表任务完成。未通过验收的计划保留原结果并进入下一次决策，不重新派发已确认的查询。

## 验证

```sh
npm run check
npm run build
npm run test:changed
npm run test:e2e:changed
git diff --check
```

默认按相对 `origin/main` 的全部分支改动选择测试，包含本地暂存、未暂存和新增文件。用 `npm run test:scope` 预览范围；其他基线传 `-- --base=<ref>`。全量回归、CI 触发与范围回退规则见[测试与 CI](guides/testing.md)。

自动测试使用隔离数据库和合成模型／来源。进程级测试验证真实进程与协议接线，仍不能证明真实商家操作或履约。实际业务验收需要独立来源回读。

`npm run ontology:check` 校验可编辑的供应商绑定，`ontology:sync` 将验证后的数据放入生成目录。构建自动完成同步。`dist/` 是构建产物，不是另一份编辑来源。

## 部署

正式运行统一为一个主权威，公网和私有兼容地址只承担传输入口。Gateway、Worker、Ontology MCP 共用同一任务库和发布注册库，见[统一运行与路由](architecture/runtime-authority.md)及[部署说明](guides/deployment.md)。代码同步、进程更新、已有数据库迁移和真实业务操作分别验收。已有任务不能因为代码更新而自动重放。

## Foundation 运行边界

默认 legacy 保留已有接口。foundation 要求独立持久任务库、JWT Agent 安装和匹配的权限策略；Gateway 发布短期资格，Worker 按原授权检查，不能读会员登录库或通过旧接口回退。现有模式、迁移、副本验证和来源资格见[本体权限指南](guides/ontology-security.md)。切换或部署须按实际授权执行，本次代码整合不等于某个实例已经迁移。
