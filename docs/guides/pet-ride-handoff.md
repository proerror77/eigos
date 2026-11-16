# 携宠出行接力试点

滴滴 App 有「宠物出行」。[滴滴公开 MCP](https://mcp.didichuxing.com/api) 的通用估价和发单契约没有携宠参数。试点使用原 PA 的合成回包验证流程，所有测试请求、报价和回执均带 `synthetic`，没有接入真实 App 或供应商发单。

1. 在原 PA 任务用 `PreparePetRideHandoff` 保存城市、起终点、宠物种类、体重、是否使用携宠箱及明确指定的携宠车型。一个任务只准备一份固定请求。
2. 同一任务调用 `complete_with_action`，对返回对象使用 `PetRide.recordReceipt`（对应 `RecordPetRideReceipt`），再用 `readPetRideHandoff` 读出结果，结果参数为 `handoff`。依次通过原任务的 `list_pa_requests` 和 `respond_to_task` 回传报价与审批。审批绑定确切的金额、车型、路线和宠物条件。拒绝或报价到期后结束试点，不发测试单。
3. Engine 把唯一发单意图和测试 PA 请求写进同一个事务，然后等待 PA 回读原单。只有这些测试请求会使用 `pet_ride.synthetic.submit` 和 `pet_ride.synthetic.lookup`。提交回复不充当读回证据。原单暂不可核对时记录 `unknown`，后续可对同一个 handoff 调 `RecordPetRideReceipt` 继续查原单，保留原任务和原订单身份。

`readPetRideHandoff` 返回已保存的报价、回执与状态，`stateLogs` Link 可查询状态变化。回执只证明本次合成查询读到的状态。Engine 使用现有 PA 任务、Action 事务和 `ExternalOperations`，沿用 [Palantir Action 与提交条件](https://www.palantir.com/docs/foundry/action-types/submission-criteria) 的审批边界。接入真实 App 还需要授权的 PA 设备适配器、用户在 App 里的实际确认，以及可独立读取的供应商原单。
