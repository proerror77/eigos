# CSV 数据质量审计

支付环境：本地模拟，无真实资金交易

订单：e738a656-4563-419f-b72c-3b639d355757

原文件 SHA-256：f9e82357291a9592cf5f1fb3aaaacec17d901971991f2b2fdd90da3ff082c0a4

规则：csv-quality-file-v1

数据记录数：6

行号为数据记录序号，不是文件物理行号。额外列仅解析，不审计。

- missing / email：数据记录 5
- duplicate / record_id：数据记录 2, 4
- invalid / email：数据记录 3
- invalid / amount_cny：数据记录 3
- invalid / event_date：数据记录 4
