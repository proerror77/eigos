import type { SerializableAction } from './definition-contracts.js';
import type { CompositionPort } from './composition-contract.js';

export const managedMutationReceiptSchema = {
  type: 'object', properties: {
    intentId: { type: 'string', minLength: 1, maxLength: 200 }, actionId: { type: 'string', minLength: 1, maxLength: 80 },
    previewDigest: { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 },
  }, required: ['intentId', 'actionId', 'previewDigest'], additionalProperties: false,
};
/** Deterministic contract for the already-restricted declarative engine. The
 * current record output and the historical mutation receipt are distinct. */
export function managedComposition(action: SerializableAction): SerializableAction {
  const implementation = action.implementation;
  if (implementation?.kind !== 'declarative' || action.composition) return action;
  const inputs = Object.fromEntries(Object.entries(action.inputs).map(([name, type]): [string, CompositionPort] => [name, {
    kind: 'object', type, cardinality: 'one', semantics: { role: type, phase: 'fact' }, evidence: { origins: ['managed', 'user'] },
  }]));
  const resultType = implementation.result && ('type' in implementation.result ? implementation.result.type : action.inputs[implementation.result.parameter]);
  const outputs: Record<string, CompositionPort> = {
    receipt: { kind: 'value', schema: managedMutationReceiptSchema, cardinality: 'one', semantics: { role: 'committed_managed_mutation', phase: 'artifact' }, evidence: { origins: ['managed'] } },
    ...(resultType ? { result: { kind: 'object' as const, type: resultType, cardinality: 'one' as const, semantics: { role: resultType, phase: 'fact' as const }, evidence: { origins: ['managed' as const] } } } : {}),
  };
  return { ...action, composition: { version: '1', inputs, outputs, checks: [], effectScope: { effects: ['object_write'], targetInputs: Object.keys(inputs), recovery: { kind: 'none' }, compensation: [] } } };
}
