import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import type { ActionDefinition, OntologyModel } from './model.js';
import { isPersonalAction } from './personal-context.js';

export const actionCriterionBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('engine'), guard: z.enum(['owned_objects', 'exact_write_authority']) }),
  z.strictObject({ kind: z.literal('condition'), index: z.number().int().min(0).max(31) }),
  z.strictObject({ kind: z.literal('trusted_runtime') }),
  z.strictObject({ kind: z.literal('personal_context') }),
  z.strictObject({ kind: z.literal('definition_only') }),
]);
export type ActionCriterionBinding = z.infer<typeof actionCriterionBindingSchema>;
export const actionCriteriaBindingsSchema = z.record(z.string().min(1).max(200), actionCriterionBindingSchema);
const engineGuards: Readonly<Record<string, string>> = {
  same_owner: 'owned_objects', within_authority: 'exact_write_authority', exact_nonfinancial_write_authority: 'exact_write_authority',
};
const personalCriteria = new Set(['explicit_self_binding', 'current_person_and_preference_versions']);
function fail(message: string): never { throw new DomainError('INVALID_INPUT', message); }

/** A registered word alone is not an enforced condition. The forward compiler
 * requires either actual engine protection, an executed condition index, or the
 * exact trusted runtime selected by this action's handler reference. */
export function validateActionCriteria(model: OntologyModel, action: ActionDefinition, protectedResource: boolean): void {
  const bindings = action.criteriaBindings, implementation = model.actionImplementation(action.id);
  if (!bindings || Object.keys(bindings).length !== new Set(action.submissionCriteria).size
    || Object.keys(bindings).some(name => !action.submissionCriteria.includes(name))) fail('Every action criterion requires exactly one enforcement binding');
  for (const criterion of action.submissionCriteria) {
    const binding = bindings[criterion];
    if (!binding) fail(`Uncovered submission criterion: ${criterion}`);
    if (!implementation) { if (binding.kind !== 'definition_only') fail('Definition-only action cannot claim an executable criterion'); continue; }
    if (implementation.kind === 'trusted') {
      // The compiler already resolved the exact immutable handlerRef, whose
      // digest includes these declarations. Runtime readiness remains separate.
      if (binding.kind !== 'trusted_runtime') fail('Trusted criteria require the exact trusted runtime binding');
      continue;
    }
    if (binding.kind === 'engine') {
      if (engineGuards[criterion] !== binding.guard) fail('Criterion is not enforced by the declared generic engine guard');
    } else if (binding.kind === 'condition') {
      if (!implementation.conditions[binding.index]) fail('Criterion names a missing declarative condition');
    } else if (binding.kind === 'personal_context') {
      if (!protectedResource || !isPersonalAction(action.id) || !personalCriteria.has(criterion)) fail('Personal criteria require the reviewed personal-action guard');
    } else fail('Declarative criterion has no actual executable check');
  }
}
