# 外部 Agent 通过 A2A 接入

EIGOS 提供 A2A 1.0 JSON-RPC。外部 Agent 从公开 Agent Card 开始，完成用户 OAuth、会员准入和安装授权后，在原任务内提交、补充信息与回读结果。以下使用仓库已有的官方 `@a2a-js/sdk`；不需要先连接 MCP，也不需要 Poppy。

## 发现、登记与用户授权

```ts
import { AgentConnector } from '../../packages/agent-client/client.js';
import { discoverA2A } from '../../packages/agent-client/a2a.js';

const baseUrl = 'https://your-eigos-origin';
const card = await discoverA2A(baseUrl);
// card.skills 声明该部署的入口能力，不代表本安装已获准使用所有来源。
const agent = await AgentConnector.open({
  baseUrl,
  credentialPath: '/absolute/private/my-agent/credentials.json',
  displayName: 'My Personal Agent',
});
let admission = await agent.status();
if (admission.status === 'authorization_required') {
  const authorization = await agent.beginAuthorization();
  // 宿主向用户显示 verificationUri 和 userCode，由用户在身份提供方完成授权。
  // 不把 device_code、access token、refresh token 或凭据文件传给模型。
  console.log(authorization.verificationUri, authorization.userCode);
  admission = await agent.finishAuthorization();
}
```

首次授权后可能仍是 `registration_required`。取得用户对会员资料和保存用途的明确同意后，调用 `agent.registerMembership(profile, true)`。邀请制下保持原登记，按 `pollAfterSeconds` 查询；拿到绑定该用户的邀请后调用 `agent.redeemInvitation(invitationToken)`。详情见[Agent 登记](agent-onboarding.md)。

`data_authorization_required` 表示用户已登录，但还没有批准这个安装的数据与任务范围。引导本人打开 `admission.links.permissions`，审阅并批准准确范围。发现文档的 `permissions_url` 和受保护入口拒绝响应中的同名字段提供相同入口。`foundation_ready` 才允许调用；它只证明安装许可存在，具体任务、字段、来源、模型与输出通道仍会分别检查。Agent 不替用户批准自己的权限，也不通过切换协议或新建登记绕过拒绝。详见[本体权限](ontology-security.md)。

## 使用官方 SDK 提交任务

```ts
import { randomUUID } from 'node:crypto';
import { SendMessageRequest, GetTaskRequest, TaskState } from '@a2a-js/sdk';

const client = await agent.a2a();
const request = SendMessageRequest.fromJSON({
  configuration: { returnImmediately: true },
  message: {
    messageId: randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: '只生成一份场地比较任务说明；列明需要收集的容量、价格和来源，不实际搜索或预约。' }],
  },
});
// 发出前由宿主将完整 request 和 messageId 保存到私有任务记录。
// 新任务不自造 contextId；后续保存并沿用服务器返回的 id 和 contextId。
const sent = await client.sendMessage(request);
if (!('id' in sent)) throw new Error('Expected an EIGOS Task');
// 保存 sent.id、sent.contextId 及 sent.metadata.revision。
const current = await client.getTask(GetTaskRequest.fromJSON({ id: sent.id }));
```

`agent.a2a()` 使用公开发现，核对同源 `/a2a`、协议版本和与登记元数据相同的身份提供方，再把官方 SDK 的请求交给安装绑定的 OAuth 适配器。它自动续期并重新绑定令牌；调用方不在 `serviceParameters`、任务文本或结构化数据中传入令牌。请求有 30 秒上限，调用方可通过 SDK 的 `signal` 提前取消等待。客户端采用轮询，`SendMessage` 不等待整个业务结束。

请求失败不会自动重放。已经取得任务 ID 时，先 `GetTask`；只有已知 contextId 时，才用 `ListTasks` 按原 context 查证。首次提交响应丢失且尚无任务 ID 时保留原始请求，不能生成新 messageId 作为“重试”。需要显式再次提交时，逐字复用原 messageId、正文和 context，在同一安装内命中已有幂等记录；不要将新的业务意图复用到旧标识。

## 补问与结果回读

`TASK_STATE_SUBMITTED`／`TASK_STATE_WORKING` 不代表完成。正常执行时按有界间隔查询原任务；`metadata.internalState=paused` 则表示技术暂停，保留原任务等待运行条件修复，不能一直报告“正在执行”或要求用户重述业务目标。`TASK_STATE_INPUT_REQUIRED` 才交给用户补充实际缺少的信息；回复绑定当前版本：

```ts
const question = await client.getTask(GetTaskRequest.fromJSON({ id: sent.id }));
if (question.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
  throw new Error('Read the original task before replying');
}
const answer = SendMessageRequest.fromJSON({
  message: {
    messageId: randomUUID(),
    taskId: question.id,
    contextId: question.contextId,
    metadata: { expectedRevision: question.metadata?.revision },
    role: 'ROLE_USER',
    parts: [{ text: '任务说明需交付一页比较表规范，覆盖容量、价格、来源和验收条件。' }],
  },
});
// 同样先持久保存 answer；版本冲突时回读，不盲目覆盖当前问题。
await client.sendMessage(answer);
const result = await client.getTask(GetTaskRequest.fromJSON({ id: sent.id }));
const usable = result.status?.state === TaskState.TASK_STATE_COMPLETED
  && result.metadata?.view === 'eigos.task.v2'
  && result.metadata.accepted === true
  && result.metadata.outputStatus === 'available'
  && result.artifacts.length > 0;
```

上例 `usable` 检查针对受保护的 `eigos.task.v2`。`restricted`、`receipt_only`、缺少 accepted 或缺少实际交付物都不应报告为已取得可用结果。legacy 实例使用其实际任务和交付合同，不能伪造 v2 的 accepted。任务说明 artifact 中 `execution=not_started` 指底层业务没有执行；说明本身完成不能描述为已经完成搜索、预约或购买。

`TASK_STATE_AUTH_REQUIRED` 需要先检查任务的授权说明。`metadata.authorization` 返回具体计划许可时，由用户审阅，经独立 `POST /tasks/:taskId/authorize` 通道提交准确对象；缺少来源登录或安装权限则走对应连接／本人授权入口。不能凭空构造许可，一句“同意”也不是授权对象或付款证明。取消使用官方 SDK 的 `cancelTask`，只阻止后续任务执行；已发生的供应商操作需沿用原操作查证。停用安装调用 `agent.revoke()`，之后 MCP 和 A2A 均不能继续读取其任务。

## 验证范围

`tests/agent-onboarding.test.ts` 使用本地合成身份提供方签发的 JWT、真实 HTTP Gateway、官方 A2A SDK、持久 Worker 和原生来源程序，覆盖登录、安装／来源授权、任务完成、独立回读及 MCP 共用任务。另验证过期续期、旧版本回复拒绝、不同安装隔离、响应丢失不自动重放，以及不同目标地址／身份提供方拒绝。这些合成测试不证明某个外部产品已原生支持 EIGOS，也不证明真实供应商业务完成。
