# 镜像与 Ontology 发布流程

应用构建、Ontology 打包、业务库发布和生产激活是四个独立步骤。只有最后的真实回读通过，才能记录为正式发布。业务库中的不可变本体注册库是运行权威；镜像里的 JSON 是待校验的构建产物。

## 版本与发布清单

一次部署须保存以下记录，配置、凭据和数据库快照留在仓库外：

| 记录 | 固定内容 |
| --- | --- |
| 运行镜像 | Gateway、Relay、Worker 的完整 `image@sha256:…`，实际执行后端、锁定的工具版本 |
| 应用版本 | 完整 Git commit、依赖锁摘要、构建产物清单和精确提交的 CI 结果 |
| 本体构建包 | kernel 及供应商模块的 ID、版本、正文摘要、模型摘要和包摘要 |
| 本体发布 | 业务库返回的 `ontologyId / releaseId / digest`；不能用包摘要推测 release ID |
| 激活记录 | 原 active 引用及 generation、目标引用、激活后的 generation、真实回读结果 |
| 数据与运行权威 | 存储迁移版本、快照及校验回执、同一个正式 authority ID、兼容的镜像与本体范围 |

人类可读版本标签便于选择版本；部署以镜像摘要和本体发布引用为准。不能部署浮动 `latest`，不能只记录一个 Git tag 就声称已发布本体。

## 固定流水线

1. 在任务分支修改定义。供应商绑定只编辑 `packages/ontology/definitions/`，不改生成的 `dist/` 或历史指纹。
2. 运行定义校验、构建和受影响测试；等待该精确提交的必要 CI 成功。
3. 通过镜像发布工作流构建一次，生成镜像摘要及本体包清单。后续候选和正式环境使用同一组不可变产物，不在服务器重新安装不固定版本的依赖。
4. 在业务库创建或更新草稿，核对基准发布、草稿 revision、完整 diff、兼容性和相关 Pipeline 的实际验证结果。构建包可通过而草稿未通过，此时不能继续。
5. 发布草稿，取得业务库返回的不可变 release 引用；发布不自动激活，不改已有任务的固定引用。
6. 在隔离候选环境验证同一镜像与该发布引用，包括 MCP／A2A 原任务回读、Worker 领取／续租／取消、结果封装及拒绝路径。合成测试不等于真实供应商履约。
7. 部署同时兼容当前及目标本体的代码，再按原 generation 比较并交换 active 引用。不能绕过当前事实、在途任务和 Pipeline 兼容检查。
8. 回读 active 引用、generation、运行镜像／构建摘要、authority ID 及新任务的准确发布引用；将结果写入发布回执。

任何必要检查失败时停在对应步骤，保留原数据与失败回执。镜像上传、本体发布、active 切换和业务完成分别记录。

## 操作员命令

使用现有的 `scripts/ontology-operator.mjs` 和私有操作员 profile。操作员登录、发布权限、安装授权和业务执行权限分别检查，不把 CI token 当作本体发布权限。

```sh
node scripts/ontology-operator.mjs --profile /private/operator/profile.json status
node scripts/ontology-operator.mjs --profile /private/operator/profile.json query --input /private/release/get-ontology.json
node scripts/ontology-operator.mjs --profile /private/operator/profile.json query --input /private/release/get-draft.json
node scripts/ontology-operator.mjs --profile /private/operator/profile.json query --input /private/release/validate-draft.json
node scripts/ontology-operator.mjs --profile /private/operator/profile.json query --input /private/release/diff-draft.json
```

输入文件必须使用实际的 ontology ID、草稿 ID 和审核过的 revision。以 `eigos.business` 为例：

```json
{"operation":"validate_draft","ontologyId":"eigos.business","draftId":"00000000-0000-4000-8000-000000000001"}
```

确认草稿内容与验证结果后，发布命令的输入为：

```json
{"operation":"publish_draft","ontologyId":"eigos.business","draftId":"00000000-0000-4000-8000-000000000001","expectedRevision":3}
```

```sh
node scripts/ontology-operator.mjs --profile /private/operator/profile.json command --input /private/release/publish.json
```

保存实际返回的 release 引用。候选验收和代码部署完成后，另建激活输入；`release` 必须逐字使用该回执，`expectedGeneration` 必须来自激活前的新查询：

```json
{"operation":"activate_release","ontologyId":"eigos.business","release":{"ontologyId":"eigos.business","releaseId":"ACTUAL_PUBLISHED_RELEASE_ID","digest":"ACTUAL_PUBLISHED_64_HEX_DIGEST"},"expectedGeneration":4}
```

```sh
node scripts/ontology-operator.mjs --profile /private/operator/profile.json command --input /private/release/activate.json
node scripts/ontology-operator.mjs --profile /private/operator/profile.json query --input /private/release/get-ontology.json
```

上述 UUID 和 revision 只是格式示例，不是可用于生产的回执。Foundation 模式只开放已审查的管理接口；若入口拒绝某项操作，不能关掉权限模式或直接改表绕过。PostgreSQL 管理写入与运行入口尚未完成时，只能构建和验证候选产物，不能把打包步骤标为业务库已经发布或激活。

## 回滚

回滚记录同时指定代码镜像与本体引用。可先恢复仍兼容当前任务和事实的上一镜像；不要恢复旧数据库覆盖新任务、回执、授权撤销或来源结果。

本体回退也须使用 `activate_release` 的实际权限、generation 和事实兼容检查。旧版本无法解释新事实时，保留当前业务库并向前修复，不能强行更新 active 指针。已有任务始终按原发布引用解释，不因切换而重新执行未知效果的操作。

部署职责和唯一运行权威见[部署说明](deployment.md)与[统一运行与路由](../architecture/runtime-authority.md)。
