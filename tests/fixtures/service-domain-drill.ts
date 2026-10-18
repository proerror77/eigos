import { digest } from '../../packages/core/delegation.js';
import { businessModel } from '../../packages/ontology/business-model.js';
import { domainCapabilityId, projectDomainSnapshot, type DomainSnapshot } from '../../packages/ontology/domain-projection.js';
import { serviceDomain, type ServiceDomain } from '../../packages/ontology/service-domains.js';
import type { ServiceRequest } from '../../packages/ontology/execution.js';
import type { DrillDataset } from '../../examples/ontology-drill.js';
import { domainFixture } from './service-domains.js';

export const SERVICE_DRILL_QUESTIONS = [
  ['B01', 'ride', '司机已经接单，这次乘车服务可以结案了吗？请核对目的地、人数、时间及车费，并说明还缺什么。'],
  ['B02', 'ride', '当前可见的两份乘车方案中，哪份满足这次委托，哪份还不能选？请说明费用与未知项，并提出相应业务决策；不要实际叫车。'],
  ['B03', 'ride', '来源把行程记为已完成。这是否代表本次用户目标已经满足？请找出具体不符之处。'],
  ['B04', 'appointment', '这次挂号已显示缴费成功，是否可以告诉就诊人已经挂好号？请说明确认状态和还需核对的事项。'],
  ['B05', 'appointment', '请查明这次挂号对应哪个院区、科室、医生、匿名就诊人和时段，并判断预约是否已有效确认。'],
  ['B06', 'appointment', '这次号源曾被保留且已缴费，目前还能说预约有效吗？又是否已有退费完成的依据？'],
  ['B07', 'food', '这份外卖委托目前可以结案吗？如果数量还不够，应继续等待还是已经可以认定最终失败？'],
  ['B08', 'food', '配送记录显示数量齐了。请核对商品规格、忌口、目的地和费用，判断是否满足原委托。'],
  ['B09', 'food', '请说明这次外卖是否已完成用户目标，列出商家、实际菜品规格与数量、送达地点和时间、费用依据。'],
  ['B10', 'hotel', '酒店款项已支付且有供应方业务编号，现在能否告诉用户已经订妥？还需要哪些证据？'],
  ['B11', 'hotel', '这次酒店委托的具体入住安排是什么，要求的服务是否已完成？能否同时声称用户已完成住宿？'],
  ['B12', 'hotel', '酒店记录显示已经退房。请判断它是否满足用户要求的完整住宿，核对计划日期与实际入住退房时间。'],
  ['B13', 'itinerary', '这份行程方案可以交付了吗？哪些安排已经预订，哪些还没有？请区分方案完成和预订完成。'],
  ['B14', 'itinerary', '请检查这份行程是否可行，尤其是前后地点、时间和换乘缓冲；若不符合原要求，说明需要调整什么。'],
  ['B15', 'itinerary', '总记录被标为已订妥，是否每项需要预订的服务都已确认？这次委托能否结案？'],
  ['B16', 'vehicle', '这次预约用车没有用户驾驶人引用。是否因此不能成立？请查明用车模式、安排、确认状态与费用。'],
  ['B17', 'vehicle', '自驾租车已有确认编号，是否已经满足本次委托？请核对资格、租期、车型、人数、费用和押金。'],
  ['B18', 'vehicle', '车已经归还，验车也已接受，这件租车服务能否关闭？还应核对哪些资金或业务状态？'],
] as const;

export function serviceDrillDatasets(now: number): DrillDataset[] {
  return SERVICE_DRILL_QUESTIONS.map(([id, domain, question]) => {
    const f = domainFixture(domain, now), snapshot: DomainSnapshot = structuredClone(f.snapshot);
    snapshot.requestId = `request-${id}`; snapshot.sourceEventId = `event-${id}`;
    const parameters = snapshot.parameters, result: Record<string, unknown> = structuredClone(f.result);
    const amounts: Record<ServiceDomain, string> = { ride: '1850', appointment: '3500', food: '6840', hotel: '39800', itinerary: '23600', vehicle: '28800' };
    snapshot.option.total.minor = amounts[domain];
    const price = { minor: amounts[domain], currency: 'CNY' };
    if (domain === 'ride') result.finalFare = price; else if (domain === 'appointment') result.fee = price; else result.total = price;
    if (id === 'B01') { result.state = 'accepted'; delete result.pickedUpAt; delete result.arrivedAt; delete result.destination; }
    if (id === 'B03') { result.destination = 'synthetic-wrong-stop'; result.finalFare = { minor: '55000', currency: 'CNY' }; }
    if (id === 'B04') { result.state = 'pending'; delete result.confirmedAt; }
    if (id === 'B06') { result.state = 'held'; result.holdExpiresAt = f.at(-5); delete result.confirmedAt; }
    if (id === 'B07') { result.state = 'partial'; result.deliveredItems = [{ sku: 'meal-A', quantity: 1, specification: 'large-no-peanuts' }]; result.finalDelivery = false; delete result.deliveredAt; }
    if (id === 'B08') { result.deliveredItems = [{ sku: 'meal-A', quantity: 2, specification: 'small-standard' }]; result.ingredientCheck = 'unknown'; }
    if (id === 'B10') { result.state = 'pending'; result.paymentState = 'paid'; delete result.confirmationCode; delete result.confirmedAt; }
    if (id === 'B12') {
      parameters.endpoint = 'stay_completed'; parameters.checkIn = f.at(-4320).slice(0, 10); parameters.checkOut = f.at(-1440).slice(0, 10);
      result.state = 'checked_out'; result.checkIn = parameters.checkIn; result.checkOut = parameters.checkOut;
      result.checkedInAt = `${parameters.checkIn}T15:00:00+08:00`; result.checkedOutAt = `${f.at(-2880).slice(0, 10)}T11:00:00+08:00`;
      const inventory = snapshot.entities.find(e => e.type === 'RoomInventory')!; inventory.properties.checkIn = parameters.checkIn; inventory.properties.checkOut = parameters.checkOut;
    }
    if (id === 'B14') {
      const legs = parameters.legs as { startsAt: string; endsAt: string }[];
      legs[1]!.startsAt = new Date(Date.parse(legs[0]!.endsAt) + 10 * 60000).toISOString();
      (result.legs as { startsAt: string }[])[1]!.startsAt = legs[1]!.startsAt;
    }
    if (id === 'B15') {
      parameters.endpoint = 'booked'; result.state = 'booked'; (result.legs as { bookingState: string }[])[0]!.bookingState = 'held';
    }
    if (id === 'B16') { parameters.mode = 'chauffeured'; delete parameters.driverKey; result.mode = 'chauffeured'; delete result.driverKey; }
    if (id === 'B17') delete result.eligibilityVerified;
    if (id === 'B18') {
      parameters.endpoint = 'completed'; parameters.startsAt = f.at(-180); parameters.endsAt = f.at(30);
      result.startsAt = parameters.startsAt; result.endsAt = parameters.endsAt; result.state = 'returned'; result.pickedUpAt = f.at(-150); result.returnedAt = f.at(-10); result.returnAccepted = true; result.depositState = 'pending';
      Object.assign(snapshot.entities.find(e => e.type === 'VehicleInspection')!.properties, { stage: 'return', occurredAt: f.at(-10), accepted: true });
    }
    snapshot.option.parametersDigest = digest(parameters); snapshot.option.offeredParameters = structuredClone(parameters);
    result.requestDigest = digest(parameters);
    if (id !== 'B02') snapshot.observation = result;
    const snapshots = [snapshot];
    if (id === 'B02') {
      const incomplete = structuredClone(snapshot); incomplete.option.id = 'option-2'; incomplete.option.total = { minor: '1200', currency: 'CNY' }; incomplete.option.feesComplete = false; snapshots.push(incomplete);
    }
    const d = serviceDomain(domain);
    const request: ServiceRequest = { id: snapshot.requestId, revision: 1, originalGoal: `${d.name}合成业务委托；按已保存的明确参数完成约定终点。`, requirements: [], executionEnvironment: 'sandbox', messages: [{ id: `message-${id}`, text: question, receivedAt: f.at(-3) }] };
    return { id, question, request, asOf: new Date(now).toISOString(), datasetVersion: 'service-domain-drill-2', datasetDigest: digest({ model: businessModel.ref, request, snapshots }), initialize(graph, owner) {
      graph.ingest(owner, { objects: [{ ref: { type: 'ServiceRequest', id: request.id }, properties: { requestId: request.id, displayTitle: '本次服务委托', originalGoal: request.originalGoal, revision: 1, progress: 'planning' } }] }, { kind: 'synthetic', id, observedAt: f.at(-3) });
      for (const record of snapshots) {
        const projected = projectDomainSnapshot(graph, owner, domainCapabilityId(domain), request, parameters, record);
        if (projected.state !== 'typed_result') throw new Error(`Drill dataset ${id} did not project`);
      }
    } } satisfies DrillDataset;
  });
}
