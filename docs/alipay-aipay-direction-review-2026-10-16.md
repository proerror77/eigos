# 支付宝 AI 付方向核对（2026-10-16）

## 结论

AI 付可作为 EIGOS 调用已接入商家服务时的支付环节；现有公开资料不能证明它提供通用服务发现或替代 AI 开放平台的 Agent A2A 调用。此次未付款、未开通钱包、未签约收款产品，也未跑通外部业务智能体。

## 公司邮箱回复

已读取公司飞书邮箱中主题为 `[EIGOS] A2A 调用报错排查（请回复公司邮箱）` 的线程。支付宝于 2026-10-16 11:56 从 `alipay.ai@service.alipay.com` 回复，指向 AI 付官网，并邀请留下联系电话安排深入沟通。回复未包含 A2A 请求示例、鉴权格式或错误诊断；该线程读取时只有公司发信和这封回复两条消息。本轮未发送新邮件。

## 三条路径

| 路径 | 公开资料所支持的用途 | 对当前问题的意义 |
| --- | --- | --- |
| `@alipay/alipay-aipay` | 商家接入 AI 按量付费、AI 网页应用收款、AI 移动应用收款 | 用于卖方收款集成，不是已证明可调用外部 Agent 的客户端 |
| `@alipay/agent-payment` | 买方 Agent 支付，包括收银台和 HTTP 402 付费资源 | 比较符合 EIGOS 消费方角色，但前提是已有可用商家服务及支付请求 |
| AI 开放平台 Agent A2A | 订阅外部 Agent 并通过平台网关调用 | 仍是当前无付款交互的验证路径；现有调用错误没有因 AI 付方向而解决 |

官方 Skill 安装入口确为 `npx -y @alipay/alipay-aipay@latest install`。本机已有该 Skill，本轮按其运行时入口完成自更新至 1.7.5，核对接入范围；没有启动商家开通或支付流程。

另外对买方包做了静态检查，未执行安装：查询到 `@alipay/agent-payment` 1.0.26，生产配置指向支付 Skill 1.0.15 和 `alipay-bot` 0.4.7。支付 Skill 覆盖钱包认证、收银台、402 和支付反馈，未发现通用服务搜索或 A2A 故障修复能力。这些版本是本次观察值，可能更新。

## 可采用的后续接入顺序

先获得商家或平台可用的服务 API／Skill／Agent 调用合同，验证任务创建、状态和结果；遇到明确的收费请求，再另行接入支付适配。HTTP 402 文档描述的流程是商家返回账单、买方授权支付、携带支付证明重新请求、商家校验并交付资源。支付与交付必须分别读回，不能以支付成功证明服务完成。

目前可继续的无付款目标是取得平台确认的 A2A 最小请求、准确鉴权头、版本与流式调用规范，以及免费或测试 Agent 的任务结果。现有报错和 trace 见 [调用排查记录](alipay-agent-debug-2026-10-16.md)。在这些输入发生变化前，不重复相同的失败请求。

## 官方来源

- [AI 付索引](https://aipay.alipay.com/llms.txt)
- [商家集成 Skill](https://aipay.alipay.com/developers/skill.md)
- [Agent Pay 买方接入](https://aipay.alipay.com/agentpay.md)
- [Skill 收款与买方支付链路](https://aipay.alipay.com/docs/agent-pay/skillpay.md)
- [HTTP 402 按量付费](https://aipay.alipay.com/docs/ai-receive/MACHINE_PAY.md)

以上 Markdown 来源本轮通过 HTTP 读取核对。公开文档未证明的能力不作为已完成集成。
