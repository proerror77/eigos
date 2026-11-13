import { readFileSync } from 'node:fs';
import type { OntologyDocument } from './schema.js';

const ride = JSON.parse(readFileSync(new URL('./definitions/ride.json', import.meta.url), 'utf8')) as OntologyDocument;
const scheduling = JSON.parse(readFileSync(new URL('./definitions/scheduling.json', import.meta.url), 'utf8')) as OntologyDocument;
/** Domain packages compose into one published authority, never independent task stores. */
export const businessDefinition: OntologyDocument = {
  id: ride.id, version: '5',
  objectTypes: [...ride.objectTypes, ...scheduling.objectTypes], interfaceTypes: [...ride.interfaceTypes, ...scheduling.interfaceTypes],
  linkTypes: [...ride.linkTypes, ...scheduling.linkTypes], functionTypes: [...ride.functionTypes, ...scheduling.functionTypes],
  actionTypes: [...ride.actionTypes, ...scheduling.actionTypes], dataSources: [...ride.dataSources, ...scheduling.dataSources],
};
