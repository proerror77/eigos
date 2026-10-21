# EIGOS · 艾戈斯

Consider It Done. — The Execution Network for AI Agents.

EIGOS 使用一个仓库、独立 Gateway／Worker 和共享任务库。业务委托使用 **Ontology + LLM**：理解原始需求、取得受控来源的事实、校验计划、执行和独立验收。Personal Agent 可通过 MCP 或 A2A 调用同一任务与认证系统。

## 当前能力

- 四类动态定义：Object Type、Link Type、Interface、Action Type 支持持久草稿、校验、不可变发布及原子激活；新任务锁定发布版本。声明式受管数据动作复用现有授权与 Worker，配 HTTP/MCP 管理入口和基础审查页面。见[动态定义实现与边界](docs/dynamic-ontology-implementation-2026-10-21.md)。

- `eigos.delegate` 是统一业务入口。模型根据实际注册的本体选择能力，不要求 PA 知道内部能力 ID 或提供者地址 ID。
- `delivery.quote@3`：Agent 读取本体，选择本人地址簿、已选地址详情和费用预估动作；每个动作只调用一个官方只读接口。缺少信息在同一任务补充，会员各用自己的授权。[实现与验证边界](docs/paotui-agent-actions-2026-10-19.md)。只查价，不下单、不付款。
- `geo.search@1`、`address.book.read@2`：本人地点／地址只读查询。
- `brief.prepare@2`：生成任务说明，底层业务仍 `execution=not_started`。
- `document.compose@1`：显式开启文档模型后产生 Markdown 草稿；不代表执行文档中的业务。
- `data.quality.audit.simulated@2`：专用本地 CSV 的完整五项审计、模拟许可与独立验收。
- N1 业务对象模型：28 个具体类型、Offer／EvidenceBacked 接口、双向关系、有界查询和九个只读计算。MCP 与 HTTP 使用现有认证；[接口与验证](docs/ontology-n1.md) 已用三个场景合成数据验证。
- 六类服务本体：新增打车、医院挂号、外卖、酒店、行程安排、预约用车／自驾租车的对象、关系、规则、决策 Action、沙箱执行和独立验收。[实现与真实接口缺口](docs/service-domains-2026-10-18.md)及[当前模型完整性复审](docs/ontology-principles-review-2026-10-20.md)分别记录覆盖范围。[六类真实模型与 18 题独立调查](docs/service-domain-validation-2026-10-18.md) 已在合成来源上通过，真实接口仍未接通。
- N2 模型规划：解释和规划阶段可主动读取对象、核对类型化条件并提出不执行的业务决策提案。固定证据／版本、权限及取消边界由程序检查；[实现与验证](docs/ontology-n2.md) 使用独立 Agent 和真实模型、合成业务数据。
- UCP 本地商家接入：通过正式签名 HTTP 请求创建结账、取得准确模拟许可、确认并独立读取原订单；已用真实模型和独立官方商家进程验证。[实现与边界](docs/ucp-local-integration-2026-10-18.md)。交易执行仅支持显式配置的本地测试商家。
- Shopify 公开商品查询 `commerce.catalog.query@2`：EIGOS Agent 读取本体，选择和组合搜索、变体详情、商家发现及店铺读取；连接器每次只调用一个接口。来源观察写回本体后，模型继续决策并选择最终结果，程序独立验收。[实现与验证状态](docs/catalog-agent-actions-2026-10-19.md)。默认关闭，仅限本机本人、配置商家、美国市场和匿名只读；库存数量、配送、商家合作、账号令牌及交易未验证。
- 订单、模拟支付、交付、取消退款的恢复状态机仅在明确配置的本机沙箱验证。现实业务副作用仍禁止。

旧需求登记、直接执行、跑腿订单和 CSV pilot 的独立业务入口及执行器已经删除。历史记录可以按原归属读取，不自动迁移或恢复执行。当前接口与配置见 [接入指南](docs/integration.md)，各能力与证据边界见 [后端说明](docs/registered-capabilities.md)。

后续实现按 [Ontology v0.2 规格](docs/ontology-spec-v0.2-2026-10-18.md) 及依据 Palantir 官方指南修订的[对象／接口／关系目录](docs/ontology-model-catalog-v0.2-2026-10-18.md) 推进。[独立业务问题](docs/ontology-drill-questions-v0.2-2026-10-18.md) 已由两个新上下文 Agent 演练，复测九题通过数据与查询记录复核；[人工非建模者演练](docs/ontology-n2-human-drill.md) 尚未运行。四模块及后续契约见 [完整设计核对](docs/ontology-design-completion-v0.2-2026-10-18.md)，N0～N5 门槛见 [阶段目标](docs/backend-implementation-goals.md)。

仓库当前运行契约为 `ontology-execution-v16`；本体由持久发布注册库解析，初始 active 内核为 `eigos.business@16`，原始 v15 保留为不可变历史基线。Agent 通过本体读取当前需求、业务对象、动作定义、执行步骤及结果；模型读取回执与宿主执行校验分别核对。Shopify 和跑腿使用 Agent 动作循环，固定操作保留显式实现绑定。网络协作保留原始权威存储，通过按当前身份和可见范围校验的只读本体视图追溯；领域属性、来源身份和执行输入的补足范围见 [架构验证记录](docs/ontology-architecture-completion-2026-10-21.md)。业务链已把委托主体、执行方案、真实许可账本、已验证结果、逐项验收和售后关联，见 [业务链实现与验证](docs/business-chain-implementation-2026-10-20.md)。增量兼容只接受已核验的定义摘要，保留事实和历史；旧模型计划不自动重新执行，私有运行版本以对应部署回读为准。

主干与会员实现的整合、增量兼容边界及认证接口回读见 [2026-10-21 整合记录](docs/ontology-integration-readback-2026-10-21.md)。Agent 沙箱业务步骤也关联准确的方案、许可和验收；类型登记不表示真实供应商已经接通。 通用概念分层另参考 [BFO／CCO／IAO／PROV-O 对照](docs/research/bfo-foundation-alignment-2026-10-21.md)，当前仅完成术语澄清与参考映射，未声明形式本体对齐。

默认关闭的预约付款能力保留两条 Link 路线：优先 PA 的 Link Agent Wallet，不可用时交给用户在服务商的普通 Link 结账页确认；EIGOS 再独立回读原付款与预约。当前钱包与结账页均为隔离测试实现。见 [PA 预约付款流程](docs/pa-booking-payment-flow.md)。

模型上下文精简、按依赖并发读取及国内／跨关境运输关卡见 [实现与性能对比](docs/context-and-shipping-2026-10-20.md)。

交易沙箱从未知商家、国家和地址开始，Agent 查询授权 PA 上下文、商家、库存、运输、清关及完整费用，再按准确计划取得沙箱许可。购物车、订单、支付和实际交付各有独立证据；所有新业务来源均为合成数据，真实订单和付款仍禁止。实现、启用方式与验证范围见 [Agent 交易履约沙箱](docs/commerce-agent-sandbox-2026-10-19.md)。

`commerce.journey.sandbox@2` 将[海关资料与硬关卡](docs/customs-policy-2026-10-20.md)接入同一循环。Agent 实际读取当前任务的规则与官方参考资料，并在报价、结账、下单前计算 `customsGateStatus`；运行时再次核对，PA 授权不能覆盖未知、过期、冲突或缺失证据。当前通过状态仅为 `pass_sandbox`，不构成真实进口许可。

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

最新明确更正覆盖对应旧值，未更正字段及历史来源保留；外部回复绑定实际问题版本。可恢复技术故障在原任务自动继续，三次相同故障后等待运行修复，不要求用户重复确认。`amend_task` 更新开放的只读任务，`resume_task` 恢复技术暂停，`get_member_usage` 按会员独立累计用量，当前不设会员额度上限。任务防失控预算仍为标准每段32次／累计128次模型调用；长任务 `extended` 为每段64次／累计256次。有实质进展时自动续办窗口，累计记录保留。已确认地址经过当前来源核对后继续使用。详见[任务恢复与执行预算](docs/task-recovery-2026-10-20.md)。

## 本人的常驻 PA 连接

```sh
npm run build
npm run setup:pa
```

macOS 的既有 `com.eigos.grok-life` launchd 服务使用新架构，保留 `127.0.0.1:3430`、原凭据和任务库。部署生成不可变代码快照、私有数据库备份，并核对健康端点的构建摘要。`-- --restart` 可验证重启；旧运行快照只在私有备份保留。

PA 读取 `~/.local/share/eigos/grok-life/skill-install.md` 更新现有接入技能，使用同目录的 Python 客户端与 profile。新默认和允许的服务均为 `eigos.delegate`。运行在用户 Mac 上的 PA 才能访问 loopback；Mac 休眠、离线或上游授权失效会影响查询。见 [常驻连接](docs/life-request-intake.md) 和 [地址选择／查价](docs/meituan-paotui-integration.md)。

## 认证与生产边界

MCP、A2A 共用 OAuth/JWT、会员资格、任务归属和 scope 校验。生产认证默认拒绝缺失配置；本地随机开发令牌只允许 loopback。会员与客户端自助登记、续期见 [会员资料库](docs/membership.md)、[Agent 接入](docs/agent-onboarding.md) 和 [Auth0 配置](docs/auth0-integration.md)。[会员自有账号授权](docs/member-source-authorization.md)允许各会员的 PA 通过独立通道提交本人的只读来源凭据；按 owner 加密隔离，支持连接、轮换、撤销和原任务恢复。默认关闭，只限非生产 loopback HTTPS/JWT；没有部署或真实交易。原[单会员操作人连接](docs/member-source-connection.md)作为互斥兼容模式保留。

Gateway 不运行模型或业务程序。Worker 事务外调用，任务领取、取消、租约、迟到观察及未知结果恢复由共享核心约束。当前部署限同机持久 SQLite，不支持网络文件系统或跨机器数据库副本。具体职责见 [Gateway／Worker](docs/gateway-worker.md)。

## 邀请制 Agent 协作试点

T06/T07 的身份、精确发布许可、邀请圈和服务目录已扩展到 [T08 需求与结构化回应](docs/network-t08.md)。支持经本人批准的需求发布、关闭、回应和一跳服务推荐；不会创建私有询价或执行交易。网络默认关闭，当前验证为隔离合成测试，未部署。后续 [T09 私有关注与增量动态](docs/network-t09.md) 支持有界分页、检查点和重启续读，权限变化时要求重新同步。后续 [T10 私有询价与方案](docs/network-t10.md) 可在买方会话确认后，使用获选且实际有权限的只读报价绑定创建本人 Task，并保存受条件约束的报价选择；当前为合成工程验证。后续 [T11 获准摘要](docs/network-t11.md) 以固定字段区分查询、模拟执行与验收证据，先批准再共享，并在来源纠正时停止返回旧有效卡。新增 [T12 工作台与协议联调](docs/network-t12.md) 串起私有任务、询价和授权；[T13 联合验收](docs/network-t13.md) 已完成工程链验证，人工及真实 PA／来源门槛仍待完成。接口见 [接入说明](docs/integration.md)。

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
