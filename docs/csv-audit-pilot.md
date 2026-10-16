# CSV 审计本地模拟试点

此实现只验证 EIGOS 的本地购买、交付、验收与失败补救。未连接支付宝、阿宝或真实商户，没有真实付款/退款，也不表示支付宝沙箱联调通过。

## 运行

```sh
npm run demo:csv-pilot
```

输出 `output/csv-audit-pilot/summary.json`；三个目录 `none`、`bad-once`、`bad-always` 中保存完整任务与提供方账本 `trace.json`。前两个同时交付 `report.json`、`report.md`。失败场景不输出看似合格的报告，trace 保留拒绝原因、失败文件摘要与模拟退款结果。每条链路只能产生一笔模拟付款；退款申请与退款完成分别经过独立 tick。

脚本不读取 `.env`、不调用模型、支付 CLI 或外网。故障注入只通过测试/演示构造器，不是面向客户的工具参数。测试临时数据库会清理，输出目录保留为交付证据。

## MCP / A2A

在已配置的本地网关环境中设置 `EIGOS_CSV_PILOT=true`，再启动服务器。默认关闭；非 loopback 或 production 配置拒绝启动。现有认证、任务权限和 owner 隔离继续生效。

MCP `submit_task` 参数：

```json
{"service":"data.quality.audit.simulated","goal":"检查导入数据","datasetId":"duplicate-and-missing-v1","requestId":"audit-001"}
```

预置数据集仍有 `clean-v1`、`duplicate-and-missing-v1`、`invalid-values-v1`；另支持指定目录中的真实 CSV 文件，见下文文件输入。工具不接受任意路径、外部 URL 或客户自定故障。报价固定模拟 100 分 CNY，10 分钟内确认。

返回 `input-required`，从 `pilot.quote.id` 和 `pilot.quoteDigest` 取得确认对象，再调用 `reply_to_task`：

```json
{"taskId":"返回的任务UUID","requestId":"approve-001","action":"confirm_simulated_payment","quoteId":"返回的报价UUID","quoteDigest":"返回的64位摘要"}
```

普通 `answer: "yes"` 不会触发付款。相同 requestId/内容返回原操作快照，使用 `get_task` 读取最新状态。更换数据集或复用请求号发送不同参数会被拒绝。

A2A 使用单个 structured data part 传同样的提交/确认对象，省略 requestId；以 messageId 幂等，确认时在消息层带 taskId。普通文本不会触发模拟付款。任务通过 `GetTask` 轮询；`metadata.pilot` 与 MCP 的 `pilot` 是同一业务记录。此服务始终返回当前状态，即使未设置 returnImmediately，也不阻塞等待多次 worker tick。

成功 artifact 包含两个报告正文和摘要；报告明示模拟环境。任务、付款、验收、补救分别存储。已付款不自动 completed，退款后任务仍 failed。取消后晚到付款事实会继续对账，不把 canceled 当成资金已退。

## 验收和恢复

供应商按五类规则生成报告。预置数据集的独立验收使用人工可核对的固定 golden 结果；文件输入则由独立的原始字节解析器和另一套规则计算重新验证。两者都不调用供应商计算函数，检查问题行号精确集合、订单、输入摘要及 Markdown 的一致性。邮箱仅检验简化格式，不检查账号存在。

无交付时同订单最多三次读取（首次加两次重取），随后一次补交；不合格报告直接请求一次补交。补交仍失败则模拟退款。支付未知与退款长时间未确认进入 needs_review，不能自动重复付款或声称退款完成。测试使用注入时钟，无真实等待。

保存报价/授权、状态、trace/checks 和小型文件正文于 Job.pilot；这份持久状态的 step/nextAt/deadline 就是待办。独立 `pilot_ledger` 保存模拟提供方的付款、退款与每次交付；通知去重与唤醒复用事务性 requests 收据。没有外部网络动作在 JobStore.once 事务内运行。

相对最初方案，首版没有拆成四张业务表或增加通用任务队列：限定单实例、同进程串行同步 tick，状态保存为 SQLite JSON。付款效果先进入独立账本，随后任务保存；两步间崩溃会按同一订单查询恢复。重启不会将该服务的 working 任务套用文档执行器的失败策略。

模拟通知通过内部 receiver 测试 HMAC、表单解析、去重、原子唤醒和迟到事件；没有公开回调路由，HMAC 不是支付宝 RSA2/From 消息实现。未来真实异步连接器、任意字段映射、大文件上传、生产密钥和真实付款仍需要单独实施，不能切换 URL 就上线。

## 验证

```sh
npm run check
npm test
npm run build
npm run demo:csv-pilot
```

专项测试覆盖固定预期、错行号/文件篡改、跨用户隔离、确认摘要与有效期、重复请求、未知支付、补交/退款、提供方成功后崩溃恢复、取消竞态、伪造/重复通知；真实 loopback HTTP 验证 MCP→A2A 和 A2A→MCP 两个方向及相同交付读回。

最近核验：2026-10-15，类型检查、48 项全套测试、构建、三条演示通过。输出文件哈希与 trace 一致。证据入口：[演示汇总](evidence/csv-audit-pilot-2026-10-15/summary.json)。这只证明本地合成场景，不证明外部供应商的履约能力。

## 真实 Agent 客户端演示

`npm run demo:csv-agent -- output/csv-real-agent-new` 启动三个临时 loopback 网关及真实 Codex CLI 客户端，需要本机已有 Codex 登录。此次模型推理使用真实模型服务，可能消耗模型额度；业务付款始终模拟。脚本不加载项目 `.env`，不启用其他业务连接器。

客户端通过直接 HTTP MCP 和一个薄 MCP→A2A JSON-RPC 转发工具交叉调用。转发工具不下单编排、不代填报价、不决定确认；任务、参数、确认和轮询由模型产生。A2A 发生在真实本地 HTTP `/a2a`，不宣称 Codex 原生 A2A 客户端能力。

使用 Codex `--approve-for-me` 对工具调用进行审批，不把修改工具伪装成只读，不关闭全部审批。客户端不提供 shell、浏览器、插件或其他业务工具；仅装载三个模拟网关和一个转发工具。凭证临时生成，经环境变量传递，结束后销毁；没有写入用户全局 MCP 配置。每次演示请使用独立输出目录以保留不同运行证据。

`agent-events.jsonl` 保存工具调用/结果和最终回执，不保存隐藏推理；各场景 HTTP 日志记录协议入口；`*-readback.json` 由演示结束后独立读取数据库产生。`verification.json` 只有模型真实结束且三个场景的订单数、付款次数、交付/补救状态全部符合预期才生成。临时网关和数据库结束后关闭/清理，报告和证据保留。

## 真实 CSV 文件输入（付款仍为模拟）

配置 `EIGOS_CSV_PILOT=true`、`EIGOS_AUTH_MODE=development` 和 `EIGOS_CSV_INPUT_DIR=/专用输入目录`。只允许本地 development 身份。网关读取指定 basename，不扫描其他目录、不接受绝对路径/路径穿越、不跟随文件符号链接。目录应专门存放已授权审计的文件，不要将整个 Home 作为输入目录。

```json
{"service":"data.quality.audit.simulated","goal":"审计这份CSV","fileName":"orders.csv","requestId":"file-audit-001"}
```

`fileName` 与 `datasetId` 二选一。文件在首次下单时一次性读入并保存不可变快照，任务、报价和报告绑定原始文件字节 SHA-256。原路径之后的修改不会改变已有订单；使用新 requestId 创建新订单才能审计新版本。幂等重试复用原快照，不重复读文件或收费。输入内容只保存在本地数据库的内部记录，不返回给模型；模型可见文件名、摘要、大小、记录数及不含原始单元格值的报告。数据库及其备份仍含输入原文，应按本地数据保管。

支持：UTF-8（可有 BOM）、逗号分隔、CRLF/LF/CR 换行、双引号字段、双引号转义、字段内逗号和换行。纯空物理行跳过，`",,,"` 等非空记录不会被当成空行忽略。空白在解析后从字段两端移除；未加引号字段中出现引号或闭引号后有多余字符会拒绝。

限制：文件 1 MiB、1–1000 条数据记录、最多 32 列、单记录缓冲最多 64 KiB。必须有且仅有一列 `record_id`、`email`、`amount_cny`、`event_date`，列序任意，额外列可存在但不审计。所有表头不得为空或重复。支持数据记录序号，**不把含换行字段的物理行号当作记录序号**。邮箱检查仅是格式；金额非负且至多两位小数；日期必须是真实的 0001–9999 年日历日期。尚未支持任意业务字段自动映射、GBK、Excel 或远程上传。

供应商采用锁定版本 `csv-parse`；文件验收器使用独立字符状态机解析原始快照，另以独立算法计算重复、缺失、邮箱、金额和日历规则，不调用供应商 parser/producer/render，也不依赖预置 golden。收到错误报告后仍按原订单补交；若输入快照损坏，不能悄悄重新读取不同文件，转入证据不足和模拟退款。

生成一份新的非预置 CSV 并让真实 Agent 验证三条链路：

```sh
npm run demo:csv-agent -- output/csv-file-new-run --generated-file
```

使用明确指定的真实文件：

```sh
npm run demo:csv-agent -- output/csv-file-own-run /absolute/path/orders.csv
```

演示将这一个文件复制到隔离输入目录，原文件不修改；只有自动生成的测试文件会另存到输出目录，用户文件原文不另行导出。模型服务是真实的，可能消耗模型额度；付款及供应商故障模拟。独立核验程序在模型结束后再次从输入字节核对最终报告，保存 input-manifest 和验证结果。输出目录必须为空，避免混合多次证据。
