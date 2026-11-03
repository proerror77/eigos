import { digest } from '../core/delegation.js';
import { providerActions } from '../capabilities/payment-commerce/contracts.js';
import { checkedCommerceRead } from './payment-commerce.js';
import { sourceProof } from './object-evidence.js';
import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

export function evaluateCommerceRead(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'paymentCommerceReadStatus') return;
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  if (input.object.type !== 'PaymentCommerceReadObservation') return unknown('Not a payment/commerce source observation');
  const record = graph.read(owner, input.object, budget), proof = sourceProof(graph, owner, input.object, budget);
  if (!proof) return unknown('Provider source evidence changed');
  let s;
  try { s = checkedCommerceRead(record.properties.snapshot); } catch { return unknown('Invalid provider snapshot'); }
  const roots = graph.related(owner, input.object, 'request', budget), scopes = graph.related(owner, input.object, 'scope', budget);
  if (!providerActions[s.provider].includes(s.query.action) || Date.parse(s.observedAt) > graph.now() || Date.parse(s.expiresAt) <= graph.now()
    || roots?.length !== 1 || roots[0]!.ref.id !== s.requestId || roots[0]!.properties.revision !== s.requestRevision
    || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope) || scopes[0]!.properties.provider !== s.provider
    || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.requestRevision !== s.requestRevision
    || digest(scopes[0]!.properties.input) !== digest(s.query)) return unknown('Provider evidence expired or query scope changed');
  return { status: 'known', value: { provider: s.provider, query: s.query, result: s.result, noBusinessWrites: true, paymentPerformedByEigos: false }, evidenceRefs: [input.object, ...proof.refs], evidenceLevels: proof.levels };
}
