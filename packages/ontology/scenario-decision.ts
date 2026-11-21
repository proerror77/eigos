import { z } from 'zod';
import { objectRefSchema } from './schema.js';

const explanation = z.string().trim().min(1).max(1000);
export const scenarioDecisionSchema = z.strictObject({
  reason: explanation,
  alternative: explanation,
  rejectedBecause: explanation,
  assumption: explanation,
  expectedTravelMinutes: z.number().int().min(1).max(240),
});
export const transferLessonReference = z.strictObject({
  decision: objectRefSchema,
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
export const scenarioDecisionApprovalSchema = scenarioDecisionSchema.extend({
  adoptedLesson: transferLessonReference.optional(),
});
export type ScenarioDecision = z.output<typeof scenarioDecisionApprovalSchema>;

export const decisionAssessment = z.enum(['supported', 'refuted', 'insufficient']);
export interface ScenarioDecisionMemory {
  departure: string;
  arriveBy: string;
  prior: {
    decision: z.output<typeof objectRefSchema>;
    version: string;
    date: string;
    judgment: z.output<typeof scenarioDecisionSchema>;
    expectedBufferMinutes: number;
    actualTravelMinutes: number;
    actualBufferMinutes: number;
    assessment: z.output<typeof decisionAssessment>;
    lesson: string;
    appliesWhen: string;
  }[];
}
