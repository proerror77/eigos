# 独立 Engine 和 Ontology 包

使用 Node 22 和 PostgreSQL。默认的 Gateway、Worker、Indexer 和管理命令加载 EIGOS 业务组装。客户宿主通过绝对路径选择运营者提供的安装清单。一个客户环境使用独立数据库或独立受控 schema、进程和凭据。同一安装内按已认证 owner 授权。

## 构建与安装

在开发仓库构建引擎后，将清单路径指向本次安装选定的业务包。独立构建从宿主、类型生成器和 Code Mode Worker 入口编译其依赖，并检查产物中的反向依赖。

```sh
npm ci
npm run build:engine
export EIGOS_SOLUTION_MANIFEST="/path/to/your-package/installation.json"
node dist/engine/apps/engine.js check
node dist/engine/scripts/generate-ontology-sdk.js /path/to/your-package/ontology.json
```

配置该安装的 `DATABASE_URL` 和数据库角色后运行以下命令。已有安装使用 `upgrade` 代替 `initialize`。更新前保留数据库备份，停止旧版本接收新任务。已有任务固定到原发布和原实现。存储迁移根据发布记录回填任务所属 Ontology，并从任务回填 inbox 事件。旧写入角色应在切换 schema 前停止。

```sh
node dist/engine/apps/engine.js initialize
node dist/engine/apps/engine.js publish
```

按既有权限机制向指定 owner 授权。开发样例可使用 `grant-business <owner>` 授予整个样例的业务权限。在三个进程分别执行 `node dist/engine/apps/engine.js gateway`、`worker` 和 `indexer`（后两者替换最后一个参数）。Gateway 使用现有 JWT issuer、audience、JWKS 或显式 loopback 开发配置。查询和确定性 Action 可独立运行。自然语言推理使用业务实现注册的 AgentDriver。示例运行时需可解析锁文件对应的 Node 依赖。

## 创建业务包

`scripts/ontology.ts export <output.json>` 导出当前所选定义，包括固定版本及摘要的内嵌导入。不设置安装清单时导出 EIGOS。定义包沿用 `eigos-ontology-package-v1`，可以作为独立文件校验或生成 SDK 类型。

安装清单引用同目录的定义包、定义摘要，以及可选的单文件 ESM 实现及 SHA-256。实现应预先打包。它以受信任的进程权限运行，导出 `register` 并返回 Function 处理器、来源投影、Effects 或 AgentDriver。运行时验证模块字节后加载，使用实现摘要和 Engine 摘要建立发布身份。定义所需的 Function、Source 和 Effect 按原发布机制校验。单独的 `prepare` 和 `activate <release>` 支持已有候选发布流程。

引擎验收使用 `tests/fixtures/installed-ontology/` 中的测试包。测试在空库创建一条记录，由原 PA 补充名称，替换 Worker 后恢复并回读该记录。EIGOS 使用内置注册和原有实现身份，保留历史调用契约。
