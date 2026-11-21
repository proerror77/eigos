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
export type ScenarioDecision = z.output<typeof scenarioDecisionSchema>;

export const decisionAssessment = z.enum(['supported', 'refuted', 'insufficient']);
export interface ScenarioDecisionMemory {
  departure: string;
  arriveBy: string;
  prior: {
    decision: z.output<typeof objectRefSchema>;
    date: string;
    judgment: ScenarioDecision;
    expectedBufferMinutes: number;
    actualTravelMinutes: number;
    actualBufferMinutes: number;
    assessment: z.output<typeof decisionAssessment>;
    lesson: string;
    appliesWhen: string;
  }[];
}
