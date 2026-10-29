import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from '../packages/core/store.js';
import { DomainError } from '../packages/core/domain.js';
import { digest } from '../packages/core/delegation.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import type { DefinitionDraft } from '../packages/ontology/definition-store.js';
import type { SerializableObjectType } from '../packages/ontology/definition-contracts.js';
import { LEGACY_SEED_MODEL_REF } from '../packages/ontology/seed-definition.js';
import { owner, principal } from './backend-fixture.js';
import { managedFixtureActions, managedFixtureObject, publishManagedFixture } from './fixtures/dynamic-ontology.js';

const otherOwner = 'definition-test-other-owner';
const source = { kind: 'user' as const, id: 'definition-store-test-input', observedAt: '2026-10-21T00:00:00Z' };
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
const optionalText = { kind: 'string' as const, schema: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Explicit extra observation', source: 'Owner input' };
function object(id = 'OfficeAsset', resourceId = `test:object:${id}`): SerializableObjectType {
  return { ...structuredClone(managedFixtureObject), id, resourceId, name: id, description: `Managed test ${id}` };
}
function addObject(store: JobStore, ontologyId: string, type = object()) {
  const namespace = store.definitions.namespace(ontologyId);
  let draft = store.definitions.createDraft(owner, ontologyId, `Add ${type.id}`);
  draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', type);
  const published = store.definitions.publish(owner, draft.id, draft.revision);
  store.definitions.activate(owner, published.release, namespace.generation);
  return published.release;
}
function editObject(store: JobStore, ontologyId: string, type: SerializableObjectType) {
  const namespace = store.definitions.namespace(ontologyId);
  let draft = store.definitions.createDraft(owner, ontologyId, `Revise ${type.id}`);
  draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', type);
  const published = store.definitions.publish(owner, draft.id, draft.revision);
  store.definitions.activate(owner, published.release, namespace.generation);
  return published.release;
}
function disk() {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-definition-store-'));
  return { directory, path: join(directory, 'jobs.sqlite') };
}
function validated(store: JobStore, draft: DefinitionDraft) {
  const result = store.definitions.validate(draft.id);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  return result;
}

test('private namespaces enforce ownership before mutation or validation details and stay out of other owner listings', () => {
  const store = new JobStore(':memory:');
  try {
    const namespace = store.definitions.createNamespace(owner, { id: 'private.definition', name: 'Private business definitions' });
    const draft = store.definitions.createDraft(owner, namespace.id, 'Private draft');
    assert(!store.definitions.namespaces(otherOwner).some(value => value.id === namespace.id));
    assert(store.definitions.namespaces(owner).some(value => value.id === namespace.id));
    assert.throws(() => store.definitions.assertAccess(otherOwner, namespace.id), errorCode('FORBIDDEN'));
    assert.throws(() => store.definitions.createDraft(otherOwner, namespace.id, 'Unauthorized'), errorCode('FORBIDDEN'));
    assert.throws(() => store.definitions.putResource(otherOwner, draft.id, draft.revision, 'object', { bad: 'schema' }), errorCode('FORBIDDEN'));
    assert.throws(() => store.definitions.publish(otherOwner, draft.id, draft.revision), errorCode('FORBIDDEN'));
    assert.throws(() => store.definitions.activate(otherOwner, { ...namespace.active, digest: 'f'.repeat(64) }, 999), errorCode('FORBIDDEN'));
    store.definitions.assertAccess(otherOwner, 'eigos.business');
    assert.throws(() => store.definitions.assertManagement(owner, 'eigos.business'), errorCode('FORBIDDEN'));
    assert.equal(store.definitions.draft(draft.id).revision, draft.revision);
    assert.deepEqual(store.definitions.namespace(namespace.id), namespace);
  } finally { store.close(); }
});

test('published definitions and exact historical pins survive independent restart without duplicate bootstrap writes', () => {
  const fixture = disk(); let store = new JobStore(fixture.path);
  try {
    const published = publishManagedFixture(store, owner, 'durable.definition');
    const legacy = store.definitions.legacy(), events = store.definitions.events(published.ontologyId, 100), releases = store.definitions.releases(published.ontologyId);
    const model = store.definitions.resolve(published.release).model.ref;
    assert.deepEqual(legacy.model.ref, LEGACY_SEED_MODEL_REF);
    assert.throws(() => { store.definitions.resolve(published.release).document.objects[0]!.name = 'Forged returned document'; }, TypeError);
    const resolved = store.definitions.resolve(published.release), documentDigest = digest(resolved.document);
    for (const replacement of [{ ref: store.definitions.active().ref }, { model: legacy.model }, { document: legacy.document }, { compatibleDefinition: () => true }]) {
      assert.throws(() => Object.assign(resolved, replacement), TypeError, `The cached release wrapper cannot replace ${Object.keys(replacement)[0]}`);
      const reread = store.definitions.resolve(published.release);
      assert.deepEqual(reread.ref, published.release); assert.deepEqual(reread.model.ref, model); assert.equal(digest(reread.document), documentDigest);
    }
    store.close(); store = new JobStore(fixture.path);
    assert.deepEqual(store.definitions.active(published.ontologyId).ref, published.release);
    assert.deepEqual(store.definitions.resolve(published.release).model.ref, model);
    assert.deepEqual(store.definitions.legacy().ref, legacy.ref);
    assert.deepEqual(store.definitions.events(published.ontologyId, 100), events);
    assert.deepEqual(store.definitions.releases(published.ontologyId), releases);
    assert.throws(() => store.definitions.resolve({ ...published.release, digest: 'a'.repeat(64) }), errorCode('CONFLICT'));
    assert.throws(() => store.definitions.resolve({ ...published.release, ontologyId: 'eigos.business' }), errorCode('CONFLICT'));
  } finally { store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('draft CAS and publication retries are exact while stale active-base drafts cannot publish', () => {
  const store = new JobStore(':memory:');
  try {
    const namespace = store.definitions.createNamespace(owner, { id: 'draft.definition', name: 'Draft CAS' });
    let a = store.definitions.createDraft(owner, namespace.id, 'First author'), b = store.definitions.createDraft(owner, namespace.id, 'Second author');
    const firstRevision = a.revision;
    a = store.definitions.putResource(owner, a.id, a.revision, 'object', object('AssetA'));
    assert.throws(() => store.definitions.putResource(owner, a.id, firstRevision, 'object', object('LostUpdate')), errorCode('CONFLICT'));
    assert(!store.definitions.draft(a.id).document.objects.some(type => type.id === 'LostUpdate'));
    b = store.definitions.putResource(owner, b.id, b.revision, 'object', object('AssetB'));
    validated(store, a); const before = store.definitions.releases(namespace.id).length;
    const published = store.definitions.publish(owner, a.id, a.revision);
    assert.deepEqual(store.definitions.publish(owner, a.id, a.revision), published);
    assert.equal(store.definitions.releases(namespace.id).length, before + 1);
    store.definitions.activate(owner, published.release, namespace.generation);
    const stale = store.definitions.validate(b.id);
    assert.equal(stale.valid, false); assert(stale.issues.some(issue => issue.code === 'base_changed'));
    assert.throws(() => store.definitions.publish(owner, b.id, b.revision), errorCode('CONFLICT'));
    assert.deepEqual(store.definitions.active(namespace.id).ref, published.release);
    assert.throws(() => store.definitions.discard(owner, b.id, b.revision - 1), errorCode('CONFLICT'));
  } finally { store.close(); }
});

test('a cached immutable definition still detects a removed or changed durable release', () => {
  const fixture=disk(),store=new JobStore(fixture.path),db=new DatabaseSync(fixture.path);
  try {
    const published=publishManagedFixture(store,owner,'cached.definition'),ref=published.release;
    const cached=store.definitions.resolve(ref);
    assert.equal(store.definitions.resolve(ref),cached);
    // Simulate storage corruption on an isolated fixture; normal writes remain
    // blocked by the immutable-history triggers.
    db.exec('DROP TRIGGER ontology_definition_releases_immutable_update');
    db.prepare('UPDATE ontology_definition_releases SET model_digest=? WHERE id=?').run('0'.repeat(64),ref.releaseId);
    assert.throws(()=>store.definitions.resolve(ref),/exact ontology release is unavailable/);
    db.prepare('UPDATE ontology_definition_releases SET model_digest=? WHERE id=?').run(cached.model.ref.digest,ref.releaseId);
    assert.equal(store.definitions.resolve(ref),cached);
    db.exec('DROP TRIGGER ontology_definition_releases_immutable_delete');
    db.prepare('DELETE FROM ontology_definition_releases WHERE id=?').run(ref.releaseId);
    assert.throws(()=>store.definitions.resolve(ref),/exact ontology release is unavailable/);
  }finally{db.close();store.close();rmSync(fixture.directory,{recursive:true,force:true});}
});

test('separately published siblings cannot overwrite their changed parent and activation retry appends no event', () => {
  const store = new JobStore(':memory:');
  try {
    const namespace = store.definitions.createNamespace(owner, { id: 'parent.definition', name: 'Published siblings' });
    let a = store.definitions.createDraft(owner, namespace.id, 'Candidate A'), b = store.definitions.createDraft(owner, namespace.id, 'Candidate B');
    a = store.definitions.putResource(owner, a.id, a.revision, 'object', object('SiblingA'));
    b = store.definitions.putResource(owner, b.id, b.revision, 'object', object('SiblingB'));
    const r1 = store.definitions.publish(owner, a.id, a.revision).release, r2 = store.definitions.publish(owner, b.id, b.revision).release;
    const active = store.definitions.activate(owner, r1, namespace.generation), events = store.definitions.events(namespace.id, 100);
    assert.deepEqual(store.definitions.activate(owner, r1, namespace.generation), active);
    assert.deepEqual(store.definitions.events(namespace.id, 100), events);
    assert.throws(() => store.definitions.activate(owner, r2, active.generation), /base changed/i);
    assert.deepEqual(store.definitions.active(namespace.id).ref, r1);
    assert.equal(store.definitions.resolve(r2).model.hasType('SiblingB'), true, 'Rejected activation does not destroy its immutable published candidate');
  } finally { store.close(); }
});

test('retirement counts are namespace scoped, only unused types retire, and retired API names cannot be recycled', () => {
  const store = new JobStore(':memory:');
  try {
    store.definitions.createNamespace(owner, { id: 'used.definition', name: 'Has a fact' });
    store.definitions.createNamespace(owner, { id: 'empty.definition', name: 'Same API name, no facts' });
    const a = addObject(store, 'used.definition'), b = addObject(store, 'empty.definition');
    store.ontologyForRelease(a).ingest(owner, { objects: [{ ref: { type: 'OfficeAsset', id: 'asset-1' }, properties: { id: 'asset-1', label: 'Persisted record', status: 'available' } }] }, source);
    let used = store.definitions.createDraft(owner, 'used.definition', 'Retire used type');
    used = store.definitions.retireResource(owner, used.id, used.revision, 'test:object:OfficeAsset');
    assert.equal(store.definitions.validate(used.id).migrationRequired, true);
    assert.throws(() => store.definitions.publish(owner, used.id, used.revision), errorCode('CONFLICT'));
    let empty = store.definitions.createDraft(owner, 'empty.definition', 'Retire unused type');
    empty = store.definitions.retireResource(owner, empty.id, empty.revision, 'test:object:OfficeAsset');
    validated(store, empty);
    const retired = store.definitions.publish(owner, empty.id, empty.revision).release;
    store.definitions.activate(owner, retired, store.definitions.namespace('empty.definition').generation);
    assert.equal(store.definitions.active('empty.definition').model.hasType('OfficeAsset'), false);
    assert.equal(store.definitions.resolve(b).model.hasType('OfficeAsset'), true);
    let recycled = store.definitions.createDraft(owner, 'empty.definition', 'Attempt identity reuse');
    recycled = store.definitions.putResource(owner, recycled.id, recycled.revision, 'object', object('OfficeAsset', 'test:new-resource:OfficeAsset'));
    assert(store.definitions.validate(recycled.id).issues.some(issue => issue.code === 'identity_conflict'));
    assert.throws(() => store.definitions.publish(owner, recycled.id, recycled.revision), errorCode('CONFLICT'));
    let resurrected = store.definitions.createDraft(owner, 'empty.definition', 'Reuse the retired identity with a different primary key');
    const changedIdentity = object(); changedIdentity.primaryKey = 'replacementId'; changedIdentity.properties.replacementId = { ...changedIdentity.properties.id! };
    resurrected = store.definitions.putResource(owner, resurrected.id, resurrected.revision, 'object', changedIdentity);
    assert.equal(store.definitions.validate(resurrected.id).valid, false, 'A retired resource ID/API pair cannot acquire a different identity contract');
    assert.throws(() => store.definitions.publish(owner, resurrected.id, resurrected.revision), errorCode('CONFLICT'));
    assert.equal(store.definitions.active('empty.definition').model.hasType('OfficeAsset'), false);
    assert.equal(store.definitions.resolve(b).model.object('OfficeAsset').primaryKey, 'id', 'Restoring the original resource uses its historical release');
    assert.equal(store.ontologyForRelease(a).read(owner, { type: 'OfficeAsset', id: 'asset-1' }).properties.label, 'Persisted record');
  } finally { store.close(); }
});

test('used link definitions cannot retire even when deleting them would leave valid standalone objects', () => {
  const store = new JobStore(':memory:');
  try {
    const namespace = store.definitions.createNamespace(owner, { id: 'links.definition', name: 'Link lifetime' });
    let draft = store.definitions.createDraft(owner, namespace.id, 'Type and relationship');
    draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', object());
    draft = store.definitions.putResource(owner, draft.id, draft.revision, 'link', { resourceId: 'test:link:AssetPeer', id: 'AssetPeer', description: 'Peer resource', writePolicy: 'managed', from: { type: 'OfficeAsset', name: 'peer', many: false }, to: { type: 'OfficeAsset', name: 'peerOf', many: true } });
    const release = store.definitions.publish(owner, draft.id, draft.revision).release;
    store.definitions.activate(owner, release, namespace.generation);
    const from = { type: 'OfficeAsset', id: 'from' }, to = { type: 'OfficeAsset', id: 'to' };
    const graph = store.ontologyForRelease(release);
    graph.ingest(owner, { objects: [from, to].map(ref => ({ ref, properties: { id: ref.id, label: ref.id, status: 'available' } })), links: [{ type: 'AssetPeer', from, to }] }, source);
    let retire = store.definitions.createDraft(owner, namespace.id, 'Retire used relation');
    retire = store.definitions.retireResource(owner, retire.id, retire.revision, 'test:link:AssetPeer');
    const validation = store.definitions.validate(retire.id);
    assert.equal(validation.valid, false); assert.equal(validation.migrationRequired, true);
    assert.throws(() => store.definitions.publish(owner, retire.id, retire.revision), errorCode('CONFLICT'));
    assert.deepEqual(graph.query(owner, { from, link: 'peer' }).items.map(item => item.ref), [to]);
  } finally { store.close(); }
});

test('unused custom source types may retire while populated source types still require migration', () => {
  const store = new JobStore(':memory:');
  try {
    const namespace = store.definitions.createNamespace(owner, { id: 'source-retirement.definition', name: 'Custom source lifetime' });
    addObject(store, namespace.id, { ...object('UnusedSource'), writePolicy: 'source' });
    const current = addObject(store, namespace.id, { ...object('PopulatedSource'), writePolicy: 'source' });
    store.ontologyForRelease(current).ingest(owner, { objects: [{ ref: { type: 'PopulatedSource', id: 'source-1' }, properties: { id: 'source-1', label: 'Explicit source record', status: 'available' } }] }, { ...source, kind: 'provider' });
    let unused = store.definitions.createDraft(owner, namespace.id, 'Retire unused source');
    unused = store.definitions.retireResource(owner, unused.id, unused.revision, 'test:object:UnusedSource');
    validated(store, unused);
    const retired = store.definitions.publish(owner, unused.id, unused.revision).release;
    store.definitions.activate(owner, retired, store.definitions.namespace(namespace.id).generation);
    assert.equal(store.definitions.active(namespace.id).model.hasType('UnusedSource'), false);
    let populated = store.definitions.createDraft(owner, namespace.id, 'Attempt populated source retirement');
    populated = store.definitions.retireResource(owner, populated.id, populated.revision, 'test:object:PopulatedSource');
    const validation = store.definitions.validate(populated.id);
    assert.equal(validation.valid, false); assert.equal(validation.migrationRequired, true);
    assert.throws(() => store.definitions.publish(owner, populated.id, populated.revision), errorCode('CONFLICT'));
  } finally { store.close(); }
});

test('new actions may restore exact compiler-generated links after old actions retire without reviving business identities', () => {
  const store = new JobStore(':memory:');
  try {
    const fixture = publishManagedFixture(store, owner, 'generated-reuse.definition');
    let retire = store.definitions.createDraft(owner, fixture.ontologyId, 'Retire all old managed actions');
    for (const action of managedFixtureActions) retire = store.definitions.retireResource(owner, retire.id, retire.revision, action.resourceId);
    validated(store, retire);
    const withoutActions = store.definitions.publish(owner, retire.id, retire.revision).release;
    store.definitions.activate(owner, withoutActions, store.definitions.namespace(fixture.ontologyId).generation);
    assert.equal(store.definitions.resolve(withoutActions).model.hasType('OfficeAsset'), true);
    assert.equal(store.definitions.resolve(withoutActions).document.links.filter(link => link.resourceId.startsWith('generated:')).length, 0);
    let next = store.definitions.createDraft(owner, fixture.ontologyId, 'Add a genuinely new action');
    const action = { ...structuredClone(managedFixtureActions[0]!), id: 'CreateNewOfficeAsset', resourceId: 'review:action:CreateNewOfficeAsset' };
    next = store.definitions.putResource(owner, next.id, next.revision, 'action', action);
    validated(store, next);
    const restored = store.definitions.publish(owner, next.id, next.revision).release;
    store.definitions.activate(owner, restored, store.definitions.namespace(fixture.ontologyId).generation);
    const active = store.definitions.resolve(restored), oldLinks = new Map(store.definitions.resolve(fixture.release).document.links.map(link => [link.resourceId, link]));
    const generated = active.document.links.filter(link => link.resourceId.startsWith('generated:'));
    assert(generated.length > 0);
    for (const link of generated) assert.deepEqual(link, oldLinks.get(link.resourceId), 'Only the identical deterministic system relationship may be restored');
    assert.equal(active.model.actionBindingStatus('CreateNewOfficeAsset').state, 'declarative_supported');
    assert.throws(() => active.model.action('CreateOfficeAsset'), /Unknown ontology action/);
    let forged = store.definitions.createDraft(owner, fixture.ontologyId, 'Forge a generated relationship');
    const changed = structuredClone(generated[0]!); changed.from.many = !changed.from.many;
    forged = store.definitions.putResource(owner, forged.id, forged.revision, 'link', changed);
    assert.equal(store.definitions.validate(forged.id).valid, false);
    assert.throws(() => store.definitions.publish(owner, forged.id, forged.revision), errorCode('CONFLICT'));
    assert.deepEqual(store.definitions.active(fixture.ontologyId).ref, restored);
  } finally { store.close(); }
});

test('optional source metadata publishes as unbound while forged trusted action versions cannot publish', () => {
  const store = new JobStore(':memory:');
  try {
    const namespace = store.definitions.createNamespace(owner, { id: 'source.definition', name: 'Source extension' });
    let draft = store.definitions.createDraft(owner, namespace.id, 'Optional source note');
    const hotel = structuredClone(draft.document.objects.find(type => type.id === 'HotelProperty')!);
    hotel.properties.sourceNote = { ...optionalText, source: 'Unbound source claim' };
    draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', hotel);
    const validation = validated(store, draft);
    assert.deepEqual(validation.unboundSourceFields, [{ type: 'HotelProperty', property: 'sourceNote' }]);
    const release = store.definitions.publish(owner, draft.id, draft.revision).release;
    store.definitions.activate(owner, release, namespace.generation);
    assert.equal(store.definitions.resolve(release).model.properties('HotelProperty').sourceNote!.sourceBinding, 'unbound');
    assert.equal(store.definitions.resolve(release).model.objectWritePolicy('HotelProperty'), 'source');
    let forged = store.definitions.createDraft(owner, namespace.id, 'Forge trusted action hash');
    const action = structuredClone(forged.document.actions.find(value => value.id === 'SubmitCommerceOrder')!);
    assert(action.implementation?.kind === 'trusted'); action.implementation.handlerRef.digest = '0'.repeat(64);
    forged = store.definitions.putResource(owner, forged.id, forged.revision, 'action', action);
    assert.equal(store.definitions.validate(forged.id).valid, false);
    assert.throws(() => store.definitions.publish(owner, forged.id, forged.revision), errorCode('CONFLICT'));
    assert.deepEqual(store.definitions.active(namespace.id).ref, release);
  } finally { store.close(); }
});

test('historical writer hashes cannot smuggle newer fields and rollback cannot hide or reinterpret existing facts', () => {
  const fixture = disk(), store = new JobStore(fixture.path);
  try {
    const namespace = store.definitions.createNamespace(owner, { id: 'history.definition', name: 'Writer schema pins' });
    const r1 = addObject(store, namespace.id), old = store.definitions.resolve(r1);
    const type = structuredClone(old.document.objects.find(value => value.id === 'OfficeAsset')!); type.properties.note = optionalText;
    const r2 = editObject(store, namespace.id, type), graph = store.ontologyForRelease(r2), ref = { type: 'OfficeAsset', id: 'new-fact' };
    graph.ingest(owner, { objects: [{ ref, properties: { id: ref.id, label: 'Recorded under R2', status: 'available', note: 'Only present in the R2 schema' } }] }, source);
    const db = new DatabaseSync(fixture.path);
    try { db.prepare('UPDATE ontology_scoped_objects SET definition_digest=? WHERE ontology_id=? AND owner=? AND type=? AND id=?').run(old.model.fingerprint(ref.type), namespace.id, owner, ref.type, ref.id); }
    finally { db.close(); }
    assert.throws(() => graph.read(owner, ref), /definition changed|schema|historical/i);
    const active = store.definitions.namespace(namespace.id);
    assert.throws(() => store.definitions.activate(owner, r1, active.generation), /migration|reinterpret/i);
    assert.throws(() => store.definitions.activate(owner, namespace.active, active.generation), /migration|reinterpret/i);
    assert.deepEqual(store.definitions.active(namespace.id).ref, r2);
    const restored = new DatabaseSync(fixture.path);
    try { restored.prepare('UPDATE ontology_scoped_objects SET definition_digest=? WHERE ontology_id=? AND owner=? AND type=? AND id=?').run(graph.model.fingerprint(ref.type), namespace.id, owner, ref.type, ref.id); }
    finally { restored.close(); }
    assert.equal(graph.read(owner, ref).properties.note, 'Only present in the R2 schema');
    assert.throws(() => store.definitions.activate(owner, r1, active.generation), /migration|reinterpret/i);
  } finally { store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('in-flight jobs retain their original release across activation and prevent retiring their namespace definitions', () => {
  const store = new JobStore(':memory:');
  try {
    const fixture = publishManagedFixture(store, owner, 'pinned.definition'), tasks = new TaskService(store, { catalog: createExecutionCatalog({ store }) });
    const waiting = tasks.submit(principal, { ontologyId: fixture.ontologyId, goal: 'Prepare an internal brief', requestId: randomUUID() });
    const before = digest(store.get(owner, waiting.id).delegation!.request);
    const revised = { ...structuredClone(managedFixtureObject), name: 'New display metadata' };
    const r2 = editObject(store, fixture.ontologyId, revised);
    assert.deepEqual(store.ontologyReleaseForJob(owner, waiting.id), fixture.release);
    assert.equal(store.ontologyForJob(owner, waiting.id).model.object('OfficeAsset').name, managedFixtureObject.name);
    const next = tasks.submit(principal, { ontologyId: fixture.ontologyId, goal: 'Prepare another brief', requestId: randomUUID() });
    assert.deepEqual(store.ontologyReleaseForJob(owner, next.id), r2);
    assert.equal(digest(store.get(owner, waiting.id).delegation!.request), before);
    let retire = store.definitions.createDraft(owner, fixture.ontologyId, 'Retire action while a task is running');
    retire = store.definitions.retireResource(owner, retire.id, retire.revision, 'fixture:action:DeleteOfficeAsset');
    const validation = store.definitions.validate(retire.id);
    assert.equal(validation.valid, false); assert.equal(validation.migrationRequired, true);
    assert.throws(() => store.definitions.publish(owner, retire.id, retire.revision), errorCode('CONFLICT'));
    const forged = structuredClone(waiting); forged.delegation!.ontologyRelease = r2;
    assert.throws(() => store.save(owner, forged), /release is immutable/);
  } finally { store.close(); }
});

test('release, resource history, identity locks and audit tables reject direct update/delete on an independent connection', () => {
  const fixture = disk(), store = new JobStore(fixture.path);
  try {
    const published = publishManagedFixture(store, owner, 'appendonly.definition'), before = store.definitions.resolve(published.release);
    const db = new DatabaseSync(fixture.path);
    try {
      const tables = ['ontology_definition_releases', 'ontology_definition_revisions', 'ontology_definition_names', 'ontology_definition_fingerprints', 'ontology_definition_events', 'ontology_definition_lineage', 'ontology_definition_promotions'];
      for (const table of tables) {
        const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
        assert(count > 0, `${table} must contain a durable record for this test`);
        const column = String(db.prepare(`PRAGMA table_info(${table})`).get()!.name);
        assert.throws(() => db.exec(`UPDATE ${table} SET ${column}=${column}`), /immutable/i, table);
        assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/i, table);
        assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n), count, table);
      }
    } finally { db.close(); }
    assert.deepEqual(store.definitions.resolve(published.release).ref, before.ref);
    assert.deepEqual(store.definitions.resolve(published.release).model.ref, before.model.ref);
  } finally { store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('a rollback to the historical kernel cannot publish managed actions until a compatible kernel is reactivated', () => {
  const store = new JobStore(':memory:');
  try {
    const current = store.definitions.active(), legacy = store.definitions.legacy();
    store.definitions.activate(owner, legacy.ref, store.definitions.namespace().generation, true);
    const draftWithAction = () => {
      let draft = store.definitions.createDraft(owner, 'eigos.business', 'Add a managed action', true);
      draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', managedFixtureObject, true);
      return store.definitions.putResource(owner, draft.id, draft.revision, 'action', managedFixtureActions[0], true);
    };
    const unsupported = draftWithAction(), validation = store.definitions.validate(unsupported.id);
    assert.equal(validation.valid, false); assert(validation.issues.some(issue => issue.code === 'incompatible_kernel'));
    assert.throws(() => store.definitions.publish(owner, unsupported.id, unsupported.revision, true), /kernel supporting managed authorization/);
    assert.deepEqual(store.definitions.active().ref, legacy.ref);
    store.definitions.activate(owner, current.ref, store.definitions.namespace().generation, true);
    const supported = draftWithAction(); assert.equal(store.definitions.validate(supported.id).valid, true);
    const published = store.definitions.publish(owner, supported.id, supported.revision, true);
    store.definitions.activate(owner, published.release, store.definitions.namespace().generation, true);
    const tasks = new TaskService(store, { catalog: createExecutionCatalog({ store }) });
    const prepared = tasks.prepareOntologyAction(principal, { action: 'CreateOfficeAsset', input: { id: 'current-kernel', label: 'Current kernel record' }, requestId: randomUUID() });
    assert.equal(prepared.state, 'auth-required'); assert.equal(prepared.delegation!.authorizationRequest!.environment, 'managed');
  } finally { store.close(); }
});
