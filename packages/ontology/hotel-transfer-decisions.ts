import { z } from 'zod';
import { sandboxAgentCapability } from './agent-profiles.js';
import { decisionAssessment, scenarioDecisionSchema, transferLessonReference } from './scenario-decision.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const transferDecisionType = 'HotelTransferDecision';
export const transferObservationType = 'HotelTransferObservation';
export const transferObservationSource = 'SyntheticHotelTransferObservations';
export const transferObservationFunction = 'readHotelTransferObservation';
export const transferPlanLink = 'HotelTransferDecisionPlan';
export const transferOfferLink = 'HotelTransferDecisionOffer';
export const transferEvidenceLink = 'HotelTransferDecisionObservation';

export const transferJudgmentSchema = scenarioDecisionSchema.extend({
  expectedBufferMinutes: z.number(),
});
export const transferRetrospectSchema = z.strictObject({
  assessment: decisionAssessment,
  lesson: z.string().trim().min(1).max(1000),
  appliesWhen: z.string().trim().min(1).max(1000),
});
export const transferResultSchema = transferRetrospectSchema.extend({
  actualTravelMinutes: z.number(),
  actualBufferMinutes: z.number(),
  observationRevision: z.number().int().positive(),
  observationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reviewer: z.string(),
  reviewedAt: time,
});
export const transferObservationInput = z.strictObject({ observation: objectRefSchema });
export const reviewTransferInput = transferRetrospectSchema.extend({
  decision: objectRefSchema,
  revision: z.number().int().positive(),
  observation: objectRefSchema,
});
export const transferObservation = z.strictObject({
  id: z.string().min(1).max(200),
  decisionId: z.string().min(1).max(200),
  departedAt: time,
  arrivedAt: time,
  observedAt: time,
  evidence: z.literal('synthetic'),
});
const fields = (shape: Record<string, z.ZodType>) =>
  Object.fromEntries(Object.entries(shape).map(([name, schema]) =>
    [name, { description: name, schema: json(schema), required: !schema.isOptional() }]));
const tag = { typeClasses: [sandboxAgentCapability] };
export const hotelTransferDefinition: Pick<OntologyDocument, 'objectTypes' | 'linkTypes' | 'actionTypes' | 'functionTypes' | 'dataSources'> = {
  objectTypes: [{
    ...tag, apiName: transferDecisionType, displayName: '酒店接驳决策',
    description: 'A synthetic itinerary decision bound to a confirmed Scenario review.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: fields({
      id: z.string(), name: z.string(), date: z.iso.date(), matchKey: z.string(),
      release: z.string(), scenarioId: z.uuid(), scenarioRevision: z.number().int().positive(),
      snapshot: z.string(), reviewer: z.string(), approvedAt: time, departure: time,
      arriveBy: time, verifyBy: time, evidence: z.literal('synthetic'),
      judgment: transferJudgmentSchema, result: transferResultSchema.optional(),
      adoptedLesson: transferLessonReference.optional(),
    }),
  }, {
    ...tag, apiName: transferObservationType, displayName: '合成接驳回执',
    description: 'An independent authenticated synthetic feed observation of a transfer.',
    primaryKey: 'id', titleProperty: 'id', interfaces: {}, properties: fields(transferObservation.shape),
  }],
  linkTypes: [
    { apiName: transferPlanLink, description: 'Original itinerary associated with the decision.',
      from: { type: transferDecisionType, name: 'plan', cardinality: 'one' },
      to: { type: 'SchedulePlan', name: 'transferDecisions', cardinality: 'many' } },
    { apiName: transferOfferLink, description: 'Dated hotel offer that supported the decision.',
      from: { type: transferDecisionType, name: 'offer', cardinality: 'one' },
      to: { type: 'RollingGoHotelOffer', name: 'transferDecisions', cardinality: 'many' } },
    { apiName: transferEvidenceLink, description: 'Independent observation used in the retrospective.',
      from: { type: transferDecisionType, name: 'observation', cardinality: 'one' },
      to: { type: transferObservationType, name: 'decision', cardinality: 'one' } },
  ],
  functionTypes: [{
    ...tag, apiName: transferObservationFunction, description: 'Read an indexed synthetic transfer observation.',
    parameters: json(transferObservationInput), returns: json(transferObservation),
    source: transferObservationSource, dependencies: { objectTypes: [transferObservationType] },
  }, {
    ...tag, apiName: 'reviewHotelTransferOutcome',
    description: 'Confirm a lesson after comparing a reviewed transfer decision with its independent observation.',
    parameters: json(reviewTransferInput), returns: json(objectRefSchema), edits: true,
    dependencies: {
      objectTypes: [transferDecisionType, transferObservationType, 'SchedulePlan', 'RollingGoHotelOffer'],
      linkTypes: [transferPlanLink, transferOfferLink, transferEvidenceLink],
      dataSources: [transferObservationSource],
    },
  }],
  actionTypes: [{
    ...tag, apiName: 'ReviewHotelTransferOutcome', description: 'Record the actual outcome and confirm a lesson for this synthetic transfer.',
    parameters: json(reviewTransferInput), objectParameters: { decision: transferDecisionType, observation: transferObservationType },
    submissionCriteria: [], function: 'reviewHotelTransferOutcome',
  }],
  dataSources: [{
    apiName: transferObservationSource, objectType: transferObservationType, function: transferObservationFunction,
    properties: Object.fromEntries(Object.keys(transferObservation.shape).map(key => [key, key])),
  }],
};
