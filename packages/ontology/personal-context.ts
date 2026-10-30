import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { objectRefSchema, nameSchema, type ObjectRef } from './model.js';
import type { OntologyObjectStore } from './object-store.js';

export const personalPreferenceKey = z.enum(['rideClass', 'deliveryAddress']);
export type PersonalPreferenceKey = z.infer<typeof personalPreferenceKey>;
export const personalPreferenceValue = z.union([
  z.strictObject({ kind: z.literal('rideClass'), value: z.string().min(1).max(100).regex(/\S/) }),
  z.strictObject({ kind: z.literal('deliveryAddress'), address: z.lazy(() => objectRefSchema.extend({ type: z.literal('SavedAddress') })) }),
]);
export const personalSourceSchema = z.union([
  z.strictObject({ authority: z.literal('eigos'), object: z.lazy(() => objectRefSchema.extend({ type: z.literal('PersonalPreference') })), revision: z.number().int().positive() }),
  z.strictObject({ authority: z.literal('pa'), reference: z.string().min(1).max(500), version: z.string().min(1).max(200), observedAt: z.iso.datetime({ offset: true }), confirmation: z.literal('reported_by_authenticated_pa') }),
]);
export const personalBasisSchema = z.strictObject({ selection: z.literal('confirmed_default'), sources: z.array(personalSourceSchema).min(1).max(2) });
export type PersonalBasis = z.infer<typeof personalBasisSchema>;
export const personalContextInputSchema = z.strictObject({
  self: z.literal(true),
  preferences: z.array(personalPreferenceKey).max(2).optional(),
  paDefaults: z.array(z.strictObject({ value: personalPreferenceValue, sourceReference: z.string().min(1).max(500), sourceVersion: z.string().min(1).max(200), observedAt: z.iso.datetime({ offset: true }), userConfirmed: z.literal(true) })).max(2).optional(),
  overrides: z.strictObject({ rideClass: z.string().min(1).max(100).regex(/\S/).nullable().optional(), deliveryAddress: z.lazy(() => objectRefSchema.extend({ type: z.literal('SavedAddress') })).nullable().optional() }).optional(),
  resources: z.array(z.strictObject({ object: z.lazy(() => objectRefSchema), revision: z.number().int().positive(), fields: z.array(z.lazy(() => nameSchema)).min(1).max(20),
    role: z.enum(['activity', 'travel', 'lodging', 'transport', 'product', 'destination']) })).max(8).optional(),
}).refine(input => new Set(input.preferences ?? []).size === (input.preferences?.length ?? 0), 'Personal preference selections must be unique').refine(input => new Set(input.paDefaults?.map(fact => fact.value.kind)).size === (input.paDefaults?.length ?? 0), 'PA defaults must have unique semantic keys');
export type PersonalContextInput = z.infer<typeof personalContextInputSchema>;
export type SelectedPersonalContext = PersonalContextInput & { preferences: PersonalPreferenceKey[]; resources: NonNullable<PersonalContextInput['resources']> };
export function mergePersonalContext(input: PersonalContextInput, previous?: SelectedPersonalContext): SelectedPersonalContext {
  for (const next of input.paDefaults ?? []) {
    const old = previous?.paDefaults?.find(value => value.value.kind === next.value.kind && value.sourceReference === next.sourceReference);
    if (old && (Date.parse(next.observedAt) < Date.parse(old.observedAt) || next.sourceVersion === old.sourceVersion && digest(next.value) !== digest(old.value)
      || next.sourceVersion !== old.sourceVersion && Date.parse(next.observedAt) <= Date.parse(old.observedAt))) throw new DomainError('CONFLICT', 'Personal source version is older, concurrent or inconsistent');
  }
  return { ...input, preferences: input.preferences ?? previous?.preferences ?? [], resources: input.resources ?? previous?.resources ?? [], paDefaults: input.paDefaults ?? previous?.paDefaults, overrides: { ...previous?.overrides, ...input.overrides } };
}
export const selfPersonRef = (owner: string): ObjectRef => ({ type: 'Person', id: digest({ namespace: 'eigos.self-person.v1', owner }) });
export const personalPreferenceRef = (owner: string, key: PersonalPreferenceKey): ObjectRef => ({ type: 'PersonalPreference', id: digest({ namespace: 'eigos.personal-preference.v1', person: selfPersonRef(owner), key }) });
export const personalActionIds = ['BindSelfPerson', 'CreatePersonalPreference', 'SetPersonalPreference', 'ClearPersonalPreference'] as const;
export const isPersonalAction = (id: string): boolean => (personalActionIds as readonly string[]).includes(id);
export const personalInputFields = { Person: ['personId', 'displayTitle', 'identityBasis'], PersonalPreference: ['preferenceId', 'displayTitle', 'personId', 'key', 'value', 'status', 'authority'] } as const;
export interface PersonalSelection { input: PersonalContextInput; person: ObjectRef; inputs: { object: ObjectRef; objectRevision: number; fields: string[] }[] }

/** The account-derived reference is a private self-binding, never a legal identity
 * or a cross-account person match. Only this reviewed set of actions can use the
 * Foundation managed-write bridge. */
export function assertPersonalAction(graph: OntologyObjectStore, owner: string, id: string, input: Record<string, unknown>): ObjectRef[] {
  if (!isPersonalAction(id) || !graph.model.hasType('Person') || graph.model.actionImplementation(id)?.kind !== 'declarative') throw new DomainError('FORBIDDEN', 'Only reviewed personal actions are available');
  const person = selfPersonRef(owner), same = (a: unknown, b: unknown) => digest(a) === digest(b);
  if (id === 'BindSelfPerson') {
    if (input.personId !== person.id || input.self !== true) throw new DomainError('FORBIDDEN', 'An explicit authenticated self declaration is required');
    return [];
  }
  if (!same(input.person, person)) throw new DomainError('FORBIDDEN', 'Personal action belongs to another service subject');
  const subject = graph.read(owner, person);
  if (subject.properties.identityBasis !== 'self_asserted') throw new DomainError('FORBIDDEN', 'Self binding is unavailable');
  const key = personalPreferenceKey.parse(input.key), preference = personalPreferenceRef(owner, key);
  if (id === 'CreatePersonalPreference' ? input.preferenceId !== preference.id : !same(input.preference, preference)) throw new DomainError('FORBIDDEN', 'Preference identity does not match its person and semantic key');
  if (id !== 'CreatePersonalPreference') {
    const previous = graph.read(owner, preference);
    if (previous.properties.authority !== 'eigos' || previous.properties.personId !== person.id || previous.properties.key !== key) throw new DomainError('FORBIDDEN', 'This preference is not managed by EIGOS for this person');
    if (!personalPreferenceValue.safeParse(previous.properties.value).success) throw new DomainError('FORBIDDEN', 'The current personal value is not available for an exact preview');
  }
  if (id === 'ClearPersonalPreference') return [];
  const value = personalPreferenceValue.parse(input.value);
  if (value.kind !== key) throw new DomainError('INVALID_INPUT', 'Preference value uses a different semantic key');
  if (value.kind === 'deliveryAddress') { graph.read(owner, value.address); return [value.address]; }
  return [];
}

/** Reusable semantic task roles, independent of a particular scenario. */
export const personalResourceRoles = {
  activity: { link: 'RequestActivityContext', name: 'activityContext', target: 'Scheduled' },
  travel: { link: 'RequestTravelContext', name: 'travelContext', target: 'OriginDestination' },
  lodging: { link: 'RequestLodgingContext', name: 'lodgingContext', target: 'Located' },
  transport: { link: 'RequestTransportContext', name: 'transportContext', target: 'OriginDestination' },
  product: { link: 'RequestProductContext', name: 'productContext', target: 'ProductVariant' },
  destination: { link: 'RequestDestinationContext', name: 'destinationContext', target: 'Addressable' },
} as const;
