# Person 与跨任务个人上下文

Person 是明确声明的自然人服务对象；Member／RequestingParty 是认证账号及委托主体；PA 是调用代理。参考 FIBO 的 [Person](https://github.com/edmcouncil/fibo/blob/master/FND/AgentsAndPeople/People.rdf) 和 OMG Commons 的 [情境与角色](https://www.omg.org/spec/Commons/PartiesAndSituations/)，身份、角色和账号保持分离。此实现采用其概念区分，不导入 OWL 或声明本体等价。

一期只支持本人。本人引用由服务端在 owner 范围内稳定生成，须通过 BindSelfPerson 明确声明；它不证明实名身份。不能用 Person ID、姓名、地址或接口可见性代替 ownerKey 和授权。

## 可复用关系

- `RequestingParty.selfPerson` 连接已明确声明的本人；`ServiceRequest.servedPerson` 说明本次为谁服务。
- `Person.serviceRequests` 提供任务历史关系。每条查询仍执行当前任务的数据权限过滤，不能从一个任务遍历到另一个未获准的任务。
- 任务的 `activityContext`、`travelContext`、`transportContext`、`lodgingContext`、`productContext`、`destinationContext` 使用已有 Scheduled、OriginDestination、Located、ProductVariant、Addressable 契约。它们表示本次选中的业务上下文，不证明报名、预订、入住或履约已经成功。
- 活动、航班、酒店、交通仍是现有业务对象。一个机场可同时作为已选航段的出发地和机场交通的目的地，不复制地点或为各场景建立新的安排中心。
- 结果继续沿 `ServiceRequest → BusinessResult / ServiceArtifact` 查询；原执行账本仍是动作与验收的权威记录。

## 个人事实与本次选择

`PersonalPreference` 一项记录表达一个有类型的已确认默认值：

| key | value | 边界 |
| --- | --- | --- |
| rideClass | `{ "kind": "rideClass", "value": "comfort" }` | 用户的车型偏好文字，需匹配供应商实际选项；不是供应商车型代码或叫车授权 |
| deliveryAddress | `{ "kind": "deliveryAddress", "address": { "type": "SavedAddress", "id": "已有地址ID" } }` | 引用已有地址；不是当前位置，地址内容和权限单独核对 |

每项关联 Person，保留自身 revision、数据版本和来源。它只允许管理明确交给 EIGOS 的默认值；PA 的个人资料继续由 PA 管理。已确认默认可通过 paDefaults 附上类型化 value、sourceReference、sourceVersion、observedAt 和 userConfirmed:true；它被标为“已认证 PA 报告”，并不宣称宿主已独立验证用户确认。该快照仅进入本次任务事实，不写回 EIGOS 长期默认。未确认推测被拒绝。Member 的语言、时区等既有资料仍由 Member 管理，本期不增加另一份可写副本或自动同步所有资料。

提交任务时可以附带：

```json
{
  "goal": "按已选航班安排去机场的交通",
  "personalContext": {
    "self": true,
    "preferences": ["rideClass"],
    "resources": [
      {"object":{"type":"TravelLeg","id":"实际航段ID"},"revision":1,"fields":["startsAt","endsAt"],"role":"travel"},
      {"object":{"type":"RideRoute","id":"实际路线ID"},"revision":1,"fields":["origin","destination"],"role":"transport"}
    ]
  }
}
```

所有引用必须来自已知的实际对象。Foundation 在发放本任务 grant 时核对当前安装实例的字段上限、对象角色、准确版本及来源要求，只绑定明确选中的输入。读取身份所需的主键／标题字段也必须获准；不会读取全部个人资料后再删减。

`read_task_context` 返回同一任务的 `personal` 引用与具名关系。有效默认值固定成现有 `RequestFact`，`personalBasis` 记录真实偏好引用及版本；`source` 记录选择该事实的任务指令。默认值不会被伪装为新的用户消息。旧事实、RequestSpecification、计划和订单不因长期资料更新而被改写。

优先级是：本次明确覆盖或清除 → 已确认、适用的默认值。未提供覆盖与明确 null 不同；null 抑制默认回填。未确认推测不作为默认值。一项默认值的更新不能覆盖本次明确要求。若显式选取的 PA 与 EIGOS 默认互相冲突，事实保持 ambiguous 并保留两个来源，不按到达顺序选一个；同一 PA 来源的迟到版本或同版本不同值被拒绝。

```json
{"personalContext":{"self":true,"preferences":["deliveryAddress"],"overrides":{"deliveryAddress":null}}}
```

个人偏好与当前行程变化会使依赖旧版本的决策失效。需要刷新时，对同一开放的只读任务使用 `amend_task`（A2A 使用 `taskOperation=amend`），带当前 expectedRevision、真实说明和 personalContext。遗漏的覆盖和资源引用保持原值；明确传 `resources: []` 才解除当前任务的资源关联。新的输入 grant 不延长原期限或扩大父授权。已经固定业务写入或需要恢复原操作的任务不能通过这个入口改变参数。

## 受控修改

使用现有 `prepare_ontology_action → approve_ontology_action → Worker → 独立回读` 路径：

- `BindSelfPerson`：`{ "self": true, "displayTitle": "本人称呼" }`。
- `CreatePersonalPreference`：`{ "key": "rideClass", "value": { "kind": "rideClass", "value": "comfort" } }`。
- `SetPersonalPreference`：在上述值之外提供 `expectedRevision`。
- `ClearPersonalPreference`：提供 `key` 和 `expectedRevision`。

本人和偏好 ID 由宿主补齐；冲突的客户端 ID 被拒绝。准备仅产生准确预览和原 Intent，不写个人数据。批准时原样提交返回的 planDigest、scope 和有界期限。需要现有 OAuth scope、当前资源角色的动作权限、源操作许可、本任务输出字段许可，以及准确非金融写入 grant；任何一项都不由元数据或本人关系推导。

Foundation 只开放这组受审查的个人动作，通用调用者托管写入仍未开放。HTTP `/ontology/v1/actions/prepare` 和 `/approve`、MCP 个人动作入口使用同一服务。批准不是完成，等待原任务 Worker 回读。

预览使用同一连接的回滚保存点验证模式，不创建权限绑定或来源记录。实际变更与原 Intent、观察、对象版本和关系在同一事务提交。个人地址关系只修改偏好到已有地址的关联，不修改源地址。

一个新任务可以独立取得已确认个人记录的字段权限，无须继承创建它的旧任务权限。审计来源仍保留，分类、标记和输出通道限制不降低；实际地址和供应商数据仍需各自授权。某次偏好更新只能以它自己的已验证变更记录解释其前态，不能让别的任务继续把旧默认当作当前事实。撤销 task grant、PA 安装实例或字段权限后，当前读取和旧回执输出重新鉴权。

## 发布与迁移

此能力属于 v25。v24 的构造入口和准确模型 digest 保留；已有任务发布引用不变。RequestFact 新增可选 personalBasis，不改写旧记录或历史指纹。

已有 Foundation 库须停 Gateway／Worker，先按当前 digest 和 policy revision 预览／应用 `upgrade-personal-context-policy.mjs`，再按 active release digest 和 generation 预览／应用 `install-personal-context.mjs`。两个脚本默认只预览。只接受已审查的 v24 前身，不能用于任意定义升级。迁移不增加个人资源、动作、字段、来源或期限授权；这些仍须逐项审查批准。

代码交付不激活正式业务库，也不接通真实机票、交通或电商履约。合成回归验证的是对象关联、上下文优先级、Worker 更新及权限隔离。
