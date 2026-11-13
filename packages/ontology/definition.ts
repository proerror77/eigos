import {localEmbeddingDefinition} from './embedding-definition.js';
import {applicationDefinition as applications} from './applications.js';
import {scenarioObjectType} from './scenario-definition.js';
import { readFileSync } from 'node:fs';
import type { OntologyDocument } from './schema.js';

const ride = JSON.parse(readFileSync(new URL('./definitions/ride.json', import.meta.url), 'utf8')) as OntologyDocument;
const scheduling = JSON.parse(readFileSync(new URL('./definitions/scheduling.json', import.meta.url), 'utf8')) as OntologyDocument;
/** Domain packages compose into one published authority, never independent task stores. */
export const businessDefinition: OntologyDocument = {
  id: ride.id, version: '6',
  objectTypes: [...ride.objectTypes, ...scheduling.objectTypes,...applications.objectTypes,scenarioObjectType], interfaceTypes: [...ride.interfaceTypes, ...scheduling.interfaceTypes],
  linkTypes: [...ride.linkTypes, ...scheduling.linkTypes,...applications.linkTypes], functionTypes: [...ride.functionTypes, ...scheduling.functionTypes,...applications.functionTypes,localEmbeddingDefinition],
  actionTypes: [...ride.actionTypes, ...scheduling.actionTypes,...applications.actionTypes], dataSources: [...ride.dataSources, ...scheduling.dataSources],
};


// The bundled domains use the same reusable contracts consumed by the editor and runtime.
businessDefinition.sharedProperties=[{apiName:'BusinessName',description:'Human-readable business name',schema:{type:'string'},required:false}];
businessDefinition.valueTypes=[{apiName:'Timestamp',version:'1',description:'An ISO date-time instant',schema:{type:'string',format:'date-time'}}];
const coordinates=ride.objectTypes.find(type=>type.apiName==='Place')!.properties.coordinates!.schema;
businessDefinition.structTypes=[{apiName:'Coordinates',description:'Provider coordinates with an explicit coordinate-system declaration on the object',fields:coordinates.properties as Record<string,Record<string,unknown>>,required:['lat','lng']}];
for(const type of [...businessDefinition.objectTypes,...businessDefinition.interfaceTypes]){
  if(type.properties.name)type.properties.name={...type.properties.name,sharedProperty:'BusinessName'};
  for(const property of Object.values(type.properties))if(property.schema.format==='date-time')property.valueType={name:'Timestamp',version:'1'};
}
businessDefinition.objectTypes.find(type=>type.apiName==='Place')!.properties.coordinates!.struct={type:'Coordinates'};
businessDefinition.objectTypes.find(type=>type.apiName==='RideRequest')!.properties.estimateCount={description:'Number of currently visible linked estimates',schema:{type:'integer',minimum:0},required:false,derived:{op:'linked',path:[{link:'estimates'}],aggregate:'count'}};
businessDefinition.typeGroups=[
  {apiName:'Travel',displayName:'出行',description:'Places, routes and source-backed price estimates',objectTypes:ride.objectTypes.map(type=>type.apiName)},
  {apiName:'Scheduling',displayName:'排程',description:'Resources, calendar availability and schedule plans',objectTypes:scheduling.objectTypes.map(type=>type.apiName)},
  {apiName:'Models',displayName:'三维模型',description:'Model assets and annotations',objectTypes:applications.objectTypes.map(type=>type.apiName)},
  {apiName:'Scenarios',displayName:'方案',description:'Persisted scenario metadata',objectTypes:['OntologyScenario']},
];
for(const group of businessDefinition.typeGroups)for(const name of group.objectTypes){const type=businessDefinition.objectTypes.find(type=>type.apiName===name)!;type.groups=[group.apiName];type.status='active';}

for(const fn of businessDefinition.functionTypes){
  if(fn.apiName==='embedTextLocal'){fn.dependencies={};continue;}
  if(ride.functionTypes.some(item=>item.apiName===fn.apiName)){
    fn.dependencies={objectTypes:ride.objectTypes.map(type=>type.apiName),interfaceTypes:ride.interfaceTypes.map(type=>type.apiName),linkTypes:ride.linkTypes.map(link=>link.apiName),dataSources:ride.dataSources.map(source=>source.apiName),functions:ride.functionTypes.filter(item=>item.apiName!==fn.apiName).map(item=>item.apiName)};
  }else if(scheduling.functionTypes.some(item=>item.apiName===fn.apiName)){
    fn.dependencies={objectTypes:scheduling.objectTypes.map(type=>type.apiName),interfaceTypes:scheduling.interfaceTypes.map(type=>type.apiName),linkTypes:scheduling.linkTypes.map(link=>link.apiName)};
  }else{
    fn.dependencies={objectTypes:applications.objectTypes.map(type=>type.apiName),linkTypes:applications.linkTypes.map(link=>link.apiName)};
  }
}
