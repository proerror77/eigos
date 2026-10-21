import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { ManagedResultFact } from './action-dsl.js';
import type { CandidateFacts } from './execution.js';
import { moneySchema } from './execution.js';

/** Bind measured values to the declared result record. The model supplies no
 * amounts or completion facts; units and roles belong to the immutable Action.
 * These are internal-record facts, never payment or provider attestations. */
export function readManagedResultFacts(properties: Record<string, unknown>, bindings: readonly ManagedResultFact[]): CandidateFacts {
  const facts: CandidateFacts = {};
  for (const binding of bindings) {
    const amount = properties[binding.amountProperty];
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw new DomainError('CONFLICT', 'Managed result amount must be a present nonnegative safe integer');
    if (binding.kind === 'budget') {
      const parsed = moneySchema.safeParse({ minor: String(amount), currency: properties[binding.currencyProperty] });
      if (!parsed.success) throw new DomainError('CONFLICT', 'Managed result currency is missing or invalid');
      if (binding.role) (facts.amounts ??= {})[binding.role] = parsed.data;
      else facts.totalPrice = parsed.data;
    } else {
      const quantity = { amount: String(amount), unit: binding.unit };
      if (binding.role) (facts.quantities ??= {})[binding.role] = quantity;
      else facts.quantity = quantity;
    }
  }
  return facts;
}

/** Multiple result records may agree, but conflicting measurements require an
 * explicit business model; never choose whichever would pass a constraint. */
export function mergeManagedResultFacts(groups: readonly CandidateFacts[]): CandidateFacts {
  const facts: CandidateFacts = {};
  const assign = <T>(prior: T | undefined, next: T): T => {
    if (prior !== undefined && digest(prior) !== digest(next)) throw new DomainError('CONFLICT', 'Managed result facts are ambiguous across confirmed result records');
    return next;
  };
  for (const group of groups) {
    if (group.totalPrice) facts.totalPrice = assign(facts.totalPrice, group.totalPrice);
    if (group.quantity) facts.quantity = assign(facts.quantity, group.quantity);
    for (const key of ['amounts', 'quantities'] as const) if (group[key]) {
      const target = (facts[key] ??= {}) as Record<string, unknown>;
      for (const [role, value] of Object.entries(group[key])) target[role] = assign(target[role], value);
    }
  }
  return facts;
}
