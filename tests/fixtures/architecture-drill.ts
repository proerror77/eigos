import architectureQuestions from './architecture-questions.json' with { type: 'json' };
// Scenario inputs only. No expected answers or navigation paths are exposed to participants.
// All identities, provider records and operational effects are synthetic.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DrillDataset } from '../../examples/ontology-drill.js';
import { businessModel } from '../../packages/ontology/business-model.js';
import { digest } from '../../packages/core/delegation.js';
import { JobStore } from '../../packages/core/store.js';
import { TaskService } from '../../packages/core/tasks.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { domainCapability } from '../../packages/capabilities/domain-service.js';
import { BACKEND_VERSION, type ServiceRequest } from '../../packages/ontology/execution.js';
import type { Job } from '../../packages/core/domain.js';
import { projectTask } from '../../packages/ontology/task-projection.js';
import { projectExecution } from '../../packages/ontology/execution-projection.js';
import { projectBusinessChain } from '../../packages/ontology/business-chain-projection.js';
import { projectCapabilityCatalog } from '../../packages/ontology/capability-catalog.js';
import { projectDomainSnapshot, domainCapabilityId, type DomainSnapshot } from '../../packages/ontology/domain-projection.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectBatch, type ObjectWrite } from '../../packages/ontology/object-store.js';
import type { ObjectRef } from '../../packages/ontology/model.js';
import { syntheticOntology } from './ontology-objects.js';
import { domainFixture, domainProvider } from './service-domains.js';
import { setupPABooking } from './pa-booking.js';
import { setupCommerce } from './commerce-agent.js';
import { inquiryFixture } from './network-inquiry.js';
import { backend, owner, principal, reasoner, interpretation } from '../backend-fixture.js';

export const architectureQuestionIds = ['G01','G02','G03','G04','G05','H01','H02','H03','S01','S02','S03','S04','S05','V01','V02','V03','V04','V05'];
const questionMap = () => new Map(Object.entries(architectureQuestions));
const at = (now: number, minutes = 0) => new Date(now + minutes * 60000).toISOString();
function request(id: string, goal: string, now: number): ServiceRequest { return { id: `architecture-${id}`, revision: 1, originalGoal: goal, requirements: [], executionEnvironment: 'sandbox', messages: [{ id: `instruction-${id}`, text: goal, receivedAt: at(now, -10) }] }; }
function projectRequest(graph: OntologyObjectStore, actor: string, r: ServiceRequest, now: number) {
  const job: Job = { id: r.id, contextId: r.id, service: 'eigos.delegate', goal: r.originalGoal, state: 'working', messages: [], createdAt: r.messages[0]!.receivedAt, updatedAt: at(now), delegation: { backendVersion: BACKEND_VERSION, request: r, phase: 'planning', events: [] } };
  projectTask(graph, actor, job); projectExecution(graph, actor, job); projectBusinessChain(graph, actor, job, { intents: [], attempts: [], observations: [], grants: [], cases: [] });
}
function seal(batch: ObjectBatch) {
  for (const receipt of batch.objects.filter(o => o.ref.type === 'SourceReceipt')) {
    const subjects = receipt.properties.subjects as { object: ObjectRef; digest: string; linksDigest: string }[];
    for (const subject of subjects) { const value = batch.objects.find(o => digest(o.ref) === digest(subject.object)); if (!value) throw new Error('Missing evidence subject'); subject.digest = digest(value.properties); subject.linksDigest = linkSnapshotDigest(subject.object, batch.links ?? []); }
    receipt.properties.contentDigest = digest(subjects);
  }
}
function record(type: string, id: string, values: Record<string, unknown>): ObjectWrite { return { ref: { type, id }, properties: { [businessModel.object(type).primaryKey]: id, displayTitle: id, ...values } }; }

export async function architectureDrillDatasets(directory: string, now = Date.now()): Promise<DrillDataset[]> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const questions = questionMap(), datasets = new Map<string, DrillDataset>(), facts: Record<string, unknown> = {};
  const register = (id: string, r: ServiceRequest, inputFacts: unknown, initialize: DrillDataset['initialize'], datasetOwner?: string) => {
    facts[id] = { request: r, facts: inputFacts };
    datasets.set(id, { id, question: questions.get(id)!, request: r, asOf: at(now), datasetVersion: 'architecture-drill-2', datasetDigest: digest({ request: r, facts: inputFacts }), owner: datasetOwner, initialize });
  };
  const capture = (id: string, store: JobStore, job: Job, extraFacts: unknown = {}, actor = owner) => {
    const db = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      const tables = Object.fromEntries(['ontology_objects', 'ontology_links', 'ontology_revisions'].map(name => [name, db.prepare(`SELECT * FROM ${name} WHERE owner=?`).all(actor)]));
      const r = structuredClone(job.delegation!.request), payload = { tables, extraFacts };
      register(id, r, payload, (_graph, _actor, target) => {
        if (!target) throw new Error('Raw runtime snapshot requires isolated dataset database');
        target.exec('BEGIN');
        try { for (const [name, rows] of Object.entries(tables)) for (const row of rows) { const columns = Object.keys(row); target.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(k => row[k] as SQLInputValue)); } target.exec('COMMIT'); }
        catch (error) { target.exec('ROLLBACK'); throw error; }
      }, actor);
      datasets.get(id)!.asOf = new Date().toISOString();
    } finally { db.close(); }
  };
  const domain = (id: string, name: 'hotel' | 'ride' | 'vehicle', change: (s: DomainSnapshot, result: Record<string, unknown>) => void = () => {}, goal?: string) => {
    const f = domainFixture(name, now), s = structuredClone(f.snapshot), result: Record<string, unknown> = structuredClone(f.result);
    const r = request(id, goal ?? `${name} 委托，按保存的明确要求和约定终点判断。`, now); s.requestId = r.id; s.sourceEventId = id;
    change(s, result); s.option.parametersDigest = digest(s.parameters); s.option.offeredParameters = structuredClone(s.parameters); result.requestDigest = digest(s.parameters); s.observation = result;
    register(id, r, { snapshot: s }, (g, a) => { projectRequest(g,a,r,now); const p = projectDomainSnapshot(g,a,domainCapabilityId(name),r,s.parameters,s); if(p.state!=='typed_result') throw new Error(`${id}: invalid fixture projection`); });
  };
  const classic = (id: string, alter: (b: ObjectBatch) => void) => {
    const f = syntheticOntology(now); alter(f.batch); seal(f.batch);
    const root = f.batch.objects.find(o => o.ref.id === 'G')!;
    const r: ServiceRequest = { id: 'G', revision: 1, originalGoal: String(root.properties.originalGoal), requirements: [], conditions: root.properties.conditions as ServiceRequest['conditions'], executionEnvironment: 'sandbox', messages: [{ id: 'synthetic-user-message', text: String(root.properties.originalGoal), receivedAt: at(now,-10) }] };
    register(id,r,{ batch:f.batch, source:f.source },(g,a)=>{ g.ingest(a,f.batch,f.source); projectRequest(g,a,r,now); });
  };

  // Current instructions are projected through the same request graph code as production.
  const g01 = request('G01','购买两件黑色256GB全新商品，预算500元，送到地址A。',now);
  const g01old = structuredClone(g01); g01.revision=2;
  g01.messages.push({id:'correction-G01',text:'改为白色256GB全新三件，预算总共350元，送到地址B；其余要求不变。',receivedAt:at(now,-2)});
  register('G01',g01,{original:g01old,current:g01},(g,a)=>{projectRequest(g,a,g01old,now-120000);projectRequest(g,a,g01,now);});

  console.log(JSON.stringify({ preparing: 'G02', source: 'isolated-booking-runtime' }));
  const bookingPath=join(directory,'booking-source.sqlite'), booking=await setupPABooking({databasePath:bookingPath,holdMs:3600000});
  try {
    const submitted=booking.submit(), waiting=await booking.finish(submitted.id);
    if(!waiting.delegation?.agent?.paPayment) throw new Error('Booking handoff not reached');
    const revoked=booking.b.tasks.revokeAuthorization(principal,waiting.id,randomUUID());
    capture('G02',booking.store,revoked,{source:'fixture-booking',paymentAttempts:booking.wallet.attempts.length,revoked:true});
  } finally {await booking.close();}

  const network=inquiryFixture();
  try {
    const inquiry=network.convert();
    capture('G03',network.jobs,network.jobs.get(network.owner,inquiry.taskId),{source:'network-fixture',inquiry,listing:network.store.get('listing',network.listingId),publication:network.store.get('publication',network.listingPublicationId),representation:network.store.get('representation',network.representationId)},network.owner);
    const data = datasets.get('G03')!, initialize = data.initialize;
    data.initialize = (graph, actor, database) => { initialize(graph, actor, database); return graph.withReadOverlay(network.service.ontologyReader(network.a.p, network.a.token)); };
    data.close = () => network.close();
  } catch (error) { network.close(); throw error; }

  const g04=request('G04','比较当前能用于购物、酒店、即时叫车、预约接送和自驾租车的服务能力及其授权。',now);
  const providers=['hotel','ride','vehicle'].map(d=>domainProvider(d as 'hotel'|'ride'|'vehicle').provider), catalog=createExecutionCatalog({domainSandboxProviders:providers});
  const summaries=catalog.summaries(owner,16,'sandbox');
  register('G04',g04,{capabilities:summaries},(g,a)=>{projectRequest(g,a,g04,now);projectCapabilityCatalog(g,a,g04.id,summaries);});

  console.log(JSON.stringify({ preparing: 'G05', source: 'isolated-domain-runtime' }));
  const ride=domainProvider('ride',{failAfterSubmit:true,pending:true}), runtimeStore=new JobStore(join(directory,'ride-source.sqlite'));
  const rideCapability=domainCapability('ride'), rideCatalog=createExecutionCatalog({domainSandboxProviders:[ride.provider]});
  const rb=backend(rideCatalog,reasoner(r=>({...interpretation(r,rideCapability.ref.id,ride.parameters),capabilityRef:rideCapability.ref})),runtimeStore,{allowSandbox:true});
  try {
    const submitted=rb.submit({goal:'完成约定的合成接送，未知结果先核对原操作。',executionEnvironment:'sandbox'});
    let job=await rb.run();
    if(job.state!=='auth-required') throw new Error(`Ride authorization absent: ${job.state}`);
    const auth=job.delegation!.authorizationRequest!;
    rb.tasks.authorize(principal,job.id,{action:'approve_plan',requestId:randomUUID(),planDigest:auth.planDigest,allowedEffects:auth.effects,maxAmount:auth.maxAmount,payeeIds:auth.payeeIds,expiresAt:at(Date.now(),30),environment:'sandbox'});
    job=await rb.run();
    capture('G05',runtimeStore,job,{providerRecords:[...ride.ledger.values()],counters:ride.counters(),originalTaskId:submitted.id});
  } finally {runtimeStore.close();}

  const hotelRuntime=domainProvider('hotel'), hotelStore=new JobStore(join(directory,'hotel-source.sqlite'));
  hotelRuntime.parameters.budget={minor:'35000',currency:'CNY'};hotelRuntime.snapshot.option.total={minor:'30000',currency:'CNY'};
  const hotelCapability=domainCapability('hotel'), hotelCatalog=createExecutionCatalog({domainSandboxProviders:[hotelRuntime.provider]});
  const hb=backend(hotelCatalog,reasoner(r=>({...interpretation(r,hotelCapability.ref.id,hotelRuntime.parameters),capabilityRef:hotelCapability.ref})),hotelStore,{allowSandbox:true});
  try {
    hb.submit({goal:'为两人预订指定日期酒店，两晚总费用上限350元；只批准准确的300元预订方案，不允许付款。',executionEnvironment:'sandbox',requirements:[{id:'budget',kind:'budget',role:'service_total',strength:'hard',expected:{minor:'35000',currency:'CNY'}}]});
    let job=await hb.run();if(job.state!=='auth-required')throw new Error(`Hotel authorization absent: ${job.state}`);
    const auth=job.delegation!.authorizationRequest!;
    job=hb.tasks.authorize(principal,job.id,{action:'approve_plan',requestId:randomUUID(),planDigest:auth.planDigest,allowedEffects:auth.effects,maxAmount:auth.maxAmount,payeeIds:auth.payeeIds,expiresAt:at(Date.now(),30),environment:'sandbox'});
    const next=structuredClone(hotelRuntime.snapshot);next.requestId=job.id;next.parameters=structuredClone(hotelRuntime.parameters);next.option.offeredParameters=structuredClone(next.parameters);next.option.parametersDigest=digest(next.parameters);
    next.sourceEventId='H01-new-price';next.sourceVersion=2;next.option.id='new-price';next.option.observedAt=new Date().toISOString();next.option.expiresAt=at(Date.now(),30);next.option.total={minor:'36000',currency:'CNY'};
    const inventory=next.entities.find(e=>e.type==='RoomInventory')!;inventory.properties.roomsAvailable=0;inventory.properties.sourceRevision='2';inventory.properties.observedAt=next.option.observedAt;
    if(projectDomainSnapshot(hotelStore.ontology,owner,hotelCapability.ref.id,job.delegation!.request,next.parameters,next).state!=='typed_result')throw new Error('Hotel changed quote projection failed');
    capture('H01',hotelStore,job,{newQuote:next,providerWrites:hotelRuntime.counters().submits});
  } finally {hotelStore.close();}
  domain('H02','hotel',(_s,r)=>{r.state='pending';r.paymentState='paid';delete r.confirmedAt;delete r.confirmationCode;},'为两人确认指定日期、房型的酒店预订。PA报告已付款，需要核对原预订是否确认。');
  const h03=request('H03','比较两个来源编号为123的海景酒店及其房型与条款，不能根据同名擅自视为相同。',now);
  const hotelA=domainFixture('hotel',now).snapshot, hotelB=structuredClone(hotelA);
  for(const [index,s] of [hotelA,hotelB].entries()){
    s.requestId=h03.id;s.sourceId=`hotel-source-${index}`;s.sourceEventId=`H03-${index}`;s.option.providerId=`hotel-provider-${index}`;s.option.id=`hotel-offer-${index}`;
    const hotel=s.entities.find(e=>e.type==='HotelProperty')!,previous=hotel.id;hotel.id='123';hotel.properties.sourceId='123';hotel.properties.hotelName='海景酒店';s.parameters.hotelId='123';
    for(const relation of s.relationships){if(relation.fromId===previous)relation.fromId='123';if(relation.toId===previous)relation.toId='123';}
    s.option.parametersDigest=digest(s.parameters);s.option.offeredParameters=structuredClone(s.parameters);
  }
  register('H03',h03,{snapshots:[hotelA,hotelB]},(g,a)=>{projectRequest(g,a,h03,now);for(const s of [hotelA,hotelB])if(projectDomainSnapshot(g,a,domainCapabilityId('hotel'),h03,s.parameters,s).state!=='typed_result')throw new Error('Hotel identity fixture invalid');});

  classic('S01',b=>{
    const root=b.objects.find(o=>o.ref.id==='G')!,variant=b.objects.find(o=>o.ref.id==='variant')!;
    root.properties.originalGoal='购买20件黑色256GB全新合成设备，总费用不超过500元。';
    for(const o of b.objects)for(const field of ['offeredQuantity','quantityOrdered','deliveredQuantity']){const value=o.properties[field] as {unit?:string}|undefined;if(value?.unit==='cup')value.unit='piece';}
    for(const c of root.properties.conditions as {expected?:{unit?:string}}[])if(c.expected?.unit==='cup')c.expected.unit='piece';
    variant.properties.name='合成设备';variant.properties.sourceProductRef={namespace:'seller-A',id:'model-123'};variant.properties.specification=[{name:'color',value:'black'},{name:'capacityGB',value:'256'},{name:'condition',value:'new'}];
    const other=structuredClone(variant);other.ref.id='variant-B';other.properties.variantId='variant-B';other.properties.sourceProductRef={namespace:'seller-B',id:'model-123'};other.properties.specification=[{name:'color',value:'black'},{name:'capacityGB',value:'128'},{name:'condition',value:'refurbished'}];b.objects.push(other);
    const offer=b.objects.find(o=>o.ref.id==='offer-G')!,alt=structuredClone(offer);alt.ref.id='offer-B';alt.properties.offerId='offer-B';alt.properties.displayTitle='店B同名商品';b.objects.push(alt);
    for(const l of b.links!.filter(l=>l.from.id==='offer-G'&&l.type!=='ProductOfferEvidence'))b.links!.push({...l,from:alt.ref,to:l.type==='ProductOfferVariant'?other.ref:l.to});
    const receipt=structuredClone(b.objects.find(o=>o.ref.id==='receipt-offer-G')!);receipt.ref.id='receipt-offer-B';receipt.properties.receiptId='receipt-offer-B';receipt.properties.subjects=[{object:alt.ref,digest:'',linksDigest:''}];b.objects.push(receipt);b.links!.push({type:'ProductOfferEvidence',from:alt.ref,to:receipt.ref});
  });
  classic('S02',b=>{
    const offer=b.objects.find(o=>o.ref.id==='offer-G')!,root=b.objects.find(o=>o.ref.id==='G')!;
    root.properties.originalGoal='20件商品配送到指定香港地址，要求总费用不超过500元，需要确认销售、配送和售后责任。';
    offer.properties.pricingCompleteness='partial';offer.properties.pricingTerms={total:{minor:'39000',currency:'CNY'},scope:'partial',components:[]};offer.properties.deliveryDestination={text:'合成香港收货地址',city:'香港'};delete offer.properties.deliveryCommitment;
    b.objects.push(record('Provider','seller',{name:'合成销售商家'}),record('Provider','warehouse',{name:'合成第三方仓库'}));
    for(const [id,provider,role]of[['seller-role','seller','seller'],['warehouse-role','warehouse','fulfiller']]){const p=record('ChannelParticipation',id!,{role,validFrom:at(now,-60),validUntil:at(now,60),verificationRef:`synthetic-role-${id}`});b.objects.push(p);for(const [type,target]of[['ParticipationProvider',{type:'Provider',id:provider!}],['ParticipationChannel',{type:'Channel',id:'channel'}]]as const)b.links!.push({type,from:p.ref,to:target});}
  });

  console.log(JSON.stringify({ preparing: 'S03', source: 'isolated-commerce-runtime' }));
  const commerce=await setupCommerce({databasePath:join(directory,'commerce-source.sqlite'),target:'checkout',cart:true});
  try {const job=await commerce.finish(commerce.submit().id);capture('S03',commerce.store,job,{scenario:'frozen-cart-and-checkout-terms',diagnostics:commerce.diagnostics});}finally{await commerce.close();}
  classic('S04',b=>{
    const a=b.objects.find(o=>o.ref.id==='allocation')!;a.properties.deliveredQuantity={amount:'14',unit:'cup'};
    const wrong=structuredClone(a);wrong.ref.id='wrong-allocation';wrong.properties.allocationId='wrong-allocation';wrong.properties.deliveredQuantity={amount:'1',unit:'cup'};wrong.properties.acceptedSpecificationRef='wrong-specification';wrong.properties.verificationState='rejected';b.objects.push(wrong);
    for(const l of b.links!.filter(l=>l.from.id==='allocation'&&l.type!=='DeliveryAllocationEvidence'))b.links!.push({...l,from:wrong.ref});
    const rec=structuredClone(b.objects.find(o=>o.ref.id==='receipt-allocation')!);rec.ref.id='receipt-wrong-allocation';rec.properties.receiptId='receipt-wrong-allocation';rec.properties.subjects=[{object:wrong.ref,digest:'',linksDigest:''}];b.objects.push(rec);b.links!.push({type:'DeliveryAllocationEvidence',from:wrong.ref,to:rec.ref});
    b.objects.find(o=>o.ref.id==='G')!.properties.originalGoal='20杯指定规格咖啡已分包发货；目前收到15杯，其中1杯规格错误，核对原委托是否完成。';
    const second=record('Shipment','shipment-2',{providerReference:'synthetic-shipment-2',shipmentState:'pending'});
    b.objects.push(second);b.links!.push({type:'ShipmentOrder',from:second.ref,to:{type:'Order',id:'order'}});
    const shipmentReceipt=structuredClone(b.objects.find(o=>o.ref.id==='receipt-shipment')!);shipmentReceipt.ref.id='receipt-shipment-2';shipmentReceipt.properties.receiptId='receipt-shipment-2';shipmentReceipt.properties.subjects=[{object:second.ref,digest:'',linksDigest:''}];b.objects.push(shipmentReceipt);b.links!.push({type:'ShipmentEvidence',from:second.ref,to:shipmentReceipt.ref});
  });
  classic('S05',b=>{
    const payment=b.objects.find(o=>o.ref.id==='payment')!,c=b.objects.find(o=>o.ref.id==='case')!;
    payment.properties.purpose='goods';payment.properties.amount={minor:'48000',currency:'CNY'};c.properties.originalBusinessReference='synthetic-order';
    b.links=b.links!.filter(l=>l.type!=='PaymentReservation'&&l.type!=='CaseReservation');b.links.push({type:'PaymentOrder',from:payment.ref,to:{type:'Order',id:'order'}},{type:'CaseOrder',from:c.ref,to:{type:'Order',id:'order'}});
    b.objects.find(o=>o.ref.id==='G')!.properties.originalGoal='核对错货退货与退款的原订单、原付款、审批、到账和原购买目标。';
  });

  const v01=request('V01','比较现在去车站、明早八点带两箱行李去机场、周末自己开车两天三种需求，找出相应服务和缺少的条件。',now);
  register('V01',v01,{capabilities:summaries},(g,a)=>{projectRequest(g,a,v01,now);projectCapabilityCatalog(g,a,v01.id,summaries);});
  domain('V02','vehicle',(s,r)=>{
    s.parameters.mode='chauffeured';delete s.parameters.driverKey;s.parameters.passengers=4;
    s.parameters.startsAt=`${new Date(now+86400000).toISOString().slice(0,10)}T08:00:00+08:00`;s.parameters.endsAt=new Date(Date.parse(String(s.parameters.startsAt))+3600000).toISOString();
    s.parameters.pickup='合成市机场路同名上车点，具体入口尚待确认';s.parameters.returnLocation='合成机场T2';
    r.mode='chauffeured';delete r.driverKey;r.passengers=4;r.startsAt=s.parameters.startsAt;r.endsAt=s.parameters.endsAt;r.pickup=s.parameters.pickup;r.returnLocation=s.parameters.returnLocation;
    const v=s.entities.find(e=>e.type==='VehicleClass')!;delete v.properties.passengerCapacity;
  },'明早八点四位乘客和两个大箱子去合成机场T2；上车点有两个同名入口，用户尚未选择。当前来源只称舒适型，容量尚未核实。');
  domain('V03','ride',(_s,r)=>{r.state='accepted';delete r.pickedUpAt;delete r.arrivedAt;},'要求把两位乘客按原路线送达目的地并核对最终费用，平台目前只报告已接单。');
  domain('V04','vehicle',(s,r)=>{s.parameters.mode='chauffeured';delete s.parameters.driverKey;r.mode='chauffeured';delete r.driverKey;r.state='pending';delete r.confirmedAt;delete r.confirmationCode;},'原预约接送改到后天并改变目的地；供应商另报价加50元，用户未批准新费用。用户申请取消原单但来源仍待确认，需决定是否可以另订。');
  domain('V05','vehicle',(s,r)=>{
    s.parameters.endpoint='completed';s.parameters.startsAt=at(now,-180);s.parameters.endsAt=at(now,30);
    r.startsAt=s.parameters.startsAt;r.endsAt=s.parameters.endsAt;r.confirmedAt=at(now,-200);r.state='returned';r.pickedUpAt=at(now,-150);r.returnedAt=at(now,-10);r.returnAccepted=false;r.depositState='disputed';
    Object.assign(s.entities.find(e=>e.type==='VehicleInspection')!.properties,{stage:'return',occurredAt:at(now,-10),accepted:false,damageReportRef:'synthetic-unresolved-return-dispute'});
  },'自驾租车要求完成取车、用车、归还和押金结清；车辆已归还，但验车争议尚未解决，押金未结清。');

  for(const id of architectureQuestionIds)if(!datasets.has(id)||!questions.has(id))throw new Error(`Missing architecture case ${id}`);
  writeFileSync(join(directory,'reference-facts.json'),JSON.stringify({model:businessModel.ref,asOf:at(now),facts},null,2),{mode:0o600});
  for(const filename of ['booking-source.sqlite','ride-source.sqlite','hotel-source.sqlite','commerce-source.sqlite'])for(const suffix of ['', '-wal','-shm'])rmSync(join(directory,filename+suffix),{force:true});
  return architectureQuestionIds.map(id=>datasets.get(id)!);
}
