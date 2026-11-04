import { z } from 'zod';
import { moneySchema } from './execution.js';
import { actionDiscoverySchema, type ActionBindingPin } from '../core/action-bindings.js';
import type { CompositionPort } from './composition-contract.js';
import type { PipelineIntake } from './pipeline/contracts.js';
import type { ActionDefinition } from './model.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const text = z.string().trim().min(1).max(500);
const type = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/);
export const needSourceSchema = z.strictObject({ messageId: text, quote: z.string().min(1).max(2000) });
const phase = z.enum(['fact', 'quote', 'commitment', 'payment', 'delivery', 'artifact']);
export const serviceNeedSchema = z.strictObject({
  id, role: text, source: needSourceSchema,
  output: z.strictObject({ type, phase, role: text.optional(), cardinality: z.enum(['one', 'many']).optional() }),
  /** Identity selectors describe this need, never provider observations. */
  target: z.strictObject({ origin: text.optional(), destination: text.optional(), resource: text.optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(), endsAt: z.iso.datetime({ offset: true }).optional(),
    timeZone: text.optional(), participants: z.number().int().min(1).max(100).optional() }).default({}),
  serviceConditions: actionDiscoverySchema.shape.serviceConditions.optional(),
  payment: z.strictObject({ instrument: text, currency: z.string().regex(/^[A-Z]{3}$/) }).optional(),
  budget: moneySchema.optional(), dependsOn: z.array(id).max(15).default([]),
});
export type ServiceNeed = z.infer<typeof serviceNeedSchema>;
const roundTripSchema = z.strictObject({
  kind: z.literal('round_trip'), source: needSourceSchema,
  origin: text, destination: text, originRegion: text, destinationRegion: text,
  participants: z.number().int().min(1).max(100),
  phase: z.enum(['quote', 'commitment']),
  lodging: z.boolean().default(false), arrivalTransfer: z.boolean().default(false),
  departureTransfer: z.boolean().default(false), dining: z.boolean().default(false),
  payment: serviceNeedSchema.shape.payment, budget: moneySchema.optional(),
});
export const servicePlanningSchema = z.strictObject({
  goal: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('needs'), needs: z.array(serviceNeedSchema).min(1).max(16) }), roundTripSchema]),
  maxDiscoveryPages: z.number().int().min(1).max(8).default(8),
  maxAlternatives: z.number().int().min(1).max(3).default(2),
});
export type ServicePlanningInput = z.infer<typeof servicePlanningSchema>;

/** A projection of exact published contracts and configured binding metadata.
 * No prices, wallet compatibility, availability or permission is inferred. */
export interface ServicePlanningContract {
  version: '1'; binding: ActionBindingPin;
  effects: string[]; inputs: Record<string, CompositionPort>; outputs: Record<string, CompositionPort>;
  requiredArguments: string[]; contextInputSchema: object;
  submissionCriteria: string[];
  sourceDependencies: NonNullable<NonNullable<ActionDefinition['read']>['mcp']>['requires'];
  declaredConditions?: PipelineIntake['conditions'];
  readiness: string; reason: string;
}
export interface PlannedServiceStep {
  id: string; needId: string; role: string; action: string; bindingDigest: string;
  dependsOn: string[];
  inputBindings: { targetKey: string; stepId: string; port: string; evaluate?: string; derive?: { function: string; path: string[] } }[];
  unresolvedArguments: string[];
}
export interface ServiceNeedPlan {
  need: ServiceNeed; derivedBy?: { rule: 'travel.round_trip'; version: '1'; source: z.infer<typeof needSourceSchema> };
  coverage: 'complete' | 'incomplete';
  alternatives: { rootStepId: string; steps: PlannedServiceStep[]; bindingDigests: string[] }[];
  gaps: { code: string; reason: string }[];
  /** This is a contract plan. Live facts remain independently queryable. */
  applicability: { check: string; result: 'unknown'; reason: string }[];
}
