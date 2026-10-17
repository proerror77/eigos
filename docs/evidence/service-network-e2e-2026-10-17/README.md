# PA → EIGOS → Ontology MCP → 美团跑腿：两段 E2E

本轮按用户 2026-10-17 的纠正重新验收，替换此前未覆盖实际 PA 和真实美团查价的探针及记录。最终以此处新记录为准。

## 验收路径

实际 Grok Bot／Monk → 本机 A2A Agent Card／委托 → EIGOS Gateway → 独立 Worker／真实 Codex 协调模型 → 内部 stdio Ontology MCP → 官方美团跑腿查询程序 → 真实配送价格 → 独立验收 → PA 读回同一交付物。

两段均通过。2026-10-17 16:14–16:15（Asia/Shanghai），实际 Monk 发现 Card、提交新任务并保存完整 GetTask；16:15:40 在其界面报告已收到交付物。任务 `81ef2437-95f9-441a-acd4-31c115968767` 为 COMPLETED，独立验收 accepted=true。

| 部分 | 本轮实测证据 |
| --- | --- |
| PA 接入 | 实际 Grok Bot／Monk 使用已有 Mac 执行能力调用 Python A2A 客户端；discover、submit、poll/get 均由 PA 发起；不是观察器代提交 |
| 模型规划 | 2次真实 Codex 调用：grounding 和 planning，均保存运行时间、threadId、输出摘要及 usage |
| Ontology MCP | 2次真实 `ontology_delivery_quote`：候选读取及执行复查；每次先核对版本化本体定义 |
| 美团来源 | 每次读取调用 get_address_list、两次 get_address_info 和 delivery_preview，共8次成功只读调用；源程序摘要已固定 |
| 查价结果 | 本人两处同城保存地址，文件1公斤、普通送，52.5元、23.5公里；预计送达时间只是估计 |
| 验收与读回 | `read_only` 和 `goods_weight` 均 pass；PA/A2A/MCP 同一 taskId、完成状态及交付物摘要一致 |

[结构化证据](verification.json) 和 [PA 界面摘录](pa-readback.txt) 已脱敏。运行前记录的构建指纹覆盖实际 apps/packages 及 Gateway/Worker 启动器；归档时重新计算匹配。个人地址、电话、令牌及完整原始输出保留在用户私有运行目录，不进入本目录。

首次实际 PA 测试揭示报价重量没有映射为候选事实，任务 `954ab3ea-f4dd-49f5-9e98-c66c8424f426` 被正确拒绝，未算通过。修复后，匹配的计价重量成为有证据的 quantity；不匹配的物品、重量、服务或缺少总费用仍不可执行。133项常规测试和7项进程间工程 E2E 均通过。工程 E2E 的模型/提供方仍是 fixtures，和上表实际 PA／真实来源分别记录。

## 复现

先运行 `npm run check`、`npm test` 和 `npm run build`。工程故障回归为 `npm run test:e2e:run`，模型和远端业务为明确标记的 fixtures，不替代实际 PA／美团测试。

显式运行真实测试观察器：

```sh
EIGOS_PAOTUI_SKILL_DIR=/absolute/path/to/meituan-paotui \
EIGOS_PAOTUI_E2E_QUERY_FILE=/absolute/private/preview-input.json \
  node dist/examples/verify-pa-paotui-e2e.js --live
```

输入符合 `paotuiPreviewSchema`，只引用本人已保存的同城地址。观察器创建独立 loopback Gateway／Worker，生成私有临时连接 profile 后等待实际 PA；不自行提交任务。让 PA 使用打印出的私有目录中的既有 Python 接入、profile、技能和 task-input.json，实际发现、提交、查询，再保存完整 GetTask 到 pa-received.json。观察器比较同一交付物摘要后才报告通过。

原始任务、地址、电话和令牌只保存在用户私有运行目录。公开证据仅归档检查过的费用、模型与 MCP 元数据、taskId 和摘要。观察器关闭自己的临时进程，不改变既有常驻 PA 连接或部署。

## 边界

只查询价格，不创建订单、不下单、不付款。报价、距离和预计送达时间不证明实际履约。本次不验证生产部署、多用户私人凭据代理、通用规划质量或长期服务可靠性。
