# datasource 推导（第三遍：模板类型的家族映射）

## 总账（三遍合并）

| 状态 | 数量 | 可信度 |
|---|---:|---|
| 有写入点证据 | 136 | 高（带来源文件） |
| 族推断候选 | 43 | **中——按类型名族 + 声明文件归属推断，未逐条取证** |
| 仍无任何来源 | 25 | — |

204 = 136 + 43 + 25

## 族推断候选（需人工确认，不可直接落库）

- `RideRequest` → `api://didi`（依据：声明文件 未定位）
- `RideOption` → `api://didi`（依据：声明文件 未定位）
- `RideTrip` → `api://didi`（依据：声明文件 未定位）
- `RideRouteObservation` → `api://didi`（依据：声明文件 未定位）
- `TransportVehicle` → `api://didi`（依据：声明文件 未定位）
- `TransportVehicleObservation` → `api://didi`（依据：声明文件 未定位）
- `TransportDriver` → `api://didi`（依据：声明文件 未定位）
- `TransportDriverObservation` → `api://didi`（依据：声明文件 未定位）
- `TransportAssignmentObservation` → `api://didi`（依据：声明文件 未定位）
- `AppointmentRequest` → `api://booking`（依据：声明文件 未定位）
- `AppointmentOption` → `api://booking`（依据：声明文件 未定位）
- `MedicalAppointment` → `api://booking`（依据：声明文件 未定位）
- `Hospital` → `api://booking`（依据：声明文件 未定位）
- `HospitalObservation` → `api://booking`（依据：声明文件 未定位）
- `MedicalDepartment` → `api://booking`（依据：声明文件 未定位）
- `MedicalDepartmentObservation` → `api://booking`（依据：声明文件 未定位）
- `Practitioner` → `api://booking`（依据：声明文件 未定位）
- `PractitionerObservation` → `api://booking`（依据：声明文件 未定位）
- `PatientProfile` → `api://booking`（依据：声明文件 未定位）
- `PatientProfileObservation` → `api://booking`（依据：声明文件 未定位）
- `AppointmentSlot` → `api://booking`（依据：声明文件 未定位）
- `AppointmentSlotObservation` → `api://booking`（依据：声明文件 未定位）
- `FoodRequest` → `api://meituan`（依据：声明文件 未定位）
- `FoodOption` → `api://meituan`（依据：声明文件 未定位）
- `FoodDelivery` → `api://meituan`（依据：声明文件 未定位）
- `FoodMerchant` → `api://meituan`（依据：声明文件 未定位）
- `FoodMerchantObservation` → `api://meituan`（依据：声明文件 未定位）
- `MenuItem` → `api://meituan`（依据：声明文件 未定位）
- `MenuItemObservation` → `api://meituan`（依据：声明文件 未定位）
- `HotelRequest` → `api://booking`（依据：声明文件 未定位）
- `HotelOption` → `api://booking`（依据：声明文件 未定位）
- `HotelReservation` → `api://booking`（依据：声明文件 未定位）
- `HotelPropertyObservation` → `api://booking`（依据：声明文件 未定位）
- `RoomTypeObservation` → `api://booking`（依据：声明文件 未定位）
- `RoomInventory` → `api://booking`（依据：声明文件 未定位）
- `RoomInventoryObservation` → `api://booking`（依据：声明文件 未定位）
- `HotelRatePlanObservation` → `api://booking`（依据：声明文件 未定位）
- `VehicleRequest` → `api://didi`（依据：声明文件 未定位）
- `VehicleOption` → `api://didi`（依据：声明文件 未定位）
- `VehicleBooking` → `api://didi`（依据：声明文件 未定位）
- `VehicleClass` → `api://didi`（依据：声明文件 未定位）
- `VehicleClassObservation` → `api://didi`（依据：声明文件 未定位）
- `VehicleInspectionObservation` → `api://didi`（依据：声明文件 未定位）

## 仍无来源（25）

`ChannelParticipation`, `Venue`, `ReservationSlot`, `ReservationOffer`, `Reservation`, `ItineraryRequest`, `ItineraryOption`, `Itinerary`, `ItineraryItem`, `ItineraryItemObservation`, `TravelLegObservation`, `RentalPolicy`, `RentalPolicyObservation`, `InventoryReservation`, `FactRequirement`, `NetworkInquiry`, `NetworkNeed`, `NetworkPublication`, `NetworkProfile`, `NetworkListing`, `NetworkRepresentation`, `NetworkVisibility`, `NetworkSelection`, `DocumentTask`, `DocumentDraft`

这 25 个集中在 Network* / Itinerary* / Rental* / Document* 四族：它们更像**派生/中间表示**（发布、可见性、需求、草稿），可能本来就没有外部数据源，而是由其它对象计算得出 —— 这种情况在 Palantir 里应写成派生态（dataset//函数产出），或明确标注 `derived: true`，而不是硬编一个 provider。
