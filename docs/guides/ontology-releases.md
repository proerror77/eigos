# 镜像与 Ontology 发布流程

应用构建、Ontology 打包、业务库发布和本体激活是四个独立步骤。只有最后的真实回读通过，才能记录为正式发布。SQLite 与 PostgreSQL 均使用业务库中的不可变本体注册库作为运行权威；镜像里的 JSON 是待校验的构建产物。

存储迁移的 runtime schema／authority handoff 激活与本体 `activate_release` 是不同记录。迁移应完整保留现有发布、active 引用、generation 和旧任务 pin，不把导入的本体重新发布成另一套定义，也不因启动 Gateway 而推进 active。PostgreSQL 的两阶段 handoff、节点全量回读与实际启动见[部署说明](deployment.md)。

v34 将软件已安装的受信实现与活动本体、字段策略分开。普通 PostgreSQL 启动准备会从已构建的 v28 节点安装受审 v34 合同，核对固定模型摘要并封存注册表；选中的 v27/v28 字段策略模型和可选 v29 向量分支保持原选择。此步骤不写业务库、不发布、不激活，也不创建角色或来源授权。显式发布 v34 后，新任务仍需匹配该任务模型摘要的角色；旧 v28 角色不会自动获得 v34 调用权，旧任务继续使用自己的发布和函数版本。旧 v29 任务仍须由安装了向量分支的宿主处理，v34 本身不引入 `semanticCandidates`。

v34 完整校验两个 DiDi 只读函数，其余 52 个函数明确标为兼容合同；全部执行仍经过现有证据和权限边界。运行时只接受软件注册的执行器，通用管理 JSON 不能上传代码。`criteriaVersion: "2"` 要求每个动作条件既在词表中，也有实际检查绑定；声明式业务条件需绑定到一个存在且执行的条件索引。完整的任意 Function 谓词 DSL 不在此合同内。

字段策略兼容不仅核对公开模型摘要，还核对成功编译的真实对象、包含 Action handler 引用的完整定义摘要，以及实际安装的 Function 执行器。仅用定义快照重建同摘要对象、复制显示用绑定信息或替换回调均不构成可信运行实例。声明的关系读取必须覆盖其目标对象类型，运行时也检查返回对象类型。

候选打包可显式传 `node scripts/release-artifacts.mjs create --kernel-version 34 --source-sha <完整提交> --out <新目录>`；省略版本仍打包原默认版本。构造过程按该受审目标的实际阶段推进，包清单和 `kernel.json` 必须回读到同一版本、正文摘要及模型摘要。打包不发布或激活。v34 的字段兼容建立在已审 v28 策略之上，v27 策略的既有显式升级要求仍保留。

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

上述 UUID 和 revision 只是格式示例，不是可用于生产的回执。PostgreSQL 已有实际草稿、发布与显式 CAS 激活管理端口，Gateway 按所选后端连接同一注册库；Foundation 模式仍只开放已审查的操作及当前 owner／角色／字段范围。若入口拒绝某项操作，不能关掉权限模式或直接改表绕过。

本体对象动作的 prepare／approve 使用原任务、原计划摘要和当前受审预览；CallerAction 执行仍检查批准范围、对象版本、原尝试与当前权限。发布元数据不授予对象写入或供应商执行权限。Pipeline 验证还须绑定原独立程序、真实观察与逐项确认的原意图回执；普通组合 Goal 的完成标签不能替代该验证。当前 PostgreSQL 装配缺少 `prepare_pipeline_validation` 的任务执行端口时会明确返回 `AUTHORITY_UNAVAILABLE`，不生成不可执行的替代任务。

只有镜像／包清单、代码适配或合成测试时，产物仍是 candidate。Harness 的 PostgreSQL 执行合同与专用镜像发布分别验收；镜像必须带实际 backend、固定工具版本、准确提交的必要 CI 和 OCI digest。无论使用哪种后端，都不能把本地打包写成业务库已发布、已激活或实际模型／供应商任务已完成。

## 回滚

回滚记录同时指定代码镜像与本体引用。可先恢复仍兼容当前任务和事实的上一镜像；不要恢复旧数据库覆盖新任务、回执、授权撤销或来源结果。

本体回退也须使用 `activate_release` 的实际权限、generation 和事实兼容检查。旧版本无法解释新事实时，保留当前业务库并向前修复，不能强行更新 active 指针。已有任务始终按原发布引用解释，不因切换而重新执行未知效果的操作。

部署职责和唯一运行权威见[部署说明](deployment.md)与[统一运行与路由](../architecture/runtime-authority.md)。
