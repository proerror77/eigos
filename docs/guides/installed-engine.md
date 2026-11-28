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

## Linux VM 发行与隔离验收

EIGOS 服务使用完整的 `Eigos` 定义及现有 Gateway 适配、业务连接器和 Worker。CI 的 `installed-vm` 作业在 Ubuntu 24.04 x86_64 打包，在仓库外安装两个副本并验证；通过后保留 `eigos-vm-linux-x64` 构建制品 14 天。包内的 `engine/` 是独立编译的公共代码、依赖锁和原生执行器，`solution/` 是业务代码、工作台资源和导出的 Ontology。二者各有内容摘要。安装器校验字节并拒绝路径冲突。生产发行可以复用同一流程生成优化构建。

### 在构建机上复现

使用与目标平台相同的构建机、Node 22.22.3 和仓库锁文件。完整原生配置使用两个从选定提交编译的二进制。

```sh
npm ci && npm run build
cargo build --release --locked --manifest-path kernel/Cargo.toml --bin eigos-kernel
cargo build --release --locked --manifest-path function-host/Cargo.toml
EIGOS_KERNEL_BIN="$PWD/kernel/target/release/eigos-kernel" \
EIGOS_FUNCTION_HOST_BIN="$PWD/function-host/target/release/eigos-function-host" \
npm run package:vm -- dist/vm
```

输出目录须为新路径。任一环境都可以复用整包。清单固定源提交、平台、Engine、业务实现、Ontology、原生执行器摘要和协议。Node-only 配置用于无 WASM 和无原生查询的安装验收，其清单明确记录 `native: null`。客户机运行安装器和 Node 时使用同一版本的 Node；`npm ci --omit=dev` 从配置的 npm 来源或预热的缓存安装锁定依赖。

### 在每个环境安装

1. 给每个客户单独的 PostgreSQL 17 数据库及数据库登录、唯一的 `EIGOS_INSTALLATION_ID`（UUID）、状态目录、签发者或受众配置、PA 授权和提供方凭据。若共用 PostgreSQL 服务，DBA 须对各客户数据库执行 `REVOKE CONNECT ON DATABASE <db> FROM PUBLIC`，仅向本库的角色授予 CONNECT。管理登录负责 schema 和发布。运行登录须使用普通非所有者角色，无 SUPERUSER、CREATEDB、CREATEROLE、BYPASSRLS，也不能继承管理登录。原生 Kernel 使用本库独立的只读投影登录，具有 BYPASSRLS 及投影查询所需 SELECT，角色不能继承其他角色或拥有业务表。DBA 设置密码或证书。
2. 从可信构建下载归档与对应的 SHA-256 文件，校验后解包。在发行目录执行 `node install.mjs /opt/eigos/releases/<version>`，进入安装目录执行 `npm ci --omit=dev`。完成后让服务账户对代码只读。安装无需仓库或 TypeScript 工具链。
3. 在私有环境文件配置 `EIGOS_INSTALLATION_ID`、`EIGOS_STATE_DIR`（绝对路径）、`EIGOS_RUNTIME_ROLE`、`EIGOS_ENFORCE_OWNER_RLS=true`、Gateway 地址和现有 OAuth 配置。原生配置另设 `EIGOS_KERNEL_ROLE` 和 `EIGOS_KERNEL_DATABASE_URL`。按环境设置任务并发、来源预算、模型服务和供应商凭据引用。对确定性操作可显式使用 `EIGOS_MODEL_MODE=actions-only`；自然语言任务使用本环境的 Harness 与模型配置。状态目录仅供该安装使用，并授予其服务账户访问权限。
4. 使用本库**管理连接**作为 `DATABASE_URL` 运行 `node apps/eigos-vm.js install`。该命令初始化 schema、校验绑定、准备并激活发布、安装 owner 行级隔离并授予运行角色权限。原生配置实际启动 Kernel 与 Function Host 并比对协议及 WIT world。安装回执原子写入状态目录的 `installation.json`，记录逻辑安装 ID、数据库身份、活动发布、投影、绑定和制品摘要。在同一安装重跑可核对原回执。
5. 切换为**运行连接**后执行 `node apps/eigos-vm.js verify`。原生配置还会从本环境的只读连接加载并核对实际投影。分别运行 `node apps/eigos-vm.js gateway`、`worker` 和 `indexer`。三个角色在启动前校验环境回执。Kernel 和 Function Host 按需由本机进程启动，使用 loopback 以及本安装、各运行角色自己的数据目录。
6. 单 VM 运行单客户时，可将 `current` 链接指向已验证版本，将随包的 `eigos@.service` 放入 systemd unit 目录，设置服务账户 `eigos` 和 `/etc/eigos/installation.env`（只含运行凭据），再启动 `eigos@gateway`、`eigos@worker`、`eigos@indexer`。示例 unit 假设 Node 位于 `/usr/bin/node`，状态目录为 `/var/lib/eigos`。管理凭据单独保存。TLS 终止使用客户的 HTTPS 入口。

需要在一个环境验证后续定义时，先在新目录安装候选制品，按既有维护流程处理未完成任务、备份并停止该环境的旧写入角色。使用该环境的管理连接、相同安装 ID 和状态目录执行 `node apps/eigos-vm.js upgrade`，切换运行连接执行 `verify` 后再启动新版本。另一客户的数据库、服务和回执可独立保持原版本。

### 验收证据

`tests/e2e/vm-isolation.test.ts` 在独立目录用同一制品安装两次，各自安装锁定的生产依赖，并使用独立数据库、数据库登录、Gateway、Worker、Indexer 和 PA 凭据。测试从同一用户的“家”地址和打车询价进入，故意复用对象键、消息号和会话号。它核对实际读取的地址、任务所有权、工作队列、跨环境回执拒绝，以及一侧拒绝、撤权或升级后另一侧仍能回读结果。供应商为本机 synthetic 只读来源，不创建出行订单或付款。独立测试在 PostgreSQL 的同一测试实例上使用两个禁止交叉连接的数据库，部署时也支持各自使用独立的 PostgreSQL 主机。

### 部署控制器读取的版本信息

VM 归档中的 `release.json` 和安装后的 `installation.json` 同时携带 EIGOS 的 `solutionVersion` 与消费的 `foundry` 锁清单。后者记录上游仓库、发行版本、源提交，以及 Engine、SDK、Native 源码包的摘要。`engine` 和 `solution` 标识本次构建的两个文件树，`native` 记录实际二进制和协议。归档整体的 SHA-256 由构建流水线在打包后产生，可以作为跨环境推进的制品标识。环境中的活动 Ontology Release、投影、数据库身份和实现绑定以运行角色执行 `verify` 返回的回执为准。旧回执没有上游锁字段时，沿用原验证和升级流程。
