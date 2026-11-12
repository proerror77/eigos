# datasource 推导（第一遍扫描）

- 对象类型：204
- 能定位到写入方：58
- 定位不到：146

定位不到不等于没有数据源，只说明「字面量 type + ingest/objects.push 同文件」这条启发式覆盖不到（变量拼装、路由层、postgres 写入、按请求构造的投影都不在内）。

## 已定位（示例）

- `ServiceRequest` ← capabilities/booking, capabilities/catalog-agent.ts, capabilities/commerce-agent.ts, capabilities/didi, capabilities/domain-agent.ts, capabilities/free-booking, capabilities/geo-agent.ts, capabilities/local-artifact-agent.ts, capabilities/meituan-agent.ts, capabilities/paotui-agent.ts, capabilities/payment-commerce, capabilities/rollinggo, capabilities/sandbox-agent.ts, capabilities/shopify, capabilities/ucp, /Users/proerror/Documents/eigos-worktrees/kernel-cow/packages/coordinator/composition-program.ts, ontology/booking-functions.ts, ontology/capability-catalog.ts, ontology/catalog-agent-projection.ts, ontology/catalog-projection.ts, ontology/commerce-journey-projection.ts, ontology/commerce-projection.ts, ontology/composition-kernel.ts, ontology/customs-policy.ts, ontology/didi-order-test-functions.ts, ontology/domain-projection.ts, ontology/free-booking-functions.ts, ontology/meituan-read-projection.ts, ontology/offer-selection.ts, ontology/paotui-agent-projection.ts, ontology/paotui-business-context.ts, ontology/ride-booking-functions.ts, ontology/ride-estimate-projection.ts, ontology/sandbox-business-projection.ts, ontology/shopify-pa-payment-functions.ts, ontology/stripe-payment-functions.ts, ontology/task-projection.ts
- `Proposal` ← ontology/offer-selection.ts
- `Provider` ← ontology/catalog-agent-projection.ts, ontology/catalog-projection.ts, ontology/paotui-business-context.ts, ontology/ride-estimate-projection.ts
- `Channel` ← ontology/catalog-agent-projection.ts, ontology/catalog-projection.ts, ontology/paotui-business-context.ts
- `SavedAddress` ← ontology/paotui-business-context.ts
- `Parcel` ← ontology/paotui-business-context.ts
- `DeliveryRoute` ← ontology/paotui-business-context.ts
- `DeliveryQuote` ← capabilities/paotui-agent.ts, ontology/offer-selection.ts, ontology/paotui-agent-projection.ts
- `ProductVariant` ← ontology/catalog-agent-projection.ts, ontology/catalog-projection.ts, ontology/commerce-projection.ts
- `ProductOffer` ← ontology/catalog-agent-projection.ts, ontology/catalog-projection.ts
- `Order` ← ontology/commerce-projection.ts
- `OrderLine` ← ontology/commerce-projection.ts
- `AfterSalesCase` ← ontology/sandbox-business-projection.ts
- `SourceReceipt` ← capabilities/geo-agent.ts, capabilities/payment-commerce, capabilities/rollinggo, capabilities/sandbox-agent.ts, capabilities/shopify, capabilities/ucp, ontology/booking-functions.ts, ontology/catalog-agent-projection.ts, ontology/catalog-projection.ts, ontology/commerce-journey-projection.ts, ontology/commerce-projection.ts, ontology/didi-order-test-functions.ts, ontology/errand-domain.ts, ontology/free-booking-functions.ts, ontology/identity-mapping.ts, ontology/meituan-read-projection.ts, ontology/paotui-agent-projection.ts, ontology/ride-booking-functions.ts, ontology/ride-estimate-projection.ts, ontology/shopify-pa-payment-functions.ts, ontology/stripe-payment-functions.ts, ontology/task-projection.ts
- `RideRoute` ← ontology/ride-estimate-projection.ts
- `CheckoutRequest` ← ontology/capability-catalog.ts, ontology/commerce-projection.ts
- `CheckoutSession` ← ontology/commerce-projection.ts
- `CatalogRead` ← ontology/catalog-projection.ts
- `CatalogTask` ← capabilities/catalog-agent.ts
- `CatalogObservation` ← ontology/catalog-agent-projection.ts

## 未定位（前 40）

`Authorization`, `OutcomeAssessment`, `ChannelParticipation`, `ServiceEngagement`, `Place`, `Shipment`, `DeliveryEvent`, `DeliveryAllocation`, `Venue`, `ReservationSlot`, `ReservationOffer`, `Reservation`, `Payment`, `Refund`, `RideRequest`, `RideOption`, `RideTrip`, `RideRouteObservation`, `TransportVehicle`, `TransportVehicleObservation`, `TransportDriver`, `TransportDriverObservation`, `TransportAssignment`, `TransportAssignmentObservation`, `AppointmentRequest`, `AppointmentOption`, `MedicalAppointment`, `Hospital`, `HospitalObservation`, `MedicalDepartment`, `MedicalDepartmentObservation`, `Practitioner`, `PractitionerObservation`, `PatientProfile`, `PatientProfileObservation`, `AppointmentSlot`, `AppointmentSlotObservation`, `FoodRequest`, `FoodOption`, `FoodDelivery`
