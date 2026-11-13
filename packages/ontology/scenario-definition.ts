import type { OntologyDocument } from './schema.js';

const text=(description:string)=>({description,schema:{type:'string'},required:true});
export const scenarioObjectType: OntologyDocument['objectTypes'][number] = {
  apiName:'OntologyScenario',displayName:'Scenario',description:'A persisted proposal and its review lifecycle metadata.',
  primaryKey:'id',titleProperty:'name',interfaces:{},properties:{
    id:text('Scenario identifier'),name:text('Scenario name'),owner:text('Owning authenticated identity'),
    state:text('Proposal lifecycle state'),release:text('Pinned ontology publication'),
    revision:{description:'Revision to inspect before changing or merging the proposal',schema:{type:'integer',minimum:1},required:true},
    expiresAt:{description:'Expiration time',schema:{type:'string',format:'date-time'},required:true},
    kind:text('Scenario storage kind'),description:text('Author supplied description'),
  },
};
