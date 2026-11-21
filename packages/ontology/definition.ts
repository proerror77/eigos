import { scheduleJourneyDefinition } from './schedule-journey.js';
import { itineraryDefinition, itineraryType } from './itinerary-continuity.js';
import { executeHotelDependentTrip, hotelDependencyCriterion, tripHotelDependencyDefinition } from './trip-hotel-dependency.js';
import { travelHandoffDefinition } from './travel-handoff.js';
import { calendarJourneyDefinition as journey, journeyType } from './calendar-journey.js';
import { hotelTransferDefinition } from './hotel-transfer-decisions.js';
import { documentDefinition as documents } from './documents.js';
import { flightPositionFunction } from './flight-position.js';
import { flightDefinition as flight, flightWatchType } from './flight.js';
import { z } from 'zod';
import { mapFunctions, pickupCoordinateEvidence } from './maps.js';
import { locationFunctions, taskLocationValueType } from './location.js';
import { luckinDefinition as luckin } from './luckin.js';
import { deliveryFunctions } from './delivery.js';
import {localEmbeddingDefinition} from './embedding-definition.js';
import { applicationDefinition as applications, geometryUploadCriterion } from './applications.js';
import {scenarioObjectType} from './scenario-definition.js';
import { rideWatchDefinition, rideWatchType } from './ride-watch.js';
import { petRideDefinition, petRideType } from './pet-ride.js';
import { addProcessLogs } from './process-definition.js';
import { readFileSync } from 'node:fs';
import type { OntologyDocument } from './schema.js';
import { fliggyServicesDefinition as fliggy, marketplaceDefinition as marketplace, servicesDefinition as services } from './services.js';
import { fliggyFlightBookingDefinition } from './fliggy-flight-booking.js';
import { fliggyHotelDefinition } from './fliggy-hotel.js';
import { didiImmediateRideDefinition } from './didi-immediate-ride.js';
import { didiReadDefinitions } from './didi-reads.js';
import { didiOrderDefinitions, travelDefinition as travel } from './travel.js';
import { paymentsDefinition as payments } from './payments.js';
import { diningEvidence, diningResearchFunctions } from './dining.js';
import { dianpingResearchFunctions } from './dianping.js';
import { diningReservations, diningReservationType } from './dining-reservations.js';
import { diningActivityInputSchema, jsonSchema, recommendScheduleSchema, scheduleRecommendationSchema, stageScheduleSchema } from '../capabilities/scheduling/contracts.js';
import { objectRefSchema } from './schema.js';
import { businessAgentProfiles } from './agent-profiles.js';

const ride = JSON.parse(readFileSync(new URL('./definitions/ride.json', import.meta.url), 'utf8')) as OntologyDocument;
const scheduling = JSON.parse(readFileSync(new URL('./definitions/scheduling.json', import.meta.url), 'utf8')) as OntologyDocument;
const diningActivityFunction: OntologyDocument['functionTypes'][number] = {
  apiName: 'stageDiningActivity', description: 'Stage a meal using the original task’s current dining availability evidence.',
  parameters: jsonSchema(diningActivityInputSchema), returns: jsonSchema(objectRefSchema), edits: true,
  dependencies: { objectTypes: ['SchedulePlan', 'ScheduledActivity', 'CalendarAvailability', 'ScheduleResource'],
    linkTypes: ['ActivityPlan', 'ActivityResource', 'ActivityDependency', 'PlanResource', 'PlanAvailability', 'ResourceAvailability'],
    functions: ['readDiningAvailability'] },
};
/** Domain packages compose into one published authority, never independent task stores. */
export const businessDefinition: OntologyDocument = {
  id: ride.id, version: '44',
  agentProfiles: businessAgentProfiles,
  objectTypes: [...ride.objectTypes, ...scheduling.objectTypes, ...services.objectTypes, ...travel.objectTypes, ...journey.objectTypes, ...flight.objectTypes, ...payments.objectTypes,...luckin.objectTypes,...applications.objectTypes,...documents.objectTypes,scenarioObjectType], interfaceTypes: [...ride.interfaceTypes, ...scheduling.interfaceTypes, ...services.interfaceTypes, ...travel.interfaceTypes, ...payments.interfaceTypes],
  linkTypes: [...ride.linkTypes, ...scheduling.linkTypes, ...services.linkTypes, ...travel.linkTypes, ...journey.linkTypes, ...flight.linkTypes, ...payments.linkTypes,...applications.linkTypes,...documents.linkTypes], functionTypes: [...ride.functionTypes, ...scheduling.functionTypes, ...services.functionTypes, ...travel.functionTypes, ...journey.functionTypes, ...flight.functionTypes,flightPositionFunction, ...payments.functionTypes,...deliveryFunctions,...locationFunctions,...mapFunctions,...luckin.functionTypes,...applications.functionTypes,...documents.functionTypes,localEmbeddingDefinition],
  actionTypes: [...ride.actionTypes, ...scheduling.actionTypes, ...services.actionTypes, ...travel.actionTypes, ...journey.actionTypes, ...flight.actionTypes, ...payments.actionTypes,...luckin.actionTypes,...applications.actionTypes,...documents.actionTypes], dataSources: [...ride.dataSources, ...scheduling.dataSources, ...services.dataSources],
};
businessDefinition.linkTypes.push(...scheduleJourneyDefinition.linkTypes);
businessDefinition.functionTypes.push(...scheduleJourneyDefinition.functionTypes);
businessDefinition.actionTypes.push(...scheduleJourneyDefinition.actionTypes);
businessDefinition.objectTypes.push(...itineraryDefinition.objectTypes);
businessDefinition.linkTypes.push(...itineraryDefinition.linkTypes);
businessDefinition.functionTypes.push(...itineraryDefinition.functionTypes);
businessDefinition.actionTypes.push(...itineraryDefinition.actionTypes);
businessDefinition.functionTypes.push(
  {apiName:'recommendSchedule',description:'Search jointly for feasible activity times across the plan resources and dependencies.',
    parameters:jsonSchema(recommendScheduleSchema),returns:jsonSchema(scheduleRecommendationSchema)},
  {apiName:'stageScheduleRecommendation',description:'Stage a validated schedule adjustment in a Scenario.',
    parameters:jsonSchema(stageScheduleSchema),returns:jsonSchema(objectRefSchema),edits:true},
);
businessDefinition.actionTypes.push({apiName:'StageScheduleRecommendation',description:'Propose a schedule adjustment using current activity revisions and constraints.',
  parameters:jsonSchema(stageScheduleSchema),objectParameters:{plan:'SchedulePlan'},submissionCriteria:[],function:'stageScheduleRecommendation'});
businessDefinition.objectTypes.push(...fliggy.objectTypes);
businessDefinition.interfaceTypes.push(...fliggy.interfaceTypes);
businessDefinition.linkTypes.push(...fliggy.linkTypes);
businessDefinition.functionTypes.push(...fliggy.functionTypes);
businessDefinition.actionTypes.push(...fliggy.actionTypes);
businessDefinition.dataSources.push(...fliggy.dataSources);
businessDefinition.objectTypes.push(...marketplace.objectTypes);
businessDefinition.interfaceTypes.push(...marketplace.interfaceTypes);
businessDefinition.linkTypes.push(...marketplace.linkTypes);
businessDefinition.functionTypes.push(...marketplace.functionTypes);
businessDefinition.actionTypes.push(...marketplace.actionTypes);
businessDefinition.dataSources.push(...marketplace.dataSources);
businessDefinition.objectTypes.push(...travelHandoffDefinition.objectTypes);
businessDefinition.interfaceTypes.push(...travelHandoffDefinition.interfaceTypes);
businessDefinition.linkTypes.push(...travelHandoffDefinition.linkTypes);
businessDefinition.functionTypes.push(...travelHandoffDefinition.functionTypes);
businessDefinition.actionTypes.push(...travelHandoffDefinition.actionTypes);
businessDefinition.objectTypes.push(...fliggyHotelDefinition.objectTypes);
businessDefinition.functionTypes.push(...fliggyHotelDefinition.functionTypes);
businessDefinition.actionTypes.push(...fliggyHotelDefinition.actionTypes);
businessDefinition.objectTypes.push(...tripHotelDependencyDefinition.objectTypes);
businessDefinition.linkTypes.push(...tripHotelDependencyDefinition.linkTypes);
businessDefinition.functionTypes.push(...tripHotelDependencyDefinition.functionTypes);
businessDefinition.actionTypes.push(...tripHotelDependencyDefinition.actionTypes);
businessDefinition.actionTypes.find(action => action.apiName === 'AuthorizeEventTrip')!.submissionCriteria.push(hotelDependencyCriterion);
// Preserve the stored contract of ordinary timed rides planned before this publication.
const executeEventTrip = businessDefinition.actionTypes.find(action => action.apiName === 'ExecuteEventTrip')!;
businessDefinition.actionTypes.push({
  ...executeEventTrip,
  apiName: executeHotelDependentTrip,
  description: 'Execute a timed trip only while its original hotel dependency is current.',
  submissionCriteria: [hotelDependencyCriterion],
});
businessDefinition.objectTypes.push(...fliggyFlightBookingDefinition.objectTypes);
businessDefinition.functionTypes.push(...fliggyFlightBookingDefinition.functionTypes);
businessDefinition.actionTypes.push(...fliggyFlightBookingDefinition.actionTypes);
businessDefinition.functionTypes.push(diningActivityFunction, ...diningResearchFunctions, ...dianpingResearchFunctions);
businessDefinition.objectTypes.push(...diningReservations.objectTypes);
businessDefinition.functionTypes.push(...diningReservations.functionTypes);
businessDefinition.actionTypes.push(...diningReservations.actionTypes);
businessDefinition.objectTypes.push(...petRideDefinition.objectTypes);
businessDefinition.interfaceTypes.push(...petRideDefinition.interfaceTypes);
businessDefinition.functionTypes.push(...petRideDefinition.functionTypes);
businessDefinition.actionTypes.push(...petRideDefinition.actionTypes);
businessDefinition.actionTypes.push({
  apiName: 'StageDiningActivity', description: 'Propose an internal meal activity with current PA evidence. Make no restaurant reservation.',
  parameters: diningActivityFunction.parameters, objectParameters: { plan: 'SchedulePlan' },
  submissionCriteria: [], function: diningActivityFunction.apiName,
});
businessDefinition.objectTypes.find(type => type.apiName === 'ScheduledActivity')!.properties.dining = {
  description: 'Verified planning evidence from the original PA for a specified dish and meal window', required: false,
  schema: jsonSchema(diningEvidence),
};


// The bundled domains use the same reusable contracts consumed by the editor and runtime.
businessDefinition.sharedProperties=[{apiName:'BusinessName',description:'Human-readable business name',schema:{type:'string'},required:false}];
businessDefinition.valueTypes=[{apiName:'Timestamp',version:'1',description:'An ISO date-time instant',schema:{type:'string',format:'date-time'}},taskLocationValueType];
const coordinates=ride.objectTypes.find(type=>type.apiName==='Place')!.properties.coordinates!.schema;
businessDefinition.structTypes=[{apiName:'Coordinates',description:'Provider coordinates with an explicit coordinate-system declaration on the object',fields:coordinates.properties as Record<string,Record<string,unknown>>,required:['lat','lng']}];
for(const type of [...businessDefinition.objectTypes,...businessDefinition.interfaceTypes]){
  if(type.properties.name)type.properties.name={...type.properties.name,sharedProperty:'BusinessName'};
  for(const property of Object.values(type.properties))if(property.schema.format==='date-time')property.valueType={name:'Timestamp',version:'1'};
}
businessDefinition.objectTypes.find(type=>type.apiName==='Place')!.properties.coordinates!.struct={type:'Coordinates'};
businessDefinition.objectTypes.find(type=>type.apiName==='RideRequest')!.properties.estimateCount={description:'Number of currently visible linked estimates',schema:{type:'integer',minimum:0},required:false,derived:{op:'linked',path:[{link:'estimates'}],aggregate:'count'}};
businessDefinition.typeGroups=[
  {apiName:'Travel',displayName:'出行',description:'Places, routes and source-backed price estimates',objectTypes:[...ride.objectTypes.map(type=>type.apiName),petRideType]},
  {apiName:'Scheduling',displayName:'排程',description:'Resources, calendar availability and schedule plans',objectTypes:scheduling.objectTypes.map(type=>type.apiName)},
  {apiName:'Services',displayName:'服务',description:'Provider-neutral service offerings',objectTypes:[...services.objectTypes,...luckin.objectTypes,...fliggy.objectTypes,...marketplace.objectTypes,...travelHandoffDefinition.objectTypes,...fliggyHotelDefinition.objectTypes,...fliggyFlightBookingDefinition.objectTypes,...diningReservations.objectTypes].map(type=>type.apiName)},
  {apiName:'TimedTravel',displayName:'定时出行',description:'Authorized event and travel planning',objectTypes:[...travel.objectTypes,...journey.objectTypes,...flight.objectTypes].map(type=>type.apiName)},
  {apiName:'Payments',displayName:'付款',description:'Merchant order handoff and independently read payment status',objectTypes:payments.objectTypes.map(type=>type.apiName)},
  {apiName:'Models',displayName:'三维模型',description:'Model assets and annotations',objectTypes:applications.objectTypes.map(type=>type.apiName)},
  {apiName:'Documents',displayName:'业务文档',description:'Versioned documents linked to business objects',objectTypes:documents.objectTypes.map(type=>type.apiName)},
  {apiName:'Scenarios',displayName:'方案',description:'Persisted scenario metadata',objectTypes:['OntologyScenario']},
];
for(const group of businessDefinition.typeGroups)for(const name of group.objectTypes){const type=businessDefinition.objectTypes.find(type=>type.apiName===name)!;type.groups=[group.apiName];type.status='active';}

for(const fn of businessDefinition.functionTypes){
  if(fn.apiName==='embedTextLocal' || fn.apiName===geometryUploadCriterion){fn.dependencies={};continue;}
  if(travelHandoffDefinition.functionTypes.includes(fn))continue;
  if(documents.functionTypes.includes(fn)||fliggy.functionTypes.includes(fn)||marketplace.functionTypes.includes(fn)||fliggyHotelDefinition.functionTypes.includes(fn)||fliggyFlightBookingDefinition.functionTypes.includes(fn)||diningResearchFunctions.includes(fn)||dianpingResearchFunctions.includes(fn)||diningReservations.functionTypes.includes(fn)||petRideDefinition.functionTypes.includes(fn)||fn===diningActivityFunction)continue;
  if(fn === flightPositionFunction || journey.functionTypes.includes(fn) || flight.functionTypes.includes(fn) || payments.functionTypes.includes(fn) || deliveryFunctions.includes(fn) || locationFunctions.includes(fn) || mapFunctions.includes(fn) || luckin.functionTypes.includes(fn))continue;
  if(ride.functionTypes.some(item=>item.apiName===fn.apiName)){
    fn.dependencies={objectTypes:ride.objectTypes.map(type=>type.apiName),interfaceTypes:ride.interfaceTypes.map(type=>type.apiName),linkTypes:ride.linkTypes.map(link=>link.apiName),dataSources:ride.dataSources.map(source=>source.apiName),functions:ride.functionTypes.filter(item=>item.apiName!==fn.apiName).map(item=>item.apiName)};
  }else if([scheduling,services,travel].some(domain=>domain.functionTypes.some(item=>item.apiName===fn.apiName))){
    const domains=[ride,scheduling,services,travel];
    fn.dependencies={objectTypes:domains.flatMap(domain=>domain.objectTypes.map(type=>type.apiName)),interfaceTypes:domains.flatMap(domain=>domain.interfaceTypes.map(type=>type.apiName)),linkTypes:domains.flatMap(domain=>domain.linkTypes.map(link=>link.apiName)),dataSources:domains.flatMap(domain=>domain.dataSources.map(source=>source.apiName)),functions:domains.flatMap(domain=>domain.functionTypes.filter(item=>item.apiName!==fn.apiName).map(item=>item.apiName))};
  }else{
    fn.dependencies={objectTypes:applications.objectTypes.map(type=>type.apiName),linkTypes:applications.linkTypes.map(link=>link.apiName)};
  }
}
// These Functions declare their own dependencies so historical workflow bindings stay compatible.
businessDefinition.objectTypes.push(...hotelTransferDefinition.objectTypes);
businessDefinition.linkTypes.push(...hotelTransferDefinition.linkTypes);
businessDefinition.functionTypes.push(...hotelTransferDefinition.functionTypes);
businessDefinition.actionTypes.push(...hotelTransferDefinition.actionTypes);
businessDefinition.dataSources.push(...hotelTransferDefinition.dataSources);
businessDefinition.functionTypes.push(...didiOrderDefinitions.functionTypes, ...didiReadDefinitions);
businessDefinition.actionTypes.push(...didiOrderDefinitions.actionTypes);
businessDefinition.interfaceTypes.push(...didiOrderDefinitions.interfaceTypes);
businessDefinition.objectTypes.find(type=>type.apiName==='LumaEvent')!.interfaces.AttendableEvent={properties:Object.fromEntries(['name','start','end','timeZone','status','locationPrecision','registrationOpen','approvalRequired'].map(name=>[name,name])),links:{registrations:'registrations',trips:'trips'},actions:{register:{action:'PrepareEventRegistration',parameters:{event:'event',ticketId:'ticketId',sourceTaskId:'sourceTaskId'}}}};

// Keep the existing published contract for historical workflows and callers with complete inputs.
const completeRideFunction = businessDefinition.functionTypes.find(fn => fn.apiName === 'prepareRideInquiry')!;
const drivingEstimate = jsonSchema(z.strictObject({
  distanceMeters: z.number().int().nonnegative(), durationSeconds: z.number().int().positive(),
  bindingId: z.string(), authorityId: z.string(), receiptDigest: z.string(),
  observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  evidence: z.enum(['live_readonly', 'provider_mock', 'synthetic']),
}).nullable());
const routeEvidence = {
  pickup: jsonSchema(pickupCoordinateEvidence),
  drivingEstimate,
};
const routeType = businessDefinition.objectTypes.find(type => type.apiName === 'Route')!;
for (const [name, schema] of Object.entries(routeEvidence)) {
  routeType.properties[name] = { description: name === 'pickup' ? 'PA pickup coordinate system and conversion evidence'
    : 'DiDi driving estimate, or null when the source did not provide one', schema, required: false };
}
const interactiveRideResult = structuredClone(businessDefinition.functionTypes.find(fn => fn.apiName === 'readRideEstimates')!);
interactiveRideResult.apiName = 'readInteractiveRideEstimate';
interactiveRideResult.description = 'Return the fare, pickup coordinate evidence, and driving estimate of the original interactive RideRequest.';
const resultRoute = (interactiveRideResult.returns.properties as Record<string, {properties: Record<string, unknown>}>).route!;
Object.assign(resultRoute.properties, routeEvidence);
businessDefinition.functionTypes.push(interactiveRideResult);
const landmark = { type: 'string', minLength: 3, maxLength: 200, description: 'Named nearby landmark supplied by the user' };
const quoteParameters = {
  ...completeRideFunction.parameters,
  properties: { ...completeRideFunction.parameters.properties as Record<string, unknown>,
    originLandmark: landmark, destinationLandmark: landmark },
  required: [],
};
const prepareWithClues = {
  ...completeRideFunction, apiName: 'prepareRideInquiryWithPlaceClues', parameters: quoteParameters,
  dependencies: { ...completeRideFunction.dependencies,
    functions: [...completeRideFunction.dependencies!.functions!, 'resolveRidePickup'] },
  description: 'Prepare a ride estimate using an explicit pickup or the original PA’s current phone location. Prompt for a missing destination on the original task.',
};
businessDefinition.functionTypes.push(prepareWithClues);
const completeQuote = businessDefinition.actionTypes.find(action => action.apiName === 'EstimateRide')!;
const quoteWithClues = {
  ...completeQuote, apiName: 'EstimateRideWithPlaceClues', parameters: quoteParameters, function: prepareWithClues.apiName,
  description: 'Check the driving route and fare. Use a named pickup if the user supplied one. Omit origin to request current device location from the original PA and verify GCJ-02. If the user did not specify a destination, omit it and let the Action ask. Supply named landmarks separately.',
};
businessDefinition.actionTypes.push(quoteWithClues);
const completeInquiry = businessDefinition.interfaceTypes.find(type => type.apiName === 'RideInquiry')!;
const clueInquiry = structuredClone(completeInquiry);
clueInquiry.apiName = 'RideInquiryWithPlaceClues';
clueInquiry.description = quoteWithClues.description;
clueInquiry.actions.estimate!.parameters = quoteParameters;
businessDefinition.interfaceTypes.push(clueInquiry);
const immediateRide = didiImmediateRideDefinition(quoteParameters);
businessDefinition.objectTypes.push(...immediateRide.objectTypes);
businessDefinition.interfaceTypes.push(...immediateRide.interfaceTypes);
businessDefinition.linkTypes.push(...immediateRide.linkTypes);
businessDefinition.functionTypes.push(...immediateRide.functionTypes);
businessDefinition.actionTypes.push(...immediateRide.actionTypes);
const inquiryMappings = businessDefinition.objectTypes.find(type => type.apiName === 'RideRequest')!.interfaces;
const clueMapping = structuredClone(inquiryMappings.RideInquiry!);
clueMapping.actions.estimate!.action = quoteWithClues.apiName;
Object.assign(clueMapping.actions.estimate!.parameters, { originLandmark: 'originLandmark', destinationLandmark: 'destinationLandmark' });
inquiryMappings[clueInquiry.apiName] = clueMapping;

businessDefinition.objectTypes.find(type => type.apiName === 'SchedulePlan')!.properties.state = {
  description: 'Internal plan review state; confirmation does not write an external calendar',
  schema: { type: 'string', enum: ['prepared', 'confirmed'] }, required: false,
};
businessDefinition.objectTypes.push({
  apiName: 'ActionConfirmation', displayName: 'Action confirmation',
  description: 'Human input required to continue an original Ontology Action invocation',
  primaryKey: 'id', titleProperty: 'name', interfaces: {},
  properties: {
    id: { description: 'Original Action request ID', schema: { type: 'string' }, required: true },
    name: { description: 'Action awaiting human input', schema: { type: 'string' }, required: true },
    taskId: { description: 'Original EIGOS task', schema: { type: 'string', format: 'uuid' }, required: true },
    state: { description: 'Confirmation process state', schema: {
      type: 'string', enum: ['awaiting-input', 'confirmed', 'completed', 'canceled', 'failed'],
    }, required: true },
  },
});
businessDefinition.objectTypes.push(...rideWatchDefinition.objectTypes);
businessDefinition.linkTypes.push(...rideWatchDefinition.linkTypes);
businessDefinition.functionTypes.push(...rideWatchDefinition.functionTypes);
businessDefinition.actionTypes.push(...rideWatchDefinition.actionTypes);
addProcessLogs(businessDefinition, [
  { type: itineraryType, property: 'state' },
  { type: rideWatchType, property: 'state' },
  { type: 'FliggyHotelBooking', property: 'state' },
  { type: 'FliggyFlightBooking', property: 'issuanceState' },
  { type: petRideType, property: 'state' },
  { type: 'ActionConfirmation', property: 'state' },
  { type: 'EventRegistration', property: 'state' }, { type: 'EventTrip', property: 'state' },
  { type: 'StripeLinkPaymentRequest', property: 'status' }, { type: 'SchedulePlan', property: 'state' }, { type: journeyType, property: 'state' }, { type: flightWatchType, property: 'state' },
  { type: diningReservationType, property: 'state' },
]);

businessDefinition.objectTypes.find(type => type.apiName === 'ItineraryContinuityStateLog')!.machinery = {
  states: [{ name: 'watching' }, { name: 'attention' }, { name: 'expired', terminal: true }, { name: 'stopped', terminal: true }],
  transitions: [
    { from: null, to: 'watching', action: 'StartItineraryContinuity' },
    { from: 'watching', to: 'attention', action: 'CheckItineraryContinuity' },
    { from: 'attention', to: 'watching' },
    ...['watching', 'attention'].flatMap(from => [
      { from, to: 'expired', action: 'CheckItineraryContinuity' },
      { from, to: 'stopped', action: 'StopItineraryContinuity' },
    ]),
  ],
  subprocesses: [
    { link: 'flightBooking', process: 'FliggyFlightBookingIssuanceStateLog' },
    { link: 'hotelBooking', process: 'FliggyHotelBookingStateLog' },
  ],
};
businessDefinition.objectTypes.find(type => type.apiName === 'EventTripStateLog')!.machinery = {
  states: [
    { name: 'proposed' }, { name: 'authorized' },
    { name: 'dispatched', terminal: true }, { name: 'canceled', terminal: true },
  ],
  transitions: [
    { from: null, to: 'proposed', action: 'CommitSchedulePlan' },
    { from: 'proposed', to: 'authorized', action: 'AuthorizeEventTrip' },
    { from: 'authorized', to: 'dispatched', action: 'ExecuteEventTrip' },
    { from: 'authorized', to: 'canceled', action: 'CancelEventTrip' },
    { from: 'authorized', to: 'proposed', action: 'ReviewTripHotelDependency' },
  ],
  subprocesses: [
    { link: 'plan', process: 'SchedulePlanStateLog' },
    { link: 'registration', process: 'EventRegistrationStateLog' },
  ],
};

// Reference paths describe expected observations. Supplier status and independent readbacks
// determine the recorded state; a graph edge does not authorize a supplier mutation.
businessDefinition.objectTypes.find(type => type.apiName === 'FliggyHotelBookingStateLog')!.machinery = {
  states: [
    { name: 'previewed' }, { name: 'awaiting_payment' }, { name: 'pending_confirmation' },
    { name: 'confirmed' }, { name: 'completed', terminal: true }, { name: 'refund_pending' },
    { name: 'refund_rejected' }, { name: 'closed', terminal: true }, { name: 'cancelled', terminal: true },
    { name: 'unknown' },
  ],
  transitions: [
    { from: null, to: 'previewed', action: 'PrepareFliggyHotelBooking' },
    { from: 'previewed', to: 'awaiting_payment', action: 'CreateFliggyHotelBooking' },
    { from: 'awaiting_payment', to: 'pending_confirmation', action: 'ConfirmFliggyHotelPayment' },
    { from: 'pending_confirmation', to: 'confirmed' }, { from: 'confirmed', to: 'completed' },
    ...['awaiting_payment','pending_confirmation','confirmed'].flatMap(from =>
      ['refund_pending','cancelled','closed'].map(to => ({from,to,action:'CancelFliggyHotelBooking'}))),
    ...['cancelled','closed','refund_rejected'].map(to => ({from:'refund_pending',to})),
  ],
};

businessDefinition.objectTypes.find(type => type.apiName === 'FliggyFlightBookingIssuanceStateLog')!.machinery = {
  states: [{name:'unpaid'}, {name:'payment_unverified'}, {name:'awaiting_issuance'},
    {name:'issued',terminal:true}, {name:'closed',terminal:true}],
  transitions: [
    {from:null,to:'unpaid',action:'CreateFliggyFlightBooking'},
    {from:'unpaid',to:'closed',action:'CloseFliggyFlightBooking'},
    {from:'unpaid',to:'payment_unverified',action:'PayFliggyFlightBooking'},
    {from:'unpaid',to:'awaiting_issuance',action:'PayFliggyFlightBooking'},
    {from:'unpaid',to:'issued',action:'PayFliggyFlightBooking'},
    {from:'payment_unverified',to:'awaiting_issuance'},
    {from:'payment_unverified',to:'issued'}, {from:'payment_unverified',to:'closed'},
    {from:'awaiting_issuance',to:'issued'},
  ],
};
