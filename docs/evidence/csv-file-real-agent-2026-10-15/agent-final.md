三场景各建一单，均已完成最终读回；三笔模拟付款均为 100 分 CNY。

| 场景 | 真实 taskId | 真实 orderId | 实际结果 |
|---|---|---|---|
| normal | `838b476b-2902-4fbb-89c6-8daf9aa6c915` | `a9b8f6cd-05ad-487e-861f-dd8c34ae675a` | `completed`；付款 `paid`；验收 `accepted`；补救 `none` |
| repair | `ea9f349d-7dbc-4a39-8e56-135eb349aafa` | `abf94ce6-db34-4d1a-b87f-6a3d765445fc` | `completed`；付款 `paid`；首次拒收→请求补交→验收通过；补救 `none` |
| refund | `9cea8621-646e-4e04-93d1-bd71eacce5d4` | `87bb500a-8abd-42d5-961c-b0bbe55762de` | `failed`；付款记录 `paid`；两次验收拒收；退款已核实 `refunded`，`step=done` |

三单均使用指定磁盘文件 `audit-input.csv`，未传 datasetId。网关读回 `input.source=local-file`、5089 字节、64 行，原始字节 SHA-256 一致：`69df841ca9b1e961fc205a75008708f4910e832820c1bdfff85eccada6460622`。

normal 和 repair 的最终报告均核实 `schemaVersion=2`、`rulesVersion=csv-quality-file-v1`。repair 的独立验收记录为先 `accepted=false`、后 `accepted=true`，报告摘要不同，并非仅凭行数或问题数判断成功。refund 没有通过验收的报告，已确认经过 `refund_pending` 到 `simulated_refund_verified` 的终态。

全程仅调用提供的 MCP 工具，未读取 CSV 原始内容。**模拟付款和退款≠支付宝接入，无真钱交易。**