# MDN Man Do Nothing Foundry 与 EIGOS

平台源码位于私有仓库 [MDN Man Do Nothing Foundry](https://github.com/proerror77/MDN-Man-Do-Nothing-Foundry)。[产品架构](https://github.com/proerror77/MDN-Man-Do-Nothing-Foundry/blob/main/docs/architecture.md) 将 Ontology、Query Kernel、Functions、Actions、Machinery、Scenario、Agent 和按环境交付映射到 Palantir 公开产品概念，并列出了当前支持范围。EIGOS 维护食衣住行业务定义、连接器、PA 规则和 UI。

## 构建边界

`vendor/mdn-foundry/manifest.json` 固定上游提交、版本及三个归档的 SHA-256。Engine 包交付编译后的 JavaScript 和类型声明；SDK 包交付通用客户端；原生源码包支持按既有 Cargo.lock 构建 Kernel、Archive 与 Function Host。EIGOS 的 `npm ci` 和 `npm run build` 在构建时展开校验后的制品，所以干净的 EIGOS checkout 独立可构建。通用代码修改在 Foundry 仓库开发和测试。引入新版时替换固定归档及摘要并运行 EIGOS 安装与原 PA 回归。

## 客户端

在构建好的 EIGOS 工程运行 `npm run package:sdk`。将输出的两个 tgz 装进独立 TypeScript 应用。版本化的 `@mdn-foundry/sdk` 提供 HTTP 客户端和 PA 客户端，`@mdn-foundry/eigos` 提供该 EIGOS 定义的类型及摘要。按应用权限裁剪时，可以使用相应应用身份取得的 describe 结果调用 `generateOntologyTypes`。服务端会复核当前用户和应用权限。

```ts
import { PersonalAgentClient } from '@mdn-foundry/sdk';
import { publication, type Bindings } from '@mdn-foundry/eigos';

const pa = new PersonalAgentClient<Bindings>({
  baseUrl: installationUrl,
  token: getCurrentPersonalAgentToken,
  ontology: publication.id,
});
const task = await pa.submit(messageId, '帮我查一下这段路的滴滴价格，只询价。', conversationId);
const status = await pa.get(task.id);
```

重投复用原消息号。需要 PA 输入时，依据该任务的回执契约，用 `respond` 回到同一任务；业务授权由实际用户和原 PA 提供。`cancel` 对应 A2A 任务取消。客户自己的 PA 凭据由应用保管。通用 SDK、业务类型绑定和安装内活动发布分别版本化。

双环境测试会新建仓库外的消费者目录，仅安装这两个包，编译正确和错误的类型用例，再通过生产同款 Gateway 执行地址写入、查询和出行询价。
