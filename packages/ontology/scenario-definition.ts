import { z } from 'zod';
import { digest } from '../core/identity.js';
import { scenarioDecisionApprovalSchema } from './scenario-decision.js';
import type { OntologyDocument, ScenarioReviewRule } from './schema.js';

const text=(description:string)=>({description,schema:{type:'string'},required:true});
export const scenarioInterfaceName = 'Scenario';
const scenarioProperties = {
  id:text('Scenario identifier'),name:text('Scenario name'),owner:text('Owning authenticated identity'),
  state:text('Proposal lifecycle state'),
  reviewStatus:{description:'Review status of the current proposal revision',
    schema:{type:'string',enum:['draft','in-review','approved','rejected']},required:false},
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


export const scenarioReviewActions = {
  submit: 'SubmitScenarioReview', approve: 'ApproveScenarioReview', reject: 'RejectScenarioReview',
} as const;
type ReviewKind = keyof typeof scenarioReviewActions;
type ActionDefinition = OntologyDocument['actionTypes'][number];

const input = (parameter: string) => ({ parameter });
const baseParameters = { id: { type: 'string', format: 'uuid' }, revision: { type: 'integer', minimum: 1 } };
const snapshot = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const { $schema: _schema, ...approvalDecision } = z.toJSONSchema(scenarioDecisionApprovalSchema);

function action(kind: ReviewKind, description: string, fields: Record<string, unknown>, required: string[],
  review: ScenarioReviewRule['review']): ActionDefinition {
  return {
    apiName: scenarioReviewActions[kind], description,
    parameters: { type: 'object', properties: { ...baseParameters, ...fields }, required: ['id', 'revision', ...required], additionalProperties: false },
    objectParameters: {}, submissionCriteria: [],
    rules: [{ op: 'reviewScenario', scenario: input('id'), expectedRevision: input('revision'), review }],
    result: { type: scenarioObjectType.apiName, id: input('id') },
  };
}

export const scenarioReviewDefinitions = [
  action('submit', 'Submit an owned Scenario revision to selected reviewers', {
    reviewers: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 100 },
  }, ['reviewers'], { kind: 'submit', reviewers: input('reviewers') }),
  action('approve', 'Approve the exact Scenario revision and reviewed snapshot', { snapshot, decision: approvalDecision },
    ['snapshot'], { kind: 'approve', snapshot: input('snapshot'), decision: input('decision') }),
  action('reject', 'Reject the exact Scenario revision and reviewed snapshot', { snapshot },
    ['snapshot'], { kind: 'reject', snapshot: input('snapshot') }),
];
const reviewContracts = new Map(scenarioReviewDefinitions.map(definition => [definition.apiName, digest(definition)]));

/** Legacy review authority applies only to these immutable platform actions and their dynamic Scenario checks. */
export function isScenarioReviewAction(definition: ActionDefinition | undefined) {
  if (!definition) return false;
  const contract = reviewContracts.get(definition.apiName);
  return Boolean(contract && contract === digest(definition));
}
