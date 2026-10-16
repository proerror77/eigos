# CSV 数据质量审计

支付环境：本地模拟，无真实资金交易

订单：abf94ce6-db34-4d1a-b87f-6a3d765445fc

原文件 SHA-256：69df841ca9b1e961fc205a75008708f4910e832820c1bdfff85eccada6460622

规则：csv-quality-file-v1

数据记录数：64

行号为数据记录序号，不是文件物理行号。额外列仅解析，不审计。

- missing / email：数据记录 1, 14, 27, 40, 53
- duplicate / record_id：数据记录 6, 20
- invalid / email：数据记录 12, 23, 34, 45, 56
- invalid / amount_cny：数据记录 1, 8, 15, 22, 29, 36, 43, 50, 57, 64
- invalid / event_date：数据记录 1, 18, 35, 52
