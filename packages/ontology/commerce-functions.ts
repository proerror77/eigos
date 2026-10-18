import { commerceSnapshotSchema, assessCommerce } from './commerce.js';
import { sourceProof } from './object-evidence.js';
import type { ObjectRef } from './model.js';
import type { Computation } from './object-functions.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
import { DomainError } from '../core/domain.js';

export function evaluateCommerceFunction(store: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (!['checkoutReadiness', 'commerceOrderOutcome'].includes(input.function)) return;
  if (input.object.type !== 'CheckoutSession') throw new DomainError('INVALID_INPUT', 'Commerce functions require a CheckoutSession');
  const record = store.read(owner, input.object, budget), proof = sourceProof(store, owner, input.object, budget), parsed = commerceSnapshotSchema.safeParse(record.properties.snapshot);
  if (!proof || !parsed.success) return { status: 'unknown', reason: 'Checkout lacks current source-bound evidence', evidenceRefs: [input.object], evidenceLevels: [] };
  const snapshot = parsed.data, refs = [input.object, ...proof.refs];
  if (input.function === 'checkoutReadiness') {
    const expired = snapshot.checkout.expiresAt && Date.parse(snapshot.checkout.expiresAt) <= store.now();
    return { status: 'known', value: { status: snapshot.checkout.state === 'canceled' || expired ? 'unsatisfied' : snapshot.checkout.state !== 'ready_for_complete' || snapshot.checkout.messageCodes.length || !snapshot.checkout.destinationDigest ? 'unknown' : 'satisfied', checkoutState: snapshot.checkout.state, total: snapshot.checkout.total, grantsAuthority: false, orderCreated: !!snapshot.checkout.orderId, paymentState: 'unknown', fulfillment: snapshot.order?.fulfillment ?? 'unknown' }, evidenceRefs: refs, evidenceLevels: proof.levels };
  }
  if (snapshot.operation !== 'confirm') return { status: 'unknown', reason: 'Only a checkout preparation was requested; there is no accepted purchase outcome', evidenceRefs: refs, evidenceLevels: proof.levels };
  return { status: 'known', value: assessCommerce(snapshot, store.now()), evidenceRefs: refs, evidenceLevels: proof.levels };
}
