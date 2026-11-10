import { DomainError } from '../core/domain.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import type { EffectClass } from './actions.js';

/**
 * v33 finishes the effect declaration.
 *
 * 57 of 123 actions carried no `effects` list. For 55 of them the intent was not
 * missing — it was already stated once as `operation.effect` / `read.effect` — so
 * this release copies it instead of inventing a second answer. The two that truly
 * state nothing (`RequestDeliveryQuote`, `SelectOffer`) are definition-only
 * decisions: they get no effect, and the integrity gate requires every *implemented*
 * action to declare one.
 *
 * The 24 actions that already declare a richer set (a checkout is `order` +
 * `payment`) are left exactly as reviewed.
 */
const effectOf = (action: OntologyDocument['actions'][number]): EffectClass | undefined =>
  action.operation?.effect ?? action.read?.effect ?? undefined;

export function extendEffectCoverageKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  if (original.version !== '32') throw new DomainError('CONFLICT', 'Effect coverage requires the reviewed v32 predecessor');
  const document = structuredClone(original);
  document.version = '33';

  let derived = 0, kept = 0, undeclared: string[] = [];
  for (const action of document.actions) {
    if ((action.effects ?? []).length) { kept++; continue; }
    const declared = effectOf(action);
    if (!declared) { undeclared.push(action.id); continue; }
    const additional = action.operation?.additionalEffects ?? [];
    action.effects = [...new Set<EffectClass>([declared, ...additional])];
    derived++;
    if (action.implementation?.kind === 'trusted') {
      const { resourceId: _id, implementation: _impl, ...contract } = action;
      action.implementation = { ...action.implementation, handlerRef: registry.registerAction(contract) };
    }
  }
  if (undeclared.length && undeclared.some(id => document.actions.find(action => action.id === id)?.implementation)) {
    throw new DomainError('CONFLICT', `Implemented action without any declared effect: ${undeclared.join(', ')}`);
  }
  if (derived + kept + undeclared.length !== document.actions.length) throw new DomainError('CONFLICT', 'Every action must be accounted for');
  document.effectCoverage = { derived, kept, undeclared: [...undeclared].sort() };
  return document;
}
