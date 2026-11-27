import type { OntologyDocument } from './schema.js';

const text=(description:string)=>({description,schema:{type:'string'},required:true});
export const scenarioInterfaceName = 'Scenario';
const scenarioProperties = {
  id:text('Scenario identifier'),name:text('Scenario name'),owner:text('Owning authenticated identity'),
  state:text('Proposal lifecycle state'),
  revision:{description:'Revision to inspect before changing or merging the proposal',schema:{type:'integer',minimum:1},required:true},
  expiresAt:{description:'Expiration time',schema:{type:'string',format:'date-time'},required:true},
  syncConflict:{description:'Whether automatic synchronization observed a conflict',schema:{type:'boolean'},required:false},
};
export const scenarioInterface: OntologyDocument['interfaceTypes'][number] = {
  apiName: scenarioInterfaceName, description: 'An owned or explicitly shared Scenario proposal',
  properties: scenarioProperties, optionalProperties: [], links: {}, actions: {},
};
export const scenarioObjectType: OntologyDocument['objectTypes'][number] = {
  apiName:'OntologyScenario',displayName:'Scenario',description:'A persisted proposal and its review lifecycle metadata.',
  primaryKey:'id',titleProperty:'name',
  interfaces:{[scenarioInterfaceName]:{properties:Object.fromEntries(Object.keys(scenarioProperties).map(name=>[name,name])),links:{},actions:{}}},
  properties:{
    ...scenarioProperties,
    release:text('Pinned ontology publication'),kind:text('Scenario storage kind'),description:text('Author supplied description'),
  },
};
