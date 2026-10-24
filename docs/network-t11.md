# T11：获准的查询与验收摘要

2026-10-18。分支 `codex/network-t11` 接续 T10 `d729913`，已合入最新已提交的本地 UCP 本体/执行接入 `1650545` 和 Shopify 只读准入探针 `aa50b2a`。复用当前 ontology-execution-v7、结果投影、OutcomeAssessment、内部反馈和 T06–T10 权限/发布事务；原工作区文件保持不动。没有部署、开放真实交易或进行新的真实来源调用。

## 实现方式

摘要由服务器从本人已有结果生成固定字段与固定文案，先形成私有 EvidenceCard，再通过原草稿→会话批准→单次 PublicationGrant→发布流程共享。助手不能提供 evidenceLevel、outcome、safeSummary、地址、任务链接或供应商原文来替代服务器投影。

不生成新报价、不启动模型、不读取商家接口，也不直接开放 outcome_feedback 表。来源仅接受本人 Task 或 T10 inquiry 的私有引用；静态文件、探针报告、外部 URL 和社交正文不是验收来源。Shopify 新探针继续承担原准入检查职责，不自动变成 EvidenceCard 或履约证明。

公开卡片使用新生成的稳定 UUID，不使用原 Task、订单或回执 ID。内部才保存 owner/Task 关联和版本摘要。

## 七个共享字段

| 字段 | 含义与限制 |
| --- | --- |
| serviceKind | 固定业务类别，来源于登记类型；未知类型为 other，不复制能力 ID、商家名或自由文本 |
| observedOn | 关联结果记录日期，精度到天；不是实际成交、送达或声明发生时间 |
| timeZone | 固定 Asia/Shanghai，明确日期口径 |
| resultKind | 查询报告、执行验收、本地内容、参与者声明或未核实结果 |
| outcome | 查询完成、验收通过、部分、失败、待核验、需人工、取消、证据不足或声明 |
| evidenceLevel | 下表的来源等级，由服务器推导 |
| safeSummary | 固定模板文案，不是对原文的自由摘要 |

卡片身份、版本、发布者 profile 和共享圈沿用公开网络元数据。**没有**原任务/订单/回执 ID、源摘要哈希、原始 reason/消息/反馈、精确地址、联系人、金额、凭据、适配器/商家 URL 或私有对象链接。来源引用与 sourceDigest 留在私有记录中；共享事件只带公开 card/publication 引用。

此方式通过允许清单避免复制敏感字段，不声称具备任意自由文本自动脱敏能力。通用 profile/need/message 文本仍受其原精确批准流程约束，T11 不扩大它们的安全承诺。

## 证据等级与含义

| 等级 | 条件与不能推导的结论 |
| --- | --- |
| synthetic_validation | 有效来源标记为合成，或处于合成验证环境；不能升级为真实查询/履约 |
| simulated_execution | 本地/沙箱业务动作的核验记录；UCP 测试结账和订单属于此类，不代表真实购买、到账或交付 |
| live_query | 当前验收与行动观察一致，受控只读回执、完整性摘要、当前本体来源关联及等级相符；目前支持现有配送报价和公共地点读取，不代表交易或履约，也不保证当前价格/可用性 |
| live_execution | 需要真实业务等级、有效业务对象回执与当前观察/验收相符；操作存在不等于履约完成 |
| live_fulfillment | 还必须是交付目标、验收通过、已验证交付状态，并由已有 actualArrival/remainingQuantity 和真实履约级证据支持实际到达、完整交付；仅 completed/order ID/反馈标签不足 |
| local_generation | 已验收的本地内容生成；brief/document 完成不能写成底层业务目标完成 |
| participant_statement | 发布者明确选择的有限声明，始终标注未独立核验 |
| insufficient_evidence | 来源、当前观察或验收不足，不能用登记能力、模型文本或状态补足 |

等级不是用户输入，也不由单独的 binding verification 或 feedback 标签决定。合成 SourceReceipt 与 sandbox 环境不会因反馈写成 live_fulfillment 而升级。晚到的观察改变了当前行动状态后，旧 completed 状态不能保住原验收结论。

真实履约是严格证据门槛，不是本项目当前已有真实履约接入的声明。本轮没有真实履约材料或实测；现有本地 UCP 和六类业务域仍按沙箱/合成证据处理。独立测试中使用带 live_readonly 标记的受控形状夹具，仅验证等级判别，不算真实查询证据。

摘要是历史记录，不重新查询来源。报价五分钟刷新窗口不等于摘要的有效期；摘要不含价格，并明确不能保证当前价格/可用性。来源事实、验收或定义被纠正时，旧摘要会停止作为当前有效卡返回。

## 接口与权限

新增绑定权限 `evidence.manage`，旧绑定不会自动获得。准备/刷新需要 network:write、tasks:read、当前合法 actor 与该绑定权限；没有增加 OAuth 默认权限或网络准入。

| 接口 | 输入/行为 |
| --- | --- |
| evidence.prepare | source={kind:task,taskId} 或 {kind:inquiry,inquiryId}；projection={kind:result} 或受限声明；生成私有卡片，尚未共享 |
| evidence.refresh | cardId、expectedRevision、projection；重算同一来源/卡片，发生变化才递增 revision |
| draft.create/update | content={kind:evidence_card,cardId,cardRevision}；正文由服务器生成，不接受 body |
| publication.request_approval/publish/replace/withdraw | 沿用原接口和单次许可；evidence_sharing 目的绑定准确内容/卡片版本/受众/期限 |
| network_query kind=my_evidence | asProfileId、cardId；本人当前绑定＋tasks:read 可看私有预览及 current 状态 |
| network_query kind=evidence | cardId、spaceId；返回当前对查看者可见的获准版本 |
| search objectKind=evidence_card | 圈内受众过滤、分页，不提供全局计数或评分 |

涉及结果摘要的草稿、审批读取和回执重放继续检查 tasks:read；发布时重新校验源结果及卡片版本。接收者只需网络读取资格与批准受众权限，无需也不会获得作者的 tasks:read。

参与者声明只支持 result_received、service_received、problem_reported 三个代码。文案固定并标明“未作为独立核验或履约证明”，不接收任意陈述正文或“已核实”等标记。

my_evidence 的 current 仅表示预览仍匹配当前来源，不表示已经批准或共享。

控制者在 `/members/network` 查看准确七个字段、受众和期限后批准。会员会话、同源 Origin、CSRF、原安装绑定与撤销 fence 保持。圈管理员和审核员没有跨 owner 读取私有结果的旁路。

## 去重、纠错与撤回

- 唯一 `(owner,Task)` 对应一个稳定 cardId；通过 inquiry 或 Task 引用同一结果不会复制卡片。同一 owner 换 profile 也不能另建同一结果的卡片。
- 同卡在同圈至多一个当前发布；其他圈共享仍使用同 cardId。客户端按逻辑 cardId 识别同一结果，不把不同发布副本/重放事件当作多次成功。
- 不做跨主体真实订单去重或公共商家总评分，没有把选择性公开样本当作完整分母。
- 源数据改变时旧共享立即不再读回；evidence.refresh 产生新卡片版本，必须新建准确草稿并重新批准后替换。旧许可不能被新结果沿用。
- 撤回 publication 或撤销已使用许可停止该共享；同一卡片、同圈已经批准但未发布的重复许可也被撤销，避免后台旧草稿重新发出。再次共享需要新的明确批准；其他圈的独立批准不被静默扩大或取消。
- 卡片、原结果和审计记录保留；回执只返回引用/当前不可用状态，不缓存重放旧正文。成员移除、身份停用与新成员不读旧内容继续沿用 T06/T07。

这里的一次结果按 owner/Task 识别；当前不尝试用私有订单号跨账号关联现实世界事件。

## 持久化与动态衔接

只增加私有 network_evidence_cards 表及唯一索引。发布对象、许可消耗、原 network_events 与命令回执继续使用同一事务和唯一事件写入路径。没有新增外发队列。

私有任务、反馈、行动观察所对应的 intent 或本体对象/关系变化，在源写入事务中只递增可见性版本，不向事件写入原 Task ID/地址。原共享投影在每次读取时重查来源摘要；旧动态游标返回 CURSOR_STALE/resetRequired，要求清除对应缓存。部分本体变动采用保守 owner 级失效，可能导致额外重读，但不会增加访问权。

摘要策略/当前 backend/模型定义指纹也绑定到来源版本和动态策略上下文。当前实现只解释当前后端与已登记定义，不把历史 schema 静默升级成新事实。未来改变等级判定语义时应推进证据策略版本。

准备、审批、发布与读取均为同步有界本地操作；不调用模型或供应商。来源关联读取采用本体已有预算，超界拒绝，不能静默截断成完整成功结论。

## 会员页面与验收

圈目录新增“查询与验收摘要”；详情为 `/members/network/spaces/:spaceId/evidence/:cardId`。T09 动态仅链接这个公开卡片入口，不导航到私有 Task 或来源 URL；页面和 HTTP/MCP 使用同一共享投影。

[验收记录](evidence/network-t11-2026-10-18/README.md) 包含字段允许清单、私有标记检查、等级反例、源变化、撤销中断待发布草稿、重复发布、事务故障与重开恢复。验证使用合成身份/来源/模型，以及本机 UCP 线协议夹具；不是生产发布、真实查询或真实履约实测。

网络仍默认关闭。本轮没有部署、实际平台发布、新增真实权限、真实商户交易或外部消息发送。T12/T13 的联合界面与真实参与者验收仍应独立完成。
