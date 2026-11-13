import { readFileSync } from 'node:fs';
import type { OntologyDocument } from './schema.js';
import { servicesDefinition as services } from './services.js';
import { travelDefinition as travel } from './travel.js';

const ride = JSON.parse(readFileSync(new URL('./definitions/ride.json', import.meta.url), 'utf8')) as OntologyDocument;
const scheduling = JSON.parse(readFileSync(new URL('./definitions/scheduling.json', import.meta.url), 'utf8')) as OntologyDocument;
/** Domain packages compose into one published authority, never independent task stores. */
export const businessDefinition: OntologyDocument = {
  id: ride.id, version: '6',
  objectTypes: [...ride.objectTypes, ...scheduling.objectTypes, ...services.objectTypes, ...travel.objectTypes], interfaceTypes: [...ride.interfaceTypes, ...scheduling.interfaceTypes, ...services.interfaceTypes, ...travel.interfaceTypes],
  linkTypes: [...ride.linkTypes, ...scheduling.linkTypes, ...services.linkTypes, ...travel.linkTypes], functionTypes: [...ride.functionTypes, ...scheduling.functionTypes, ...services.functionTypes, ...travel.functionTypes],
  actionTypes: [...ride.actionTypes, ...scheduling.actionTypes, ...services.actionTypes, ...travel.actionTypes], dataSources: [...ride.dataSources, ...scheduling.dataSources, ...services.dataSources],
};
businessDefinition.objectTypes.find(type=>type.apiName==='LumaEvent')!.interfaces.AttendableEvent={properties:Object.fromEntries(['name','start','end','timeZone','status','locationPrecision','registrationOpen','approvalRequired'].map(name=>[name,name])),links:{registrations:'registrations',trips:'trips'},actions:{register:{action:'PrepareEventRegistration',parameters:{event:'event',ticketId:'ticketId',sourceTaskId:'sourceTaskId'}}}};
