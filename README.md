# EIGOS · 艾戈斯

Consider It Done. — The Execution Network for AI Agents.

EIGOS 使用一个仓库、独立 Gateway／Worker 和共享任务库。后端唯一执行路径为 **Ontology + LLM**：理解原始需求、取得受控来源的事实、校验计划、执行和独立验收。Personal Agent 可通过 MCP 或 A2A 调用同一任务与认证系统。

## 当前能力

- `eigos.delegate` 是统一业务入口。模型根据实际注册的本体选择能力，不要求 PA 知道内部能力 ID 或提供者地址 ID。
- `delivery.quote@2`：读取本人美团保存地址，在同一任务提供选项并收集寄件、收件、物品、重量和服务；选择明确后，经 Ontology MCP 查询并复查真实运费。只查价，不下单、不付款。
- `geo.search@1`、`address.book.read@1`：本人地点／地址只读查询。
- `brief.prepare@2`：生成任务说明，底层业务仍 `execution=not_started`。
- `document.compose@1`：显式开启文档模型后产生 Markdown 草稿；不代表执行文档中的业务。
- `data.quality.audit.simulated@2`：专用本地 CSV 的完整五项审计、模拟许可与独立验收。
- N1 业务对象模型：28 个具体类型、Offer／EvidenceBacked 接口、双向关系、有界查询和九个只读计算。MCP 与 HTTP 使用现有认证；[接口与验证](docs/ontology-n1.md) 已用三个场景合成数据验证。
- 六类服务本体：新增打车、医院挂号、外卖、酒店、行程安排、预约用车／自驾租车的对象、关系、规则、决策 Action、沙箱执行和独立验收。含商品只读扩展的全模型现有 66 类型、24 个函数；[实现与真实接口缺口](docs/service-domains-2026-10-18.md)。[六类真实模型与 18 题独立调查](docs/service-domain-validation-2026-10-18.md) 已在合成来源上通过，真实接口仍未接通。
- N2 模型规划：解释和规划阶段可主动读取对象、核对类型化条件并提出不执行的业务决策提案。固定证据／版本、权限及取消边界由程序检查；[实现与验证](docs/ontology-n2.md) 使用独立 Agent 和真实模型、合成业务数据。
- UCP 本地商家接入：通过正式签名 HTTP 请求创建结账、取得准确模拟许可、确认并独立读取原订单；已用真实模型和独立官方商家进程验证。[实现与边界](docs/ucp-local-integration-2026-10-18.md)。交易执行仅支持显式配置的本地测试商家。
- Shopify 公开商品查询：显式配置后由 PA 委托 Worker，模型读取 `CatalogRead` 并计算 `catalogReadStatus`，店铺独立复查同一变体的价格和可售标记。[接入与 PA 验收](docs/shopify-pa-worker-2026-10-19.md)。默认关闭，仅限本机本人、配置商家、美国市场和匿名只读；库存数量、配送、商家合作、账号令牌及交易未验证。
- 订单、模拟支付、交付、取消退款的恢复状态机仅在明确配置的本机沙箱验证。现实业务副作用仍禁止。

旧需求登记、直接执行、跑腿订单和 CSV pilot 的独立业务入口及执行器已经删除。历史记录可以按原归属读取，不自动迁移或恢复执行。当前接口与配置见 [接入指南](docs/integration.md)，各能力与证据边界见 [后端说明](docs/registered-capabilities.md)。

后续实现按 [Ontology v0.2 规格](docs/ontology-spec-v0.2-2026-10-18.md) 及依据 Palantir 官方指南修订的[对象／接口／关系目录](docs/ontology-model-catalog-v0.2-2026-10-18.md) 推进。[独立业务问题](docs/ontology-drill-questions-v0.2-2026-10-18.md) 已由两个新上下文 Agent 演练，复测九题通过数据与查询记录复核；[人工非建模者演练](docs/ontology-n2-human-drill.md) 尚未运行。四模块及后续契约见 [完整设计核对](docs/ontology-design-completion-v0.2-2026-10-18.md)，N0～N5 门槛见 [阶段目标](docs/backend-implementation-goals.md)。

仓库当前运行契约为 `ontology-execution-v7`、业务模型为 `eigos.business@5`。本轮六类服务扩展未更新本人常驻部署；历史任务及对象不自动迁移或重新执行。

## 本地开发

要求 Node.js 22.13+；新后端使用已安装并登录的 Codex CLI。

```sh
npm ci
npm run setup:dev
npm run dev
```

`dev` 启动独立 Gateway 和 Worker，共用同一个本机 SQLite 文件。默认启用新协调器。`EIGOS_COORDINATOR=disabled` 和 `EIGOS_PAOTUI_ORDERS_ENABLED=true` 均被拒绝，不会进入旧模式。

| 入口 | 默认地址 |
| --- | --- |
| 健康与运行版本 | `http://127.0.0.1:3000/health` |
| MCP | `http://127.0.0.1:3000/mcp` |
| A2A Agent Card | `http://127.0.0.1:3000/.well-known/agent-card.json` |
| A2A JSON-RPC | `http://127.0.0.1:3000/a2a` |

新建任务返回 submitted，由 Worker 持久领取。缺少业务信息返回 input-required；PA 向用户转述真实问题，在同一个 taskId 回复。完成以服务端 accepted 验收和实际交付物为准。请求 ID 用于防重，网络超时后查询原任务。

## 本人的常驻 PA 连接

```sh
npm run build
npm run setup:pa
```

macOS 的既有 `com.eigos.grok-life` launchd 服务使用新架构，保留 `127.0.0.1:3430`、原凭据和任务库。部署生成不可变代码快照、私有数据库备份，并核对健康端点的构建摘要。`-- --restart` 可验证重启；旧运行快照只在私有备份保留。

PA 读取 `~/.local/share/eigos/grok-life/skill-install.md` 更新现有接入技能，使用同目录的 Python 客户端与 profile。新默认和允许的服务均为 `eigos.delegate`。运行在用户 Mac 上的 PA 才能访问 loopback；Mac 休眠、离线或上游授权失效会影响查询。见 [常驻连接](docs/life-request-intake.md) 和 [地址选择／查价](docs/meituan-paotui-integration.md)。

## 认证与生产边界

MCP、A2A 共用 OAuth/JWT、会员资格、任务归属和 scope 校验。生产认证默认拒绝缺失配置；本地随机开发令牌只允许 loopback。会员与客户端自助登记、续期见 [会员资料库](docs/membership.md)、[Agent 接入](docs/agent-onboarding.md) 和 [Auth0 配置](docs/auth0-integration.md)。个人美团授权只限本人本机，不是多用户凭据代理。

Gateway 不运行模型或业务程序。Worker 事务外调用，任务领取、取消、租约、迟到观察及未知结果恢复由共享核心约束。当前部署限同机持久 SQLite，不支持网络文件系统或跨机器数据库副本。具体职责见 [Gateway／Worker](docs/gateway-worker.md)。

## 验证与证据

```sh
npm run check
npm test
npm run build
npm run test:e2e:run
git diff --check
```

常规及工程 E2E 使用明确标记的模型／提供方 fixtures，验证协议、权限、计划、恢复与失败边界。真实 PA、模型和美团查询另行实测，不能由 CI 代替。阶段目标见 [实施记录](docs/backend-implementation-goals.md)；[2026-10-17 两段 E2E](docs/evidence/service-network-e2e-2026-10-17/README.md) 是临时实例历史证据，本次 [常驻自然语言流程](docs/evidence/persistent-pa-2026-10-18/README.md) 已验证地址选择、重启续接与真实查价。[公开地点发现验收](docs/evidence/public-geo-pa-2026-10-18/README.md) 已验证现有 PA 经 A2A、真实模型和新 DiscoverySource 读回“北京市／天安门”的 20 个地点；常驻新来源仅启用这一公开查询组合。

品牌与候选名称边界见 [品牌说明](docs/brand-brief.md)。项目规则见 [AGENTS.md](AGENTS.md)。
