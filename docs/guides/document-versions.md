# 业务文档版本

`OperationalDocumentVersion` 保存 PDF、Markdown 或纯文本 SOP 的业务版本。导入方提供已提取的文本、原件 SHA-256 和来源标识，EIGOS 计算保存文本的 SHA-256。来源标识只是已有文档系统中的定位信息。原件的读取、文本提取和扫描件 OCR 由导入方处理。[Palantir Ontology 中的 media references](https://www.palantir.com/docs/foundry/media-sets-advanced-formats/media-in-ontology/)

## 注册版本并关联排程

通过现有 Action 入口提交 `RegisterSchedulePlanDocument`。示例输入使用合成内容。

```json
{
  "plan": {"type": "SchedulePlan", "id": "schedule-plan-alpha"},
  "documentKey": "ops-safety-sop",
  "edition": "2026-11",
  "name": "Safety SOP",
  "mediaType": "application/pdf",
  "sourceRef": "records/ops-safety-sop-v2.pdf",
  "contentSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "extractedText": "Check the alarm before admitting visitors."
}
```

`documentKey` 和 `edition` 共同确定版本身份。相同身份和相同内容可以重复提交并关联到同一或另一份计划。内容变化时使用新的 `edition`。文本需包含可见内容且最多 64,000 字符，来源标识使用不含凭据的稳定相对标识。

## 读取及搜索

从计划的 `documents` Link 查询相关版本。

```json
{
  "type": "OperationalDocumentVersion",
  "from": {"object": {"type": "SchedulePlan", "id": "schedule-plan-alpha"}, "link": "documents"},
  "filter": {"op": "contains", "property": "extractedText", "value": "alarm"},
  "select": ["name", "edition", "sourceRef"]
}
```

调用者需要 Action、Function 和关联对象的授权来注册版本。普通对象查询遵守 owner、对象及属性权限。沿 Link 查询还检查起点计划的读取权限。配置 `property_security` 可独立限制 `extractedText` 或 `sourceRef`，被遮罩的文本无法用于命中搜索词。

## 片段与引用

每个版本在注册时生成 `OperationalDocumentChunk`，并通过 `chunks` Link 关联。默认每段最多 1,500 个 Unicode 码点，优先在附近的自然断句处换段。调用方可用 `locationRanges` 提供有序且互不重叠的 `startOffset`、`endOffset`、`page` 和 `paragraph`。字符范围从零开始，左闭右开。页码和段号只有来源提供时才写入。

片段继承版本的分类及其原文读取权限。可以通过 `OperationalDocumentChunk.text` 做词法筛选，也可以用现有 `semantic_configure`、`semantic_index` 和 `semantic_search` 构建和使用语义索引。受保护的片段仅可使用本地嵌入 Function。语义结果的 `citation` 包含版本引用、片段引用、序号、字符区间，以及可用的页码和段号。原文、片段或引用权限变化后，旧向量也遵循当前权限过滤。

已存在的版本可以再次提交相同注册输入，以生成稳定片段。页码范围属于版本的一部分。更新原文或定位信息时应注册新版本。
