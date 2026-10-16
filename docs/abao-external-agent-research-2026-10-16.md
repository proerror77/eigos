# 阿宝面向外部 Agent 的调用能力：公开一手资料核对

核对日期：2026-10-16。范围：官方公开资料、官方代码仓库与支付宝团队公开技术演示；未读取凭据、安装软件、发送邮件或发起支付。本文件只记录公开资料研究，不代表完成业务调用。

## 当前结论

找到支付宝团队公开说明的 **AHA / Agent Hub Access 服务互联架构**，范围包括服务发现、意图查询、执行与结构化卡片，确实超出支付。但本轮没有找到可供 EIGOS 直接执行的阿宝公开调用契约：尚缺正式端点、SDK 获取方式、请求 schema、认证签名规则、注册/证书发放及外部平台准入要求。不能因此断言接口不存在，也不能把已订阅的第三方 Agent 当成阿宝。

本轮未取得新的完整调用契约，因此没有发起新的业务请求，也没有获得阿宝的免费业务回答。该状态只说明目前尚未具备可验证的执行前提，不是接口不存在的证明。

## 新的一手技术依据

支付宝 Solutions & Partner Technology Department 在 W3C AC meeting 2026 的演示文稿 [Exploration and Practice of Agent Interconnection](https://www.w3.org/2026/04/hangzhou-webevolve-liu-yunxuan.pdf) 提供以下架构信息：

- PDF 第 7 页：AHA-SDK 位于支付宝跨设备通信基础设施；平台侧列出 Agent 注册、发现、认证与证书发放。
- PDF 第 8 页：服务池构建/查找/发现，然后意图查询，返回 Data & CardID，再推进服务执行；图中分别标记 A2A & RSA 和 A2A & Secure Tunnel，并展示登录状态、文本流、服务卡片及多轮交互。
- PDF 第 9 页：说明 OPPO、Honor 系统助手集成案例。这是已有合作集成的架构证据，不是任意外部 Agent 的自助准入承诺。

以上仅概述架构，文稿没有可直接调用的 URL、HTTP Header 示例、RSA canonicalization、SDK 包名/下载地址或完整 JSON 请求。文稿发布于 2026 年 4 月，不能据此推定当前版本和可用资格。

## 与支付及供给侧接入的区别

| 路径 | 一手来源 | 对本次目标的含义 |
| --- | --- | --- |
| AHA 服务互联 | 上述支付宝团队 W3C 演示 | 证明服务互联架构方向；缺可执行接入契约 |
| 阿宝 CLI / 商家服务接入 | [官方阿宝 CLI 页面](https://open.alipay.com/ai/ai-resource-center/cli-guide/abao)；此前项目核对见 [联调记录](alipay-agent-debug-2026-10-16.md) | 供给侧把服务接入阿宝，不自动等于消费侧调用阿宝 |
| 支付宝 AI 付 | [官方产品概览](https://aipay.alipay.com/docs/overview.html) | 官方列出的能力为收款、订阅、按量计费和代理支付，不能补足阿宝服务调度契约 |
| Agent Payment Skill | [支付宝官方仓库](https://github.com/alipay/payment-skills) | 提供钱包授权、支付、402 处理；不是阿宝服务目录/任务调用 SDK |
| 平台第三方 Agent | [自研智能体指南](https://opendocs.alipay.com/ai/0jb1nq?pathHash=ca854f82)；项目现有 [调用记录](alipay-ai-resource-live-check-2026-10-15.md) | 有具体订阅资源 URL；该资源不是阿宝，现有失败也不能推论 AHA 不可用 |

本轮公开检索使用阿宝、AHA、Agent Hub Access、AHA-SDK、外部 Agent、API 等关键词，优先检索支付宝、蚂蚁、OPPO 官方站和支付宝 GitHub 仓库。官方阿宝页面可获取前端 HTML 壳，但网页检索读取工具未取得正文；自研智能体指南读取也失败。未以新闻转述中的“开放”“标准化”措辞作为调用契约。

主任务随后通过浏览器读取自研智能体指南：A2A 章节确认 API_Key/RSA2、订阅鉴权与 SSE，但未给出完整请求示例、Authorization Header 格式或协议版本。新浏览器中的阿宝 CLI 页面显示登录及协议确认门槛，未接受协议。主任务另行只读检查 `@alipay/delegation-skills` 1.0.0，内容为委托支付，未发现阿宝服务调用契约。这些结果均未补足本次免费业务请求的执行前提。

## 下一次免费交互所需的最小技术材料

1. 确认接入类别是消费侧平台/终端 Agent 调用阿宝，明确是否支持纯云端/桌面 Agent。
2. 获取对应 SDK 或服务 URL、协议版本，以及服务发现、免费查询、任务状态/结果回读示例。
3. 确认平台身份注册、证书/API Key、应用及订阅授权的映射；现有 AI 应用 Key 不能假定适用于 AHA。
4. 只选择明确免费的、无需个人资料的能力介绍请求；得到有效业务文本/结果和可回读终态后才报告交互成功。HTTP 200、连接成功或错误流均不足以证明。

若控制台提供新的准确契约，可据此继续一次有依据的测试；在没有新技术前提前，不重复旧失败请求，不尝试钱包开通、付费资源、下单或付款。
