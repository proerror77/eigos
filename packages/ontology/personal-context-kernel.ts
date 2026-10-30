import { normalizeOntologyDocument, type TrustedDefinitionRegistry } from './model-compiler.js';
import { z } from 'zod';
import type { OntologyDocument, SerializableObjectType, SerializableAction, SerializableProperty } from './definition-contracts.js';
import { personalPreferenceValue, personalResourceRoles, personalBasisSchema } from './personal-context.js';

export const PERSONAL_CONTEXT_PREDECESSOR = '496938a2cf4a6661acab90171d6c3988c890364dee7d4f62c3575b2e2c70d644';
const string = { type: 'string', minLength: 1, maxLength: 200 };
const field = (schema: Record<string, unknown>, description: string, kind: SerializableProperty['kind'] = 'string', required = true): SerializableProperty => ({ kind, schema, required, description, source: 'Explicit authenticated personal context; not identity verification or business authority' });
const object = (id: string, primaryKey: string, description: string, properties: Record<string, SerializableProperty>): SerializableObjectType => ({ resourceId: `builtin:eigos.business:object:${id}`, id, version: '1', name: id, aliases: [], description, primaryKey, titleKey: 'displayTitle', writePolicy: 'managed',
  properties: { [primaryKey]: field(string, 'Stable owner-scoped business identity'), displayTitle: field(string, 'Display label, never identity'), ...properties } });
export const personalObjects = [
  object('Person', 'personId', 'A human service subject explicitly bound as self, distinct from its authenticated account and task roles. Conceptually aligned with FIBO Person.', { identityBasis: field({ type: 'string', const: 'self_asserted' }, 'Explicit self declaration; no verified legal identity claim') }),
  object('PersonalPreference', 'preferenceId', 'One confirmed, purpose-specific personal default. It never grants execution authority or overrides a current task instruction.', {
    personId: field(string, 'Person whose preference this is'), key: field({ type: 'string', enum: ['rideClass', 'deliveryAddress'] }, 'Registered preference semantics'),
    value: field(z.toJSONSchema(personalPreferenceValue), 'Typed preference value or existing address reference', 'struct'),
    status: field({ type: 'string', enum: ['active', 'cleared'] }, 'Cleared preferences cannot supply a default'), authority: field({ type: 'string', const: 'eigos' }, 'Only explicitly EIGOS-managed defaults are writable here'),
  }),
];
const ref = (type: string) => ({ type: 'object', properties: { type: { type: 'string', const: type }, id: string }, required: ['type', 'id'], additionalProperties: false });
const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const common = { version: '1', kind: 'business' as const, effects: ['object_write' as const], submissionCriteria: ['explicit_self_binding', 'exact_nonfinancial_write_authority', 'current_person_and_preference_versions'] };
export const personalActions: SerializableAction[] = [
  { ...common, resourceId: 'builtin:eigos.business:action:BindSelfPerson', id: 'BindSelfPerson', description: 'Explicitly bind the authenticated account to its self-declared human service subject. Does not verify legal identity.', inputs: {}, changes: ['Person'], resultTypes: ['Person'],
    inputSchema: schema({ personId: string, self: { type: 'boolean', const: true }, displayTitle: string }),
    implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'create', type: 'Person', id: { parameter: 'personId' }, properties: { personId: { parameter: 'personId' }, displayTitle: { parameter: 'displayTitle' }, identityBasis: { literal: 'self_asserted' } } }] } },
  { ...common, resourceId: 'builtin:eigos.business:action:CreatePersonalPreference', id: 'CreatePersonalPreference', description: 'Confirm one new EIGOS-managed personal default, without changing this task or placing an order.', inputs: { person: 'Person' }, changes: ['PersonalPreference'], resultTypes: ['PersonalPreference'],
    inputSchema: schema({ person: ref('Person'), preferenceId: string, key: { type: 'string', enum: ['rideClass', 'deliveryAddress'] }, value: z.toJSONSchema(personalPreferenceValue) }),
    implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [
      { op: 'create', type: 'PersonalPreference', id: { parameter: 'preferenceId' }, properties: { preferenceId: { parameter: 'preferenceId' }, displayTitle: { parameter: 'key' }, personId: { parameter: 'person', path: ['id'] }, key: { parameter: 'key' }, value: { parameter: 'value' }, status: { literal: 'active' }, authority: { literal: 'eigos' } } },
      { op: 'add_link', type: 'PreferencePerson', from: { type: 'PersonalPreference', id: { parameter: 'preferenceId' } }, to: { parameter: 'person' } },
    ] } },
  ...(['SetPersonalPreference', 'ClearPersonalPreference'] as const).map(id => ({ ...common, resourceId: `builtin:eigos.business:action:${id}`, id, description: id === 'SetPersonalPreference' ? 'Change an explicitly managed personal default at its exact revision; historical task choices remain unchanged.' : 'Clear a personal default at its exact revision; missing task values remain missing.',
    inputs: { person: 'Person', preference: 'PersonalPreference' }, changes: ['PersonalPreference.value', 'PersonalPreference.status'], resultTypes: ['PersonalPreference'],
    inputSchema: schema({ person: ref('Person'), preference: ref('PersonalPreference'), expectedRevision: { type: 'integer', minimum: 1 }, key: { type: 'string', enum: ['rideClass', 'deliveryAddress'] }, ...(id === 'SetPersonalPreference' ? { value: z.toJSONSchema(personalPreferenceValue) } : {}) }),
    implementation: { kind: 'declarative' as const, version: '1' as const, conditions: [], mutations: [{ op: 'update' as const, object: { parameter: 'preference' }, expectedRevision: { parameter: 'expectedRevision' }, properties: { status: { literal: id === 'SetPersonalPreference' ? 'active' : 'cleared' }, ...(id === 'SetPersonalPreference' ? { value: { parameter: 'value' } } : {}) } }] } })),
];
const link = (id: string, from: string, name: string, to: string, reverse: string, many = false, managed = false) => ({ id, resourceId: `builtin:eigos.business:link:${id}`, description: `${from}.${name} → ${to}; no authority is inherited from this relationship`, writePolicy: managed ? 'managed' as const : 'source' as const, from: { type: from, name, many }, to: { type: to, name: reverse, many: true } });
export const personalLinks = [
  link('RequestServedPerson', 'ServiceRequest', 'servedPerson', 'Person', 'serviceRequests'),
  link('RequesterSelfPerson', 'RequestingParty', 'selfPerson', 'Person', 'requestingAccounts'),
  link('PreferencePerson', 'PersonalPreference', 'person', 'Person', 'preferences', false, true),
  link('PreferenceAddress', 'PersonalPreference', 'address', 'SavedAddress', 'personalDefaults', false, true),
  link('RequestFactPreference', 'RequestFact', 'personalDefault', 'PersonalPreference', 'taskUses'),
  ...Object.values(personalResourceRoles).map(role => link(role.link, 'ServiceRequest', role.name, role.target, `person${role.name[0]!.toUpperCase()}${role.name.slice(1)}Requests`, true)),
];
export function extendPersonalContextKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  const document = normalizeOntologyDocument(original); document.version = '25';
  document.objects.push(...structuredClone(personalObjects)); document.actions.push(...structuredClone(personalActions)); document.links.push(...personalLinks);
  const schema = z.toJSONSchema(personalBasisSchema);
  document.objects.find(type => type.id === 'RequestFact')!.properties.personalBasis = { ...field(schema, 'Actual personal fact sources; the message source records only the task selection instruction', 'struct', false), validatorRef: registry.registerValidator('eigos.business:object:RequestFact:personalBasis', 'personal-context-v25', personalBasisSchema, schema) };
  return normalizeOntologyDocument(document);
}
