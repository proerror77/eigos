# 43 个族推断类型的逐条取证结果

判据三层：
1. **直接证据** —— 写入文件里出现该类型字面量（`type: 'X'`）→ 上一轮已全部失败，这 43 个都是 0；
2. **模板证据** —— 写入文件里用模板拼出该类型名（`` `${X}…` ``）→ **0 条**；
3. **弱证据** —— 写入文件里出现该族词干（如 `Ride`）→ 33 条，不能确定是该类型。

结论：**这 43 个类型没有任何一条写入点的证据**。族映射只是名字相似，不构成来源。

## 弱证据（写入文件提到族词干，不等于写这个类型）

- `RideRequest`：ontology/business-facts-kernel.ts, ontology/composition-kernel.ts, ontology/definition-store.ts
- `RideOption`：ontology/business-facts-kernel.ts, ontology/composition-kernel.ts, ontology/definition-store.ts
- `RideTrip`：ontology/business-facts-kernel.ts, ontology/composition-kernel.ts, ontology/definition-store.ts
- `RideRouteObservation`：ontology/business-facts-kernel.ts, ontology/composition-kernel.ts, ontology/definition-store.ts
- `TransportVehicle`：core/member-source.ts, ontology/domain-projection.ts, postgres/source-projection.ts
- `TransportVehicleObservation`：core/member-source.ts, ontology/domain-projection.ts, postgres/source-projection.ts
- `TransportDriver`：core/member-source.ts, ontology/domain-projection.ts, postgres/source-projection.ts
- `TransportDriverObservation`：core/member-source.ts, ontology/domain-projection.ts, postgres/source-projection.ts
- `TransportAssignmentObservation`：core/member-source.ts, ontology/domain-projection.ts, postgres/source-projection.ts
- `AppointmentRequest`：ontology/domain-projection.ts
- `AppointmentOption`：ontology/domain-projection.ts
- `Hospital`：ontology/domain-projection.ts
- `HospitalObservation`：ontology/domain-projection.ts
- `Practitioner`：ontology/domain-projection.ts
- `PractitionerObservation`：ontology/domain-projection.ts
- `AppointmentSlot`：ontology/domain-projection.ts
- `AppointmentSlotObservation`：ontology/domain-projection.ts
- `MenuItem`：ontology/domain-projection.ts
- `MenuItemObservation`：ontology/domain-projection.ts
- `HotelRequest`：capabilities/rollinggo/program.ts, ontology/business-facts-kernel.ts, ontology/definition-store.ts
- `HotelOption`：capabilities/rollinggo/program.ts, ontology/business-facts-kernel.ts, ontology/definition-store.ts
- `HotelReservation`：capabilities/rollinggo/program.ts, ontology/business-facts-kernel.ts, ontology/definition-store.ts
- `HotelPropertyObservation`：capabilities/rollinggo/program.ts, ontology/business-facts-kernel.ts, ontology/definition-store.ts
- `RoomTypeObservation`：ontology/domain-projection.ts, ontology/hotel-package-optimization/pipeline.ts, ontology/hotel-package-optimization/synthetic.ts
- `RoomInventory`：ontology/domain-projection.ts, ontology/hotel-package-optimization/pipeline.ts, ontology/hotel-package-optimization/synthetic.ts
- `RoomInventoryObservation`：ontology/domain-projection.ts, ontology/hotel-package-optimization/pipeline.ts, ontology/hotel-package-optimization/synthetic.ts
- `HotelRatePlanObservation`：capabilities/rollinggo/program.ts, ontology/business-facts-kernel.ts, ontology/definition-store.ts
- `VehicleRequest`：ontology/domain-projection.ts
- `VehicleOption`：ontology/domain-projection.ts
- `VehicleBooking`：ontology/domain-projection.ts
- `VehicleClass`：ontology/domain-projection.ts
- `VehicleClassObservation`：ontology/domain-projection.ts
- `VehicleInspectionObservation`：ontology/domain-projection.ts

## 零证据（10）

`MedicalAppointment`, `MedicalDepartment`, `MedicalDepartmentObservation`, `PatientProfile`, `PatientProfileObservation`, `FoodRequest`, `FoodOption`, `FoodDelivery`, `FoodMerchant`, `FoodMerchantObservation`

## 这对 Palantir 口径意味着什么

对象类型有定义、却没有可定位的写入方，等于**定义存在但未接线**。在 Palantir 里它建得出来、但永远没有实例。正确处理是二选一：

- 它由其它对象派生 → 标派生态（函数/投影产出），`datasource` 指向 `dataset://` 或函数映射；
- 它确实该由 provider 提供、只是接线没做 → 记为缺口，**不填假 datasource**。

无论哪种，都不能把族名当数据源写进模型。
