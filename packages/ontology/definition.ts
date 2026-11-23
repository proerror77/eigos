import { Ontology } from './model.js';
import { commitmentState, networkContract } from './network-contract.js';
import { tableCheckReservations, tableCheckReservationType } from './tablecheck-reservations.js';
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
import { luckinDefinition as luckin, pickupOrderType, pickupState, pickupStatusTransitions } from './luckin.js';
import { deliveryFunctions } from './delivery.js';
import { currentPersonalPlaceVersionLink, personalPlaceDefinition, personalPlaceType, personalPlaceVersionType } from './personal-places.js';
import { bookWithEndpoints, bookWithEndpointsFunction, estimateWithEndpoints, immediateRideRouteLink, prepareWithEndpoints,
  ridePersonalPlaceLinks, ridePersonalPlaceRevisions, savedRideEndpoint } from './didi-ride-endpoints.js';
import { classificationSchema } from './classification.js';
import { localDeliveryDefinition, localDeliveryProviders } from './local-delivery.js';
import { deliveryTradeServices, hemaCheckoutStates, localDeliveryTradeDefinition, taobaoCheckoutStates } from './local-delivery-trade.js';
import {localEmbeddingDefinition} from './embedding-definition.js';
import { applicationDefinition as applications, geometryUploadCriterion } from './applications.js';
import {scenarioObjectType} from './scenario-definition.js';
import { rideWatchDefinition, rideWatchState, rideWatchClosed, rideWatchType } from './ride-watch.js';
import { petRideDefinition, petRideType } from './pet-ride.js';
import { addProcessLogs } from './process-definition.js';
import { readFileSync } from 'node:fs';
import type { OntologyDocument } from './schema.js';
import { fliggyServicesDefinition as fliggy, marketplaceDefinition as marketplace, servicesDefinition as services } from './services.js';
import { fliggyFlightBookingDefinition } from './fliggy-flight-booking.js';
import { fliggyHotelDefinition } from './fliggy-hotel.js';
import { didiImmediateRideDefinition, immediateApprovalLink, immediateRideState, immediateRideInterface, immediateRideType } from './didi-immediate-ride.js';
import { didiReadDefinitions } from './didi-reads.js';
import { didiOrderDefinitions, travelDefinition as travel } from './travel.js';
import { paymentsDefinition as payments } from './payments.js';
import { diningEvidence, diningResearchFunctions } from './dining.js';
import { dianpingResearchFunctions } from './dianping.js';
import { restaurantServices } from './restaurant-services.js';
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
  id: ride.id, version: '48',
  agentProfiles: businessAgentProfiles,
  objectTypes: [...ride.objectTypes, ...scheduling.objectTypes, ...services.objectTypes, ...travel.objectTypes, ...journey.objectTypes, ...flight.objectTypes, ...payments.objectTypes,...luckin.objectTypes,...applications.objectTypes,...documents.objectTypes,scenarioObjectType], interfaceTypes: [...ride.interfaceTypes, ...scheduling.interfaceTypes, ...services.interfaceTypes, ...travel.interfaceTypes, ...payments.interfaceTypes],
  linkTypes: [...ride.linkTypes, ...scheduling.linkTypes, ...services.linkTypes, ...travel.linkTypes, ...journey.linkTypes, ...flight.linkTypes, ...payments.linkTypes,...luckin.linkTypes,...applications.linkTypes,...documents.linkTypes], functionTypes: [...ride.functionTypes, ...scheduling.functionTypes, ...services.functionTypes, ...travel.functionTypes, ...journey.functionTypes, ...flight.functionTypes,flightPositionFunction, ...payments.functionTypes,...deliveryFunctions,...locationFunctions,...mapFunctions,...luckin.functionTypes,...applications.functionTypes,...documents.functionTypes,localEmbeddingDefinition],
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
businessDefinition.objectTypes.push(...personalPlaceDefinition.objectTypes, ...localDeliveryDefinition.objectTypes, ...localDeliveryTradeDefinition.objectTypes);
businessDefinition.linkTypes.push(...personalPlaceDefinition.linkTypes, ...localDeliveryDefinition.linkTypes, ...localDeliveryTradeDefinition.linkTypes);
businessDefinition.interfaceTypes.push(...localDeliveryDefinition.interfaceTypes, ...localDeliveryTradeDefinition.interfaceTypes);
businessDefinition.functionTypes.push(...personalPlaceDefinition.functionTypes, ...localDeliveryDefinition.functionTypes, ...localDeliveryTradeDefinition.functionTypes);
businessDefinition.actionTypes.push(...personalPlaceDefinition.actionTypes, ...localDeliveryDefinition.actionTypes, ...localDeliveryTradeDefinition.actionTypes);
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
businessDefinition.objectTypes.push(...restaurantServices.objectTypes);
businessDefinition.interfaceTypes.push(...restaurantServices.interfaceTypes);
businessDefinition.linkTypes.push(...restaurantServices.linkTypes);
businessDefinition.functionTypes.push(...restaurantServices.functionTypes);
businessDefinition.actionTypes.push(...restaurantServices.actionTypes);

businessDefinition.imports = [{
  ontology: networkContract.id, version: networkContract.version, digest: new Ontology(networkContract).digest,
  namespace: 'Net', document: networkContract,
}];
businessDefinition.objectTypes.push(...tableCheckReservations.objectTypes);
businessDefinition.linkTypes.push(...tableCheckReservations.linkTypes);
businessDefinition.interfaceTypes.push(...tableCheckReservations.interfaceTypes);
businessDefinition.functionTypes.push(...tableCheckReservations.functionTypes);
businessDefinition.actionTypes.push(...tableCheckReservations.actionTypes);

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
  {apiName:'Services',displayName:'服务',description:'Provider-neutral service offerings',objectTypes:[...services.objectTypes,...luckin.objectTypes,...fliggy.objectTypes,...marketplace.objectTypes,...travelHandoffDefinition.objectTypes,...fliggyHotelDefinition.objectTypes,...fliggyFlightBookingDefinition.objectTypes,...diningReservations.objectTypes,...restaurantServices.objectTypes,...tableCheckReservations.objectTypes].map(type=>type.apiName)},
  { apiName: 'PersonalPlaces', displayName: '个人地点', description: 'Owner-confirmed locations', objectTypes: [personalPlaceType, personalPlaceVersionType, 'ProviderDeliveryAddress'] },
  ...localDeliveryProviders.map(provider => {
    const service = deliveryTradeServices[provider];
    return { apiName: provider, displayName: service.search.displayName, description: 'Account-scoped supplier transactions',
      objectTypes: [service.search.object, service.cartChangeType, service.checkoutType, service.orderType] };
  }),
  {apiName:'TimedTravel',displayName:'定时出行',description:'Authorized event and travel planning',objectTypes:[...travel.objectTypes,...journey.objectTypes,...flight.objectTypes].map(type=>type.apiName)},
  {apiName:'Payments',displayName:'付款',description:'Merchant order handoff and independently read payment status',objectTypes:payments.objectTypes.map(type=>type.apiName)},
  {apiName:'Models',displayName:'三维模型',description:'Model assets and annotations',objectTypes:applications.objectTypes.map(type=>type.apiName)},
  {apiName:'Documents',displayName:'业务文档',description:'Versioned documents linked to business objects',objectTypes:documents.objectTypes.map(type=>type.apiName)},
  {apiName:'Scenarios',displayName:'方案',description:'Persisted scenario metadata',objectTypes:['OntologyScenario']},
];
for(const group of businessDefinition.typeGroups)for(const name of group.objectTypes){const type=businessDefinition.objectTypes.find(type=>type.apiName===name)!;type.groups=[group.apiName];type.status='active';}

for(const fn of businessDefinition.functionTypes){
  if(fn.apiName==='embedTextLocal' || fn.apiName===geometryUploadCriterion){fn.dependencies={};continue;}
  if(travelHandoffDefinition.functionTypes.includes(fn) || restaurantServices.functionTypes.includes(fn) ||
    tableCheckReservations.functionTypes.includes(fn))continue;
  if(personalPlaceDefinition.functionTypes.includes(fn)||documents.functionTypes.includes(fn)||fliggy.functionTypes.includes(fn)||marketplace.functionTypes.includes(fn)||localDeliveryDefinition.functionTypes.includes(fn)||localDeliveryTradeDefinition.functionTypes.includes(fn)||fliggyHotelDefinition.functionTypes.includes(fn)||fliggyFlightBookingDefinition.functionTypes.includes(fn)||diningResearchFunctions.includes(fn)||dianpingResearchFunctions.includes(fn)||diningReservations.functionTypes.includes(fn)||petRideDefinition.functionTypes.includes(fn)||fn===diningActivityFunction)continue;
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

const endpointParameters = {
  ...quoteParameters, properties: { ...quoteParameters.properties,
    originPersonalPlace: jsonSchema(savedRideEndpoint), destinationPersonalPlace: jsonSchema(savedRideEndpoint) },
};
const extraEndpointDependencies = {
  objectTypes: [personalPlaceType, personalPlaceVersionType, 'Route', 'Place'],
  linkTypes: ['RouteOrigin', 'RouteDestination', currentPersonalPlaceVersionLink, ...ridePersonalPlaceLinks.map(link => link.apiName)],
};
const placeType = businessDefinition.objectTypes.find(type => type.apiName === 'Place')!;
placeType.classificationProperty = 'locationClassification';
placeType.properties.locationClassification = { description: 'Data classification of a private DiDi point observation',
  schema: jsonSchema(classificationSchema), required: false };
routeType.classificationProperty = 'locationClassification';
routeType.properties.locationClassification = { description: 'Data classification of a route using a personal place',
  schema: jsonSchema(classificationSchema), required: false };
routeType.properties.personalPlaceRevisions = { description: 'Revisions of the confirmed personal endpoints used on this route',
  schema: jsonSchema(ridePersonalPlaceRevisions), required: false };
businessDefinition.linkTypes.push(...ridePersonalPlaceLinks, {
  apiName: immediateRideRouteLink, description: 'The confirmed route used by this immediate DiDi booking.',
  from: { type: immediateRideType, name: 'route', cardinality: 'one' },
  to: { type: 'Route', name: 'immediateRides', cardinality: 'one' },
});
const estimateEndpointDescription = 'Estimate the fare from named places, saved personal place references and revisions, or the original PA’s current pickup.';
businessDefinition.functionTypes.push({ ...prepareWithClues, apiName: prepareWithEndpoints, description: estimateEndpointDescription,
  parameters: endpointParameters, dependencies: { ...prepareWithClues.dependencies,
    objectTypes: [...new Set([...prepareWithClues.dependencies.objectTypes ?? [], ...extraEndpointDependencies.objectTypes])],
    linkTypes: [...new Set([...prepareWithClues.dependencies.linkTypes ?? [], ...extraEndpointDependencies.linkTypes])],
  } });
businessDefinition.actionTypes.push({ ...quoteWithClues, apiName: estimateWithEndpoints, function: prepareWithEndpoints,
  description: estimateEndpointDescription, parameters: endpointParameters });
clueInquiry.actions.estimateWithEndpoints = { parameters: endpointParameters, objectParameters: {}, required: false };
const endpointMapping = { originPersonalPlace: 'originPersonalPlace', destinationPersonalPlace: 'destinationPersonalPlace' };
clueMapping.actions.estimateWithEndpoints = { action: estimateWithEndpoints,
  parameters: { ...clueMapping.actions.estimate!.parameters, ...endpointMapping } };

const bookingInterface = immediateRide.interfaceTypes[0]!;
const bookingObject = immediateRide.objectTypes[0]!;
const bookingAction = immediateRide.actionTypes[0]!;
const bookingFunction = immediateRide.functionTypes[0]!;
const bookingEndpointDescription = 'Resolve a named, saved or current pickup and a named or saved destination; book after the original PA approves the exact route and fare.';
businessDefinition.actionTypes.push({ ...bookingAction, apiName: bookWithEndpoints, function: bookWithEndpointsFunction,
  parameters: endpointParameters, description: bookingEndpointDescription });
businessDefinition.functionTypes.push({ ...bookingFunction, apiName: bookWithEndpointsFunction, parameters: endpointParameters,
  description: bookingEndpointDescription, dependencies: { ...bookingFunction.dependencies,
    objectTypes: [...new Set([...bookingFunction.dependencies?.objectTypes ?? [], ...extraEndpointDependencies.objectTypes])],
    linkTypes: [...bookingFunction.dependencies?.linkTypes ?? [], ...extraEndpointDependencies.linkTypes, immediateRideRouteLink],
  } });
Object.assign(bookingInterface.actions, {
  bookWithEndpoints: { parameters: endpointParameters, objectParameters: {}, required: false },
});
Object.assign(bookingObject.interfaces[immediateRideInterface]!.actions, {
  bookWithEndpoints: { action: bookWithEndpoints,
    parameters: { ...bookingObject.interfaces[immediateRideInterface]!.actions.book.parameters, ...endpointMapping } },
});
Object.assign(bookingInterface.links, { route: { target: 'Route', cardinality: 'one', required: false } });
Object.assign(bookingObject.interfaces[immediateRideInterface]!.links, { route: 'route' });


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
businessDefinition.linkTypes.push({
  apiName: immediateApprovalLink, description: 'PA input and approval lifecycle for the original immediate ride Action.',
  from: { type: immediateRideType, name: 'approval', cardinality: 'one' },
  to: { type: 'ActionConfirmation', name: 'immediateRide', cardinality: 'one' },
});
businessDefinition.objectTypes.push(...rideWatchDefinition.objectTypes);
businessDefinition.linkTypes.push(...rideWatchDefinition.linkTypes);
businessDefinition.functionTypes.push(...rideWatchDefinition.functionTypes);
businessDefinition.actionTypes.push(...rideWatchDefinition.actionTypes);
addProcessLogs(businessDefinition, [
  { type: itineraryType, property: 'state' },
  { type: rideWatchType, property: 'state' },
  { type: immediateRideType, property: 'state' },
  { type: 'DidiRideOrder', property: 'state' },
  { type: 'FliggyHotelBooking', property: 'state' },
  { type: 'FliggyFlightBooking', property: 'issuanceState' },
  { type: petRideType, property: 'state' },
  { type: 'ActionConfirmation', property: 'state' },
  { type: 'EventRegistration', property: 'state' }, { type: 'EventTrip', property: 'state' },
  { type: 'StripeLinkPaymentRequest', property: 'status' }, { type: 'SchedulePlan', property: 'state' }, { type: journeyType, property: 'state' }, { type: flightWatchType, property: 'state' },
  { type: diningReservationType, property: 'state' },
  { type: tableCheckReservationType, property: 'state' },
  { type: pickupOrderType, property: 'state' },
  ...localDeliveryProviders.flatMap(provider => {
    const service = deliveryTradeServices[provider];
    return [{ type: service.checkoutType, property: 'state' }, { type: service.checkoutType, property: 'observation' },
      { type: service.orderType, property: 'fulfillment' }];
  }),
]);

businessDefinition.objectTypes.find(type => type.apiName === 'LuckinPickupOrderStateLog')!.machinery = {
  states: pickupState.options.map(name => ({ name, terminal: name === 'completed' || name === 'canceled' })),
  transitions: [
    { from: null, to: 'previewed', action: 'PreviewLuckinPickup' },
    ...['awaiting_payment', 'placed', 'price_changed'].map(to => ({ from: 'previewed', to, action: 'SubmitLuckinPickup' })),
    ...pickupStatusTransitions.map(edge => ({ ...edge, action: 'RefreshLuckinPickupStatus' })),
  ],
};
businessDefinition.objectTypes.find(type => type.apiName === 'TableCheckReservationStateLog')!.machinery = {
  states: commitmentState.options.map(name => ({ name, terminal: name === 'canceled' || name === 'fulfilled' })),
  transitions: [
    { from: null, to: 'offered', action: 'PrepareTableCheckReservation' },
    { from: 'expired', to: 'offered', action: 'PrepareTableCheckReservation' },
    { from: 'offered', to: 'held' },
    { from: 'held', to: 'confirmed', action: 'ConfirmTableCheckReservation' },
    { from: 'held', to: 'unknown', action: 'ConfirmTableCheckReservation' },
    // Before the hold was projected, existing reservations went directly from offer to result.
    { from: 'offered', to: 'confirmed' },
    { from: 'offered', to: 'unknown' },
    { from: 'confirmed', to: 'canceled', action: 'CancelTableCheckReservation' },
    { from: 'confirmed', to: 'unknown', action: 'CancelTableCheckReservation' },
    { from: 'unknown', to: 'confirmed' },
    { from: 'unknown', to: 'canceled' },
    ...['offered', 'held'].map(from => ({ from, to: 'expired', action: 'ExpireTableCheckReservation' })),
  ],
};

businessDefinition.objectTypes.find(type => type.apiName === 'ActionConfirmationStateLog')!.machinery = {
  states: [{ name: 'awaiting-input' }, { name: 'confirmed' },
    ...['completed', 'failed', 'canceled'].map(name => ({ name, terminal: true }))],
  transitions: [{ from: null, to: 'awaiting-input' }, { from: 'awaiting-input', to: 'confirmed' },
    { from: 'confirmed', to: 'awaiting-input' }, { from: 'awaiting-input', to: 'canceled' },
    ...['completed', 'failed', 'canceled'].map(to => ({ from: 'confirmed', to }))],
};
businessDefinition.objectTypes.find(type => type.apiName === 'DidiImmediateRideStateLog')!.machinery = {
  states: immediateRideState.options.map(name => ({ name, terminal: true })),
  transitions: immediateRideState.options.map(to => ({ from: null, to })),
  subprocesses: [{ link: 'approval', process: 'ActionConfirmationStateLog' }, { link: 'order', process: 'DidiRideOrderStateLog' }],
};
businessDefinition.objectTypes.find(type => type.apiName === 'DidiRideOrderStateLog')!.machinery = {
  states: ['created', 'reported', 'unknown'].map(name => ({ name })),
  transitions: [
    ...['created', 'reported', 'unknown'].map(to => ({ from: null, to })),
    { from: 'created', to: 'reported' }, { from: 'unknown', to: 'reported' },
  ],
  subprocesses: [{ link: 'watches', process: 'DidiRideWatchStateLog' }],
};
const watchPhases = rideWatchState.options.filter(state => !rideWatchClosed.has(state));
businessDefinition.objectTypes.find(type => type.apiName === 'DidiRideWatchStateLog')!.machinery = {
  states: rideWatchState.options.map(name => ({ name, terminal: rideWatchClosed.has(name) })),
  transitions: [{ from: null, to: 'watching', action: 'StartDidiRideWatch' },
    ...watchPhases.flatMap((from, index) => [...watchPhases.slice(index + 1), ...rideWatchClosed].map(to => ({ from, to })))],
};

for (const provider of localDeliveryProviders) {
  const service = deliveryTradeServices[provider], actions = service.names;
  const taobao = provider === 'TaobaoInstantDelivery';
  businessDefinition.objectTypes.find(type => type.apiName === service.checkoutProcess)!.machinery = {
    states: (taobao ? taobaoCheckoutStates : hemaCheckoutStates).map(name => ({ name })),
    transitions: [
      { from: null, to: 'quoted', action: actions.preview },
      { from: 'quoted', to: 'declined', action: actions.submit },
      { from: 'quoted', to: 'order_unknown', action: actions.submit },
      { from: 'quoted', to: 'awaiting_payment', action: actions.submit },
      { from: 'order_unknown', to: 'awaiting_payment', action: actions.refresh },
      { from: 'awaiting_payment', to: 'payment_handoff', action: actions.preparePayment },
      ...(taobao ? [
        ...['awaiting_payment', 'payment_handoff'].flatMap(from => ['payment_unknown', 'payment_verification', 'payment_failed']
          .map(to => ({ from, to, action: actions.pay }))),
        ...['quoted', 'awaiting_payment', 'payment_handoff', 'payment_unknown', 'payment_verification', 'payment_failed', 'order_unknown']
          .map(from => ({ from, to: 'paid', action: actions.refresh })),
        ...['quoted', 'order_unknown', 'payment_unknown', 'payment_verification', 'payment_failed'].flatMap(from =>
          ['payment_unknown', 'payment_verification', 'payment_failed'].filter(to => to !== from)
            .map(to => ({ from, to, action: actions.refresh }))),
      ] : []),
    ],
    subprocesses: [{ link: 'orders', process: service.orderProcess }],
  };
  businessDefinition.objectTypes.find(type => type.apiName === service.checkoutType + 'ObservationLog')!.machinery = {
    states: [{ name: 'idle' }, { name: 'watching' }, ...['finished', 'timed_out', 'source_unavailable', 'stopped']
      .map(name => ({ name, terminal: true }))],
    transitions: [{ from: null, to: 'idle', action: actions.preview }, { from: 'idle', to: 'watching', action: actions.submit },
      ...['finished', 'timed_out', 'source_unavailable'].map(to => ({ from: 'watching', to, action: actions.refresh })),
      { from: 'watching', to: 'stopped', action: actions.stopObservation }],
  };
  businessDefinition.objectTypes.find(type => type.apiName === service.orderProcess)!.machinery = {
    states: ['unknown', 'in_progress', 'completed', 'canceled'].map(name => ({ name,
      ...(name === 'completed' || name === 'canceled' ? { terminal: true } : {}) })),
    transitions: [
      { from: null, to: 'unknown', action: actions.submit },
      ...[null, 'unknown'].flatMap(from => ['in_progress', 'completed', 'canceled']
        .map(to => ({ from, to, action: actions.refresh }))),
      ...['completed', 'canceled'].map(to => ({ from: 'in_progress', to, action: actions.refresh })),
    ],
  };
}

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

const diningProfile = businessDefinition.agentProfiles!.find(profile => profile.apiName === 'Dining')!;
diningProfile.actions = [...(diningProfile.actions ?? []), 'FindRestaurants', 'ReviewRestaurantVisit', 'PrepareTableCheckReservation',
  'ConfirmTableCheckReservation', 'ReconcileTableCheckReservation', 'CancelTableCheckReservation'];
diningProfile.functions = [...(diningProfile.functions ?? []), 'readRestaurantSearch', 'readRestaurantVisit', 'readTableCheckReservation'];
diningProfile.instructions = [...(diningProfile.instructions ?? []),
  { action: 'FindRestaurants', function: 'readRestaurantSearch',
    text: 'Choose an exact venue from an authorized source. Keep distinct branch identities across suppliers. For Resy, specify the source explicitly and request the original PA’s official connector. For enterprise Meituan, supply a verified GCJ-02 point.' },
  { action: 'ReviewRestaurantVisit', function: 'readRestaurantVisit',
    text: 'Review current options for the exact date and party size. A link or booking-support flag is a handoff, never an available slot, held table or confirmed reservation.' },
  { action: 'ConfirmTableCheckReservation', function: 'readTableCheckReservation',
    text: 'Show exact offered terms and obtain the user’s approval on the original task. Read back the original reservation. If the supplier outcome is unknown, use reconciliation without resubmission.' },
];
