import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { functionCallSchema, evaluateLegacyFunctionProgram } from './object-functions.js';
import { objectRefSchema, type FunctionDefinition } from './model.js';
import { rideEstimateObservationSchema } from './ride-estimate.js';
import { functionInputNormalizes, type FunctionImplementation } from './function-runtime.js';
import type { FunctionReadSet } from './function-contracts.js';
import { completeFunctionImplementation } from './complete-function-implementations.js';

const observations = ['DidiPlaceObservation', 'RideEstimateObservation'];
const rideReads: FunctionReadSet = {
  types: [...observations, 'RideEstimateTask', 'ServiceRequest', 'RideRoute', 'SourceReceipt'],
  relationships: [
    ...observations.flatMap(type => ['sourceReceipts', 'scope', 'request'].map(name => ({ type, name }))),
    ...['route', 'originSearch', 'destinationSearch'].map(name => ({ type: 'RideEstimateObservation', name })),
  ],
  sourceProof: true,
};
const selectionValue = z.strictObject({
  placeId: z.string().regex(/^[a-f0-9]{64}$/), observation: objectRefSchema.extend({ type: z.literal('DidiPlaceObservation') }),
  selectionRule: z.enum(['explicit_unique_address', 'unique_exact_name']),
});
const rideStatusValue = z.strictObject({
  data: rideEstimateObservationSchema.shape.data, route: rideEstimateObservationSchema.shape.route,
  observedAt: z.iso.datetime(), freshnessPolicyUntil: z.iso.datetime(),
  providerQuoteExpiry: z.literal('unknown'), feesComplete: z.literal('unknown'), availability: z.literal('unknown'),
  pickupCommitment: z.literal('unknown'), arrivalCommitment: z.literal('unknown'),
  evidenceKind: rideEstimateObservationSchema.shape.evidenceKind, noBusinessWrites: z.literal(true),
});
const values: Readonly<Record<string, z.ZodType>> = { selectDidiPlace: selectionValue, rideEstimateStatus: rideStatusValue };
const implementations = new Map<string, FunctionImplementation>();

/** Software-owned adapter around the existing evaluators. A definition publisher
 * cannot invent a name: the executable input union is the allowlist. Versioned
 * evaluators (including identity v1/v2) inspect the same pinned model passed here. */
export function builtinFunctionImplementation(definition: Pick<FunctionDefinition, 'id' | 'version' | 'executionContract'>): FunctionImplementation {
  if (definition.executionContract?.version === '2') return completeFunctionImplementation(definition);
  const { id, version } = definition, key = JSON.stringify([id, version]), previous = implementations.get(key);
  if (previous) return previous;
  const input = functionCallSchema.options.find(schema => schema.shape.function.value === definition.id);
  if (!input) throw new DomainError('INVALID_INPUT', 'No built-in executor exists for this function');
  const value = values[definition.id];
  const common = { version: '1' as const, inputSchema: z.toJSONSchema(input, { io: 'input' }), unknown: 'explicit_reason_no_value' as const,
    ...(functionInputNormalizes(input) ? { parameterNormalization: 'registered_parser' as const } : {}) };
  const implementation: FunctionImplementation = {
    input, ...(value ? { value } : {}),
    contract: value ? { ...common, mode: 'validated', valueSchema: z.toJSONSchema(value), reads: structuredClone(rideReads) }
      : { ...common, mode: 'legacy', result: 'undeclared', reads: 'runtime_tracked', reason: 'Existing trusted evaluator; a complete result schema and declared read set have not been reviewed.' },
    execute(graph, owner, raw, budget) {
      if (graph.model.function(id).version !== version) throw new DomainError('CONFLICT', 'Function executor differs from the pinned version');
      return evaluateLegacyFunctionProgram(graph, owner, input.parse(raw), budget);
    },
  };
  implementations.set(key, implementation);
  return implementation;
}
