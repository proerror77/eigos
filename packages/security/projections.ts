import {z} from 'zod';
import type {PropertyDefinition} from '../ontology/model.js';
import {didiDataSchema,didiPlaceSchema} from '../capabilities/didi/contracts.js';
import {catalogObservationSchema} from '../ontology/catalog-agent.js';
import {meituanSafeDataSchema} from '../ontology/meituan-read.js';
import {publicGeoQuerySchema} from '../capabilities/paotui-contracts.js';
import {meituanDeliveryInputSchema} from '../capabilities/meituan-address-selection.js';
import {commerceEntitySchemas} from '../ontology/commerce-journey.js';
import {bookingEntitySchemas,bookingDataSchema} from '../ontology/booking.js';
import {registrationEntities,registrationOfferSchema,registrationRecordSchema} from '../ontology/free-booking.js';
import {ruleSetSchema,regulatoryReferenceSchema} from '../ontology/customs-policy.js';
import type {SecurityEnvelope} from './envelope.js';

type Projection={schema:z.ZodType;inputs:string[];markings:SecurityEnvelope['requiredMarkings'];responseOnly?:boolean;value:(properties:Record<string,unknown>)=>unknown};
const registry:Record<string,Record<string,Projection>>={};
const time=z.iso.datetime({offset:true});
export const didiBusinessViewSchema=z.strictObject({data:didiDataSchema,route:z.strictObject({origin:didiPlaceSchema,destination:didiPlaceSchema}).optional(),observedAt:time,expiresAt:time,evidenceKind:z.enum(['live_readonly','provider_mock','fixture']),noBusinessWrites:z.literal(true)});
const pick=(value:unknown,keys:readonly string[])=>Object.fromEntries(keys.filter(k=>value && typeof value==='object' && Object.hasOwn(value,k)).map(k=>[k,(value as Record<string,unknown>)[k]]));
const add=(types:string[],field:string,projection:Projection)=>{for(const type of types)(registry[type]??={})[field]=projection;};
const snapshotPaths=['data','route','observedAt','expiresAt','evidenceKind','noBusinessWrites'];
add(['DidiPlaceObservation','RideEstimateObservation'],'observedData',{schema:didiBusinessViewSchema,inputs:['snapshot'],markings:['precise_location','financial'],value:p=>didiBusinessViewSchema.parse(pick(p.snapshot,snapshotPaths))});
const catalogView=catalogObservationSchema.pick({action:true,merchant:true,country:true,items:true,observedAt:true,expiresAt:true,evidenceKind:true,completeness:true,stockQuantity:true,deliveryCommitment:true,partnerTrust:true,noBusinessWrites:true});
add(['CatalogObservation','CatalogEndpoint'],'observedData',{schema:catalogView,inputs:['snapshot'],markings:['financial'],value:p=>catalogView.parse(pick(p.snapshot,Object.keys(catalogView.shape)))});
const meituanView=z.strictObject({data:meituanSafeDataSchema,observedAt:time,expiresAt:time,noBusinessWrites:z.literal(true)});
add(['MeituanReadObservation'],'observedData',{schema:meituanView,inputs:['snapshot'],markings:['precise_location','account_private'],value:p=>meituanView.parse(pick(p.snapshot,Object.keys(meituanView.shape)))});
const meituanInput=z.discriminatedUnion('mode',[
  z.strictObject({mode:z.literal('geo'),...publicGeoQuerySchema.shape}),z.strictObject({mode:z.literal('addresses')}),z.strictObject({mode:z.literal('delivery'),...meituanDeliveryInputSchema.shape}),
]);
add(['MeituanReadTask'],'authorizedInput',{schema:meituanInput,inputs:['input'],markings:['precise_location','account_private'],value:p=>meituanInput.parse(p.input)});
export const addressBookViewSchema=z.strictObject({addresses:z.array(z.strictObject({addressId:z.string().min(1).max(200),address:z.string().min(1).max(500),houseNumber:z.string().max(200).optional(),name:z.string().max(200).optional(),tag:z.string().max(200).optional(),cityId:z.string().min(1).max(100)})).max(100)});
add(['MeituanReadObservation'],'addressBook',{schema:addressBookViewSchema,inputs:['snapshot'],markings:['precise_location','account_private'],responseOnly:true,value:()=>undefined});
for(const [type,schema] of [['CustomsRuleSet',ruleSetSchema],['RegulatoryReference',regulatoryReferenceSchema]] as const)
  add([type],'observedData',{schema,inputs:['snapshot'],markings:[],value:p=>schema.parse(p.snapshot)});
const area=z.strictObject({countryCode:z.string().regex(/^[A-Z]{2}$/),region:z.string().optional(),city:z.string().optional(),postalCode:z.string().optional()});
const contextView=commerceEntitySchemas.FulfillmentContext.extend({addresses:z.array(commerceEntitySchemas.FulfillmentContext.shape.addresses.element.extend({address:area})).max(8)});
const fulfillmentView=commerceEntitySchemas.FulfillmentPlan.extend({destination:area});
const areaValue=(value:unknown)=>area.parse(pick(value,Object.keys(area.shape)));
for(const [type,schema] of Object.entries(commerceEntitySchemas)) {
  const view=type==='FulfillmentContext'?contextView:type==='FulfillmentPlan'?fulfillmentView:schema;
  add([type],'observedData',{schema:view,inputs:['data','snapshot'],markings:['financial','account_private'],value:p=>{
    const data=schema.parse(p.data) as Record<string,unknown>;
    if(type==='FulfillmentContext')return contextView.parse({...data,addresses:(data.addresses as Record<string,unknown>[]).map(a=>({...a,address:areaValue(a.address)}))});
    if(type==='FulfillmentPlan')return fulfillmentView.parse({...data,destination:areaValue(data.destination)});
    return data;
  }});
}
const bookingView=bookingDataSchema.omit({paymentHandler:true,checkout:true});
for(const [type,schema] of Object.entries(bookingEntitySchemas)) {
  const view=type==='BookingObservation'?bookingView:schema;
  add([type],'observedData',{schema:view,inputs:['data','snapshot'],markings:['financial','account_private'],value:p=>{const data=schema.parse(p.data);return type==='BookingObservation'?bookingView.parse(pick(data,Object.keys(bookingView.shape))):data;}});
}
const offerView=registrationOfferSchema.omit({attendeeRef:true}),recordView=registrationRecordSchema.omit({attendeeRef:true,confirmationReference:true});
for(const [type,schema] of Object.entries(registrationEntities)) {
  const view=type==='RegistrationOffer'?offerView:recordView;
  add([type],'observedData',{schema:view,inputs:['data','snapshot'],markings:['account_private'],value:p=>view.parse(pick(schema.parse(p.data),Object.keys(view.shape)))});
}
export const projectionContract={version:'eigos.authorized-projections.v2',fields:Object.fromEntries(Object.entries(registry).map(([type,fields])=>[type,Object.fromEntries(Object.entries(fields).map(([field,p])=>[field,{schema:z.toJSONSchema(p.schema),inputs:p.inputs,markings:p.markings,responseOnly:!!p.responseOnly}]))]))};
export function projectionFields(type:string):Record<string,PropertyDefinition> {
  return Object.fromEntries(Object.entries(registry[type]??{}).map(([field,p])=>[field,{kind:'struct',schema:p.schema,description:p.responseOnly?'本人地址列表（不含电话）；只向获准 PA 交付，不提供给 Worker 模型':'经过固定字段投影的任务业务数据；不含原始凭据、运输回执或内部执行记录',source:projectionContract.version,required:!p.responseOnly}]));
}
export const projectionInputs=(type:string,field:string)=>registry[type]?.[field]?.inputs??[];
export const projectionMarkings=(type:string,field:string)=>registry[type]?.[field]?.markings??[];
export const responseOnlyProjection=(type:string,field:string)=>!!registry[type]?.[field]?.responseOnly;
export function projectedValue(type:string,field:string,properties:Record<string,unknown>):unknown {
  const projection=registry[type]?.[field];if(!projection)return properties[field];
  if(Object.hasOwn(properties,field))return projection.schema.parse(properties[field]);
  return projection.inputs.some(input=>Object.hasOwn(properties,input))?projection.value(properties):undefined;
}
export function integrityField(type:string,field:string,allowed:string[]):boolean {
  if(['configurationDigest','allowedActions','bindingDigest'].includes(field))return true;
  if(type==='SourceReceipt')return ['sourceIdentity','sourceEventId','contentDigest','subjects'].includes(field);
  return allowed.includes('observedData') && !!registry[type]?.observedData && ['snapshot','data'].includes(field) || type==='MeituanReadTask' && field==='input' && allowed.includes('authorizedInput');
}
export const integrityFunctions=new Set(['rideEstimateStatus','selectDidiPlace','catalogObservationStatus','meituanReadStatus','registrationStatus','bookingObservationStatus','commerceObservationStatus','commerceJourneyStatus','shippingGateStatus','customsGateStatus']);
/** Registered status functions may validate private source records internally;
 * their returned data uses the same field projection as ordinary queries. */
export function projectFunctionValue(functionId:string,type:string,value:unknown):unknown {
  if(!['registrationStatus','bookingObservationStatus','commerceObservationStatus'].includes(functionId) || !value || typeof value!=='object')return value;
  const result=value as Record<string,unknown>;if(!result.data || !registry[type]?.observedData)return value;
  return {...result,data:registry[type]!.observedData!.value({data:result.data})};
}
