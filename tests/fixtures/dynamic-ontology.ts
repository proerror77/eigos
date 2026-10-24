import assert from 'node:assert/strict';
import type { JobStore } from '../../packages/core/store.js';
import type { SerializableAction, SerializableObjectType } from '../../packages/ontology/definition-contracts.js';

const text = { type: 'string', minLength: 1, maxLength: 200 };
const input = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const managedFixtureObject: SerializableObjectType = {
  resourceId: 'fixture:object:OfficeAsset', id: 'OfficeAsset', version: '1', name: 'Office resource', aliases: [], description: 'Owner managed office resource', primaryKey: 'id', titleKey: 'label', writePolicy: 'managed',
  properties: {
    id: { kind: 'string', schema: text, required: true, source: 'Owner input', description: 'Stable identity' },
    label: { kind: 'string', schema: text, required: true, source: 'Owner input', description: 'Display label' },
    status: { kind: 'string', schema: { type: 'string', enum: ['available', 'requested'] }, required: true, source: 'Owner input', description: 'Internal resource status' },
  },
};
const objectInput = { type: 'object', properties: { type: { type: 'string', const: 'OfficeAsset' }, id: text }, required: ['type', 'id'], additionalProperties: false };
const common = { version: '1', kind: 'business' as const, effects: ['object_write' as const], changes: ['OfficeAsset'], submissionCriteria: ['exact_object_write_authority'] };
export const managedFixtureActions: SerializableAction[] = [
  { ...common, resourceId: 'fixture:action:CreateOfficeAsset', id: 'CreateOfficeAsset', description: 'Create an internal resource record', inputs: {}, resultTypes: ['OfficeAsset'], inputSchema: input({ id: text, label: text }),
    implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'create', type: 'OfficeAsset', id: { parameter: 'id' }, properties: { id: { parameter: 'id' }, label: { parameter: 'label' }, status: { literal: 'available' } } }] } },
  { ...common, resourceId: 'fixture:action:SetOfficeAssetStatus', id: 'SetOfficeAssetStatus', description: 'Update internal resource status', inputs: { asset: 'OfficeAsset' }, resultTypes: ['OfficeAsset'], inputSchema: input({ asset: objectInput, expectedRevision: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['available', 'requested'] } }),
    implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'update', object: { parameter: 'asset' }, expectedRevision: { parameter: 'expectedRevision' }, properties: { status: { parameter: 'status' } } }] } },
  { ...common, resourceId: 'fixture:action:DeleteOfficeAsset', id: 'DeleteOfficeAsset', description: 'Logically delete an internal resource record', inputs: { asset: 'OfficeAsset' }, inputSchema: input({ asset: objectInput, expectedRevision: { type: 'integer', minimum: 1 } }),
    implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'tombstone', object: { parameter: 'asset' }, expectedRevision: { parameter: 'expectedRevision' } }] } },
];

export function publishManagedFixture(store: JobStore, owner: string, ontologyId = 'office.test') {
  const namespace = store.definitions.createNamespace(owner, { id: ontologyId, name: 'Office internal requests' });
  let draft = store.definitions.createDraft(owner, ontologyId, 'New managed office resource');
  draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', managedFixtureObject);
  for (const action of managedFixtureActions) draft = store.definitions.putResource(owner, draft.id, draft.revision, 'action', action);
  const validation = store.definitions.validate(draft.id);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  const published = store.definitions.publish(owner, draft.id, draft.revision);
  store.definitions.activate(owner, published.release, namespace.generation);
  return { ontologyId, release: published.release, graph: store.ontologyForRelease(published.release) };
}
