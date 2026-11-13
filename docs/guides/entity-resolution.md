# 跨来源实体身份

`EntityResolution` 将 `Ontology + owner + 已发布 dataSource + externalId` 映射到一个明确的正式对象引用。两个来源可以引用同一地点或其他业务实体。来源仍分别保留自己的接入映射、来源观察值和凭据授权。

`bind` 的参数包含 `source`、`externalId`、`target`、`expectedRevision` 和 `reason`。首次绑定使用版本 0。变更已有绑定须提供当前版本，目标必须已存在、可读取，并符合来源声明的对象类型。操作需要对应 dataSource 的 `ingest_source` 权限，以及其供应商的来源读取权限。每次实际变更追加不可修改的历史，记录旧目标、新目标、理由、操作者、发布和时间。

`lookup` 返回当前对象引用、版本和是否已经人工绑定。没有绑定时返回该身份的确定性默认 ID。已绑定目标消失或变得不可访问时，查询明确失败。具有来源授权的操作者可使用准确版本，将已删除目标的绑定修正为新的可读取目标。

连接器在来源写入事务中调用 `resolve(graph,source,externalId,fallbackId?)`。方法与绑定操作使用同一正式对象写锁，防止确认映射后在提交前被并发修改。`fallbackId` 用于延续连接器已有的默认身份算法，绑定存在时返回已核实的 canonical ObjectRef。

绑定改变后，后续来源写入使用选定的对象身份。已有对象与关系的数据迁移通过显式业务操作处理。系统依据提交的绑定匹配实体。跨 owner 身份保持隔离。

`history` 使用游标分页返回绑定审计记录，并重新检查来源授权以及相关目标当前的读取权限。数据库升级入口调用 `initializeEntityResolution`。运行角色需要 `entity_bindings` 的 SELECT/INSERT/UPDATE，`entity_binding_history` 的 SELECT/INSERT 和历史序列 USAGE。
