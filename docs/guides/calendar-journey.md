# 下一站的动态出发提醒

PA 选择一场出发前的活动和下一场活动，明确授权监测范围。EIGOS 以 `CalendarJourney` 记录这段行程。Worker 重读原日历活动，再调用已有 `estimateMapRoute` 和 `readWeather`。`readCalendarJourney` 通过 Ontology MCP 返回当前准备时间、提醒版本和变化原因。用户只问天气或路线时，可以直接调用原 Function。

这对应 Palantir 的时间条件、Function 支持的建议、Action 写入和 Process Log。EIGOS 使用现有 `ScheduledActions` 与 Worker 复查，监测计划和提醒状态提交到同一 Ontology。这里只更新内部出发建议。需要移动日历活动时，候选编辑应进入现有 Scenario 和排程复核。参考 [Automate](https://www.palantir.com/docs/foundry/automate/overview)、[Dynamic Scheduling](https://www.palantir.com/docs/foundry/dynamic-scheduling/scheduling-concepts)、[Scenario](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario)和 [Machinery](https://www.palantir.com/docs/foundry/machinery/connect-data)。

## 启用与读取

1. 在有权限的 PA 中选择两个真实、带时间和地点的活动，保留各自的 `calendarId` 和实例 `eventId`。重复日程使用单次事件 ID。
2. PA 明确调用 `apply_ontology_action`，提交 `StartCalendarJourney`。参数为 `origin`、`destination`、`monitorUntil` 和 `mode`。监测截止时间最多为未来 48 小时，应覆盖下一场活动开始时间。可配置准备、入场和雨雪缓冲，默认分别为 5、10 和 5 分钟。
3. 原 PA 用现有 `list_pa_requests` 或 `GET /pa/requests` 读取 `calendar.journey.read`，按请求中这两个 ID 分别获取时段、地点、版本和取消状态，通过 `respond_to_task` 回传。Worker 复查用同一个持久任务，每轮有新的请求号。Google Calendar 的 PA 可在其现有日历登录上使用 `CalendarJourneyPA` 和 `googleCalendarJourneyReader`。本地调试可在 PA 环境提供 `EIGOS_PA_URL`、`EIGOS_PA_TOKEN`、`GOOGLE_CALENDAR_ACCESS_TOKEN`，运行构建后的 `node dist/scripts/calendar-journey-pa.js TASK_ID` 回答一次待办。Calendar 凭据留在原 PA。参考 [Google Calendar Events.get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)。
4. 原 PA 保存 `StartCalendarJourney` 返回的旅程引用，通过 `evaluate_ontology` 读取 `readCalendarJourney({journey})`。PA 使用旅程 ID 和 `reminderVersion` 替换提醒或去重，在发出前重读当前状态。提醒为空或超过 `validUntil` 时，PA 撤回待发送的提醒。PA 可调用 `CancelCalendarJourney` 停止复查。

原 PA 必须负责消费既有待办。PA 离线或无新回执时，旧提示到期后失效。拒绝日历访问会终止本次监测。活动无明确地点、供应商失败或回执过期时，状态显示不可用。启用需要两项来源 `PACalendar`、`Amap` 的读取权限，以及读取旅程对象、所需 Function 和 Action 的权限。Worker 校验原高德连接身份，换账号后需重新授权。工具日志只记录已提交的业务状态，连续的路线更新可从现有编辑历史检查。

## PA 投递提醒

EIGOS 把版本化提醒交给发起跟踪的 PA。PA 根据用户授权和自身已有的通知能力选择投递渠道，管理启用、更新和撤回，并按自身渠道的回执确认送达。PA 可以用现有 `tasks:read` 在当前 Eigos Ontology 读取自己的行程提醒和航班提醒，仍须通过 Function、来源和值的访问校验。上线验收应从用户原来的 PA 发起，在同一 PA 核对提醒和投递结果。对应 Palantir 的 [Notification effects](https://www.palantir.com/docs/foundry/automate/effect-notification) 和 [Ontology MCP](https://www.palantir.com/docs/foundry/ontology-mcp/getting-started)。

若用户和 PA 选择 Google 日历作为渠道，PA 可自主启用 `GoogleCalendarReminders`。构建后在 PA 环境运行 `node dist/scripts/calendar-journey-pa.js --reminders /absolute/private/reminder.json`。配置使用权限 0600，包含 `object`、`stopAt` 以及行程的 `selection`。PA 提供自己的 `EIGOS_PA_TOKEN_FILE`、`GOOGLE_CALENDAR_ACCESS_TOKEN_FILE`、`GOOGLE_CALENDAR_REMINDER_ID` 和稳定的 `EIGOS_PA_REMINDER_NAMESPACE`。适配器只更新由该 PA 创建的私人提醒，日历凭据留在 PA。参考 [Google Calendar reminders](https://developers.google.com/workspace/calendar/api/concepts/reminders)。

## 准备时间怎么算

以后一场活动的开始时间为准，倒扣入场时间、高德路线用时、天气缓冲、出门准备时间。前一场结束晚于计算出的准备时间时，标记日历冲突。明显晚于出发时间时提示迟到风险。临近准备时间，复查频率从 30 或 15 分钟逐步提高到 5 或 1 分钟。日期临近时读天气实况，较远用当日昼夜预报做保守缓冲。天气缓冲和高德路线用时在结果中分别记录。

同一活动、地点、提醒分钟及风险状态反复回查，不增加提醒版本。活动改期、估时变化或天气改变导致提醒变化时，替换旧版本。任一活动明确取消时，撤回提醒并结束复查。Google 接口未找到事件视为不可用，明确的 `cancelled` 才视为取消。

可以经 `query_ontology` 使用 `{type:"ProcessLog",from:{object:journey,link:"stateLogs"}}` 检查已提交的行程状态。路线、天气和日历观测作为同一行程的证据，均可按现有对象和编辑历史读取。

## 验收

`npm test -- --suite=29` 用真实 PostgreSQL、Gateway MCP、Worker 和同一个 PA 续接。Google Calendar 及高德只读响应采用测试替身。场景覆盖车程 25 分钟增至 40 分钟、降雨缓冲、提前改期、日历冲突、取消、同一观测去重、提醒有效期、换高德连接以及撤销 PA 权限。正式联调需要已授权的高德连接和用户选定的两场日历活动。
