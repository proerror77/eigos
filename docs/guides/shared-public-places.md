# 组织公共地点

组织通过 EIGOS 项目共享经过明确发布的公共地点。每个项目使用独立的数据分区。同一项目的成员查询同一份地点记录，相同的地点 ID 可以在不同项目独立使用。个人地点、搜索凭据、行程和日历继续保存在各自的个人分区。发布请求只接受地点 ID、名称、城市、公共地址和 WGS84 经纬度。

## 开通项目

1. 本体管理者通过 `project` 服务创建组织项目，例如 `{"ontology":"Eigos","id":"Alpha","name":"Alpha"}`。
2. 数据库管理者在项目初始化后运行以下命令。它发布 `EigosPublicPlaces` 定义并配置指定项目的数据分区。新运行版本上线时使用相同命令重新发布；现有地点随定义投影迁移。

   ```sh
   node --env-file-if-exists=.env --import tsx scripts/ontology.ts provision-public-places Alpha
   ```

3. 使用 [既有授权配置](ontology-services.md#对象与属性安全) 为项目成员组授予 `Eigos/project/Alpha` 上的 `view_definition` 和 `view_objects`。发布者组还需要同一项目的 `apply_action`。API 调用继续要求 `ontology:read` 或 `ontology:write`。成员关系和授权在每次请求中按当前状态校验。

## 发布、读取和撤回

通过 HTTP `POST /ontology/services/<operation>` 或 MCP `ontology_<operation>` 调用。

- `publish_public_place` 接受 `project`、`requestId`、`id`、`name`、`city`、`address`、`latitude`、`longitude`、`coordinateSystem: "WGS84"` 和 `confirmedPublic: true`。由发布者确认地点及其字段可以在组织内共享。修改已有地点或重新发布时传入当前 `revision`。
- `list_public_places` 接受 `project`，可按 `id` 或 `city` 精确筛选，并使用 `cursor` 和 `limit` 翻页。发布者可用 `includeWithdrawn: true` 查询撤回记录及当前版本。
- `withdraw_public_place` 接受 `project`、`requestId`、`id` 和当前 `revision`。撤回后普通成员的查询结果移除该地点。相同提交使用原 `requestId` 重试。

项目权限对应 Foundry 的组织空间访问边界。EIGOS 使用现有项目和组授权限定访问，地点由独立发布的 Ontology 对象类型建模。创建、修订和撤回沿用声明式 Action、编辑历史与提交记录，日志保留已认证执行者。现有 owner 行级安全策略继续覆盖各项目分区和个人分区。 [Foundry 组织和空间](https://www.palantir.com/docs/foundry/security/orgs-and-spaces) · [Foundry Action 规则](https://www.palantir.com/docs/foundry/action-types/rules)
