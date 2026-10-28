# 文档导航

项目定位见[首页](../README.md)。本目录保留当前接入、开发、运行和能力说明。

## 开始使用

- [Agent 接入](integration.md)：MCP、A2A、任务续接与准确授权。
- [外部 Agent 的 A2A 完整链路](guides/a2a-agent.md)：发现、OAuth、安装授权、任务补问和结果回读。
- [开发与运行](gateway-worker.md)：本地启动、共享存储和验证命令。
- [仓库结构](architecture/repository.md)：模块职责、分支和提交约定。
- [能力目录](architecture/capabilities.md)：配置条件与完成范围。

## 本体与执行

- [共享本体](../packages/ontology/README.md)：唯一注册库、任务版本与供应商定义。
- [统一运行与路由](architecture/runtime-authority.md)：唯一正式权威、多个协议入口和来源权限。
- [本体建模](guides/ontology-modeling.md)：草稿、发布、激活和受管数据动作。
- [Ontology Pipeline](guides/ontology-pipeline.md)：服务资料和映射、验证证据、发布门槛及事实更新。
- [模型执行](architecture/model-execution.md)：原生 MCP、会话复用和读取回执。
- [任务闭环与跨服务编排](architecture/task-closure.md)。
- [态势感知与持续履约设计边界](architecture/situation-awareness.md)：设计合同，尚未实现。
- [本体权限与受保护任务](guides/ontology-security.md)。
- [领域术语](architecture/domain.md)：参与者、业务对象和验收含义。

## 账号与网络

- [会员与 OAuth](guides/membership.md)。
- [Agent 登记与续期](guides/agent-onboarding.md)。
- [会员来源连接](guides/member-sources.md)。
- [会员协作网络](guides/network.md)。
- [部署入口](guides/deployment.md)。

## 服务接入

- [美团只读来源](integrations/meituan.md)。
- [滴滴官方 Mock 下单测试](integrations/didi-order-test.md)。
- [供应商与沙箱配置](integrations/providers.md)。
- [免费报名与预约](integrations/free-booking.md)。
- [预约与 PA 付款交接](integrations/booking-payment.md)。
- [Shopify 未付款结账](integrations/shopify-checkout.md)。
- [Shopify PA 付款沙箱](integrations/shopify-pa-payment.md)。
- [支付宝 CLI 流程](alipay-cli-workflow.md)。
- [Stripe Treasury 预留](integrations/stripe-treasury.md)。
- [品牌说明](brand-brief.md)。

开发计划、阶段报告、研究、截图和原始运行证据保存在仓库外的本地归档。运行输出写入忽略目录；可重复的合成测试输入放在 `tests/fixtures/`。Git 历史中的旧文件只代表当时的版本与验证范围。
