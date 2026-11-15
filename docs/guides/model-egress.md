# 模型数据出境

模型的读取范围由已认证 owner 的权限和当前推理目的地共同决定。分类采用 `PUBLIC=10`、`INTERNAL=20`、`CONFIDENTIAL=30`、`RESTRICTED=40`。模型许可的最高级别必须覆盖数据级别，且模型标签必须包含数据所需的每一个 compartment。现有 Marking 继续控制用户权限，同时约束模型读取。[Palantir 对象访问控制](https://www.palantir.com/docs/foundry/object-permissioning/object-security-policies/)

任务消息按至少 `INTERNAL` 处理。PA 可以用 `submit_task` 的可选 `classification` 字段声明更高的级别或标签。Ontologies 的版本、对象类型和属性可以分别声明 `classification`。对象类型还可以通过 `classificationProperty` 指向存储的行级分类。读取判定合并这些要求，采用其中最高级别和所有标签。

## 配置目的地

先运行 `npm run db:upgrade` 创建 `model_clearances`。Worker 角色需要该表的 SELECT 权限，管理角色通过原有 `access:configure` 写入许可证。执行追踪写入需要 `execution_trace` 和它的序列权限。

```json
{
  "subjects": [],
  "modelClearances": [
    {
      "owner": "从已认证身份取得的 owner",
      "provider": "openai-codex",
      "model": "gpt-6.1-sol",
      "clearance": {"sensitivity": "CONFIDENTIAL", "compartments": ["FINANCE", "SUPPLIER_RATE"]},
      "active": true
    }
  ]
}
```

Harness 以部署固定的 `openai-codex` provider 和实际配置的模型 ID 查找许可证。内建目的地在没有精确许可时可处理无标签的 `PUBLIC` 和 `INTERNAL` 数据。包内同进程执行器使用同一基线。其他声明 provider 的目的地需要精确许可。设置同一记录的 `active: false` 可撤销该目的地的许可。

## 执行与审计

Runtime 在传入初始提示之前检查消息分类和结构化对象引用。每次模型调用工具时，行级和字段级限制作用于筛选、排序、聚合、链接导航及语义搜索，结果序列化前再次检查当前许可和对象读取权限。禁止访问的对象和字段通过现有权限视图隐藏。

执行步骤记录工具、结果状态和时间。出境授权记录保留策略摘要。已获许可的普通文档引用可留下版本与片段的修订证据。受保护的工具参数、内容和对象引用留在其原有业务权限边界。受保护的交互无法生成含原始数据的学习样本。调用方应把有分类的自由文本明确标注，外部插件应在发布的 Function、Action 或来源上声明其输出的分类。

[业务文档版本与片段](document-versions.md)
