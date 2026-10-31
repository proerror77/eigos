# 测试与 CI

普通 PR 按改动范围运行测试。测试列表和选择原因显示在 CI 的 `scope` 日志及运行摘要中；不会为了减少测试数量丢弃已有回归用例。

| 改动 | 验证范围 |
| --- | --- |
| 根 README／AGENTS、`docs/` Markdown、包 README | 不跑业务测试、类型检查或构建；CI 仍验证选择器并报告现有门禁 |
| 单个测试文件 | 该测试及其依赖消费者；E2E 测试改动只选相关 E2E |
| TypeScript 代码或共享测试夹具 | 传递依赖对应的测试、类型检查、构建，以及全部进程 E2E |
| 依赖锁、构建／测试脚本、CI 配置、运行时 JSON、本体定义、未知路径、删除或重命名文件 | 全量回归 |
| 依赖图解析失败、比较基线缺失、代码没有已知测试消费者 | 自动回退全量，并输出原因 |
| `main` 上的代码提交或手动运行 CI | 全量回归；主线纯文档提交仍按文档处理 |

测试范围按文件选择。共享核心模块可能关联大量测试，这类改动仍可能接近全量。依赖图通过现有 `tsx` 所使用的 esbuild 解析，包含运行时 import、re-export、动态字面量 import 和可识别的进程／夹具路径；纯类型 import 由全局类型检查覆盖。动态进程接线额外由 E2E 覆盖。新增无法静态表达的执行入口时，扩展路径映射或保留全量回退。

## 本地验证

```sh
git fetch origin
npm run test:scope
npm run check
npm run build
npm run test:changed
npm run test:e2e:changed
git diff --check
```

默认基线是 `origin/main` 的 merge base，比较整个分支，同时包含本地暂存、未暂存和新增文件。堆叠分支或其他基线使用 `npm run test:changed -- --base=origin/<parent>`；`test:scope` 和 `test:e2e:changed` 支持同一参数。

`npm run test:changed -- --list` 只列出选择结果。全量入口仍是 `npm test` 和构建后的 `npm run test:e2e:run`；也可在 Actions 中手动运行 CI。影响选择器或构建链路的改动需要全量，但同一提交的成功 CI 可以作为证据，无需再在本地重复完整测试。

## CI 触发与门禁

功能分支只由 PR 触发一次 CI；`push` 只监听 `main`，避免同一个 PR 提交同时跑 push 与 pull_request 两套测试。新提交取消同一 PR 的旧运行；主线全量验证保留。

现有分支保护使用 `verify` 与 `tests (1)` 至 `tests (8)`。这些检查名称保持不变，选择器失败会让它们失败。空分片只核验选择成功，不安装依赖、不调用 Node 测试自动发现；没有通过工作流路径过滤器省略必需检查。非空分片互不重叠，合起来恰好覆盖选中的文件。

选中 `stripe-payment.test.ts` 时，让其独占最后一个分片，其余文件均匀分配到其他分片。该串行交易模拟套件曾在与其他文件叠加时触发 30 分钟作业时限；隔离其调度，不跳过用例、不放宽时限。只有一个分片时仍运行全部选中文件。

类型检查和构建在代码 PR 中始终运行。独立进程测试使用合成来源与隔离数据，不代表真实商家下单、付款或履约完成。
