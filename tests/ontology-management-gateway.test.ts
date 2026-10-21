import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Coordinator, type Reasoner } from '../packages/coordinator/coordinator.js';
import { startOntologyManagementFixture, installOfficeManagementFixture, officeManagementResources } from './fixtures/ontology-management.js';

const noModel: Reasoner = { ground: async () => { throw new Error('Explicit API action must preserve caller origin'); }, plan: async () => { throw new Error('No model execution in metadata fixture'); }, act: async () => { throw new Error('No model execution in metadata fixture'); } };

test('HTTP and MCP create all four definition kinds and execute polymorphic actions without server restart', async () => {
  const f = await startOntologyManagementFixture();
  try {
    await f.connect(); const installed = await installOfficeManagementFixture(f, true), ontologyId = installed.namespace.id;
    for (const kind of ['object', 'interface', 'link', 'action']) {
      const page = await f.mcp('query_ontology_definitions', { operation: 'list_definitions', ontologyId, kind, customOnly: true, limit: 2 }); assert(page.items.length > 0 && page.items.length <= 2);
    }
    const concrete = await f.http('/ontology/v1/query', { operation: 'get_definition', ontologyId, kind: 'action', resourceId: 'office:action:RequestOfficeRoom' });
    assert.equal(concrete.publication, 'published'); assert.equal(concrete.availability.status, 'executable');
    const iface = await f.http('/ontology/v1/query', { operation: 'get_definition', ontologyId, kind: 'interface', resourceId: 'office:interface:OfficeResource' }); assert(iface.dependencies.includes('OfficeRequest'));
    const source = await f.http('/ontology/v1/query', { operation: 'get_definition', ontologyId, kind: 'action', resourceId: 'builtin:eigos.business:action:ReadSavedAddresses' });
    assert.equal(source.publication, 'published'); assert.equal(source.availability.status, 'handler_unavailable');
    const coordinator = new Coordinator(f.gateway.store, noModel, f.gateway.catalog);
    async function execute(selection: object, input: object) {
      const args = { ontologyId, ...selection, input, requestId: randomUUID() };
      const prepared = await f.mcp('prepare_ontology_action', args); assert.equal(prepared.task.state, 'auth-required'); assert.equal(prepared.task.counts.modelRuns, 0);
      assert.equal('maxAmount' in prepared.preview.scope, false);
      const authorization = prepared.task.delegation.authorizationRequest;
      const approved = await f.http('/ontology/v1/actions/approve', { taskId: prepared.task.id, requestId: randomUUID(), planDigest: authorization.planDigest, objectWrite: authorization.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString() }); assert.equal(approved.task.state, 'submitted');
      const claim = f.gateway.store.claim(['eigos.delegate'], 15000); assert(claim); await coordinator.run(claim, new AbortController().signal);
      const done = await f.mcp('query_ontology_definitions', { operation: 'get_action_task', ontologyId, taskId: prepared.task.id }); assert.equal(done.task.state, 'completed', JSON.stringify(done)); assert.equal(done.task.delegation.acceptance.accepted, true);
      const repeated = await f.http('/ontology/v1/actions/prepare', args); assert.equal(repeated.task.id, done.task.id); assert.equal(repeated.task.state, 'completed'); assert.equal(repeated.preview.status, 'committed');
      return done.task;
    }
    await execute({ action: 'CreateOfficeRoom' }, { id: 'room-a', label: '北侧会议室' });
    await execute({ action: 'CreateOfficeEquipment' }, { id: 'camera-a', label: '相机' });
    await execute({ action: 'RenameOfficeRoom' }, { room: { type: 'OfficeRoom', id: 'room-a' }, expectedRevision: 1, label: '北侧会议室 · 可借用' });
    for (const [type, id, requestId] of [['OfficeRoom', 'room-a', 'request-room'], ['OfficeEquipment', 'camera-a', 'request-camera']]) {
      const resource = { type, id };
      const done = await execute({ interface: { object: resource, interfaceId: 'OfficeResource', actionId: 'RequestUse' } }, { resource, id: requestId, label: '内部使用申请' });
      const forward = await f.post('/ontology/query', { taskId: done.id, from: { type: 'OfficeRequest', id: requestId }, link: 'resource' }); assert.equal(forward.status, 200); assert.deepEqual(forward.value.items[0].ref, resource);
      const reverse = await f.client.callTool({ name: 'query_ontology', arguments: { ontologyId, from: resource, link: 'requests' } }); assert(!reverse.isError); assert.equal((reverse.structuredContent as any).result.items[0].ref.id, requestId);
    }
    const history = await f.mcp('query_ontology_definitions', { operation: 'history', ontologyId }); assert(history.items.some((item: any) => item.kind === 'published')); assert(history.items.some((item: any) => item.kind === 'activated'));
  } finally { await f.close(); }
});

test('metadata access checks owner and separate scopes before exposing private counts, drafts or releases', async () => {
  const f = await startOntologyManagementFixture();
  try {
    const namespace = await f.http('/ontology/v1/commands', { operation: 'create_ontology', name: 'Private office' });
    const draft = await f.http('/ontology/v1/commands', { operation: 'create_draft', ontologyId: namespace.id, title: 'Private review title' });
    assert.equal((await f.post('/ontology/v1/query', { operation: 'list_ontologies' }, '')).status, 401);
    const bobList = await f.http('/ontology/v1/query', { operation: 'list_ontologies' }, 'bob'); assert(!bobList.items.some((item: any) => item.id === namespace.id));
    for (const operation of ['get_ontology', 'list_definitions', 'list_drafts', 'list_releases', 'history']) assert.equal((await f.post('/ontology/v1/query', { operation, ontologyId: namespace.id }, 'bob')).status, 403);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'get_draft', ontologyId: namespace.id, draftId: draft.id }, 'bob')).status, 403);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'get_release', ontologyId: namespace.id, release: namespace.active }, 'bob')).status, 403);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'list_ontologies' }, 'taskOnly')).status, 403);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'list_ontologies' }, 'adminOnly')).status, 403, 'Admin does not imply read scope');
    assert.equal((await f.post('/ontology/v1/commands', { operation: 'create_draft', ontologyId: 'eigos.business', title: 'Cannot edit shared default' })).status, 403);
    assert.equal((await f.post('/ontology/v1/commands', { operation: 'create_draft', ontologyId: namespace.id, title: 'Read only' }, 'reader')).status, 403);
    assert.equal((await f.post('/ontology/v1/commands', { operation: 'publish_draft', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision }, 'editor')).status, 403);
    assert.equal((await f.http('/ontology/v1/query', { operation: 'validate_draft', ontologyId: namespace.id, draftId: draft.id }, 'publisher')).valid, true, 'A publisher can inspect the pure publication preflight without draft edit authority');
    const published = await f.http('/ontology/v1/commands', { operation: 'publish_draft', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision }, 'publisher'); assert(published.release);
    const bobSpace = await f.http('/ontology/v1/commands', { operation: 'create_ontology', name: 'Bob office' }, 'bob');
    const wrongDraft = await f.post('/ontology/v1/query', { operation: 'get_draft', ontologyId: bobSpace.id, draftId: draft.id }, 'bob'); assert.equal(wrongDraft.status, 404); assert(!JSON.stringify(wrongDraft.value).includes(draft.title));
  } finally { await f.close(); }
});

test('invalid drafts and stale revisions fail atomically and generated execution links are read-only', async () => {
  const f = await startOntologyManagementFixture();
  try {
    await f.connect(); const installed = await installOfficeManagementFixture(f), ontologyId = installed.namespace.id;
    let draft = await f.http('/ontology/v1/commands', { operation: 'create_draft', ontologyId, title: 'Invalid endpoint experiment' });
    const oldRevision = draft.revision;
    draft = await f.http('/ontology/v1/commands', { operation: 'put_definition', ontologyId, draftId: draft.id, expectedRevision: draft.revision, kind: 'link', definition: { resourceId: 'office:link:Broken', id: 'Broken', description: 'Missing endpoint', from: { type: 'OfficeRoom', name: 'broken', many: true }, to: { type: 'MissingType', name: 'rooms', many: true }, writePolicy: 'managed' } });
    const stale = await f.post('/ontology/v1/commands', { operation: 'put_definition', ontologyId, draftId: draft.id, expectedRevision: oldRevision, ...officeManagementResources[0] }); assert.equal(stale.status, 409);
    const validation = await f.mcp('query_ontology_definitions', { operation: 'validate_draft', ontologyId, draftId: draft.id }); assert.equal(validation.valid, false);
    const failed = await f.post('/ontology/v1/commands', { operation: 'publish_draft', ontologyId, draftId: draft.id, expectedRevision: draft.revision }); assert.equal(failed.status, 409);
    assert.deepEqual((await f.http('/ontology/v1/query', { operation: 'get_ontology', ontologyId })).active, installed.release);
    const links = await f.http('/ontology/v1/query', { operation: 'list_definitions', ontologyId, kind: 'link', search: 'OfficeRoom', limit: 50 });
    const generated = links.items.find((item: any) => item.resourceId.startsWith('generated:')); assert(generated); assert.equal(generated.readOnly, true);
    assert.equal((await f.post('/ontology/v1/commands', { operation: 'retire_definition', ontologyId, draftId: draft.id, expectedRevision: draft.revision, resourceId: generated.resourceId })).status, 403);
    const page = await fetch(f.base + '/ontology/manager'); assert.equal(page.status, 200); assert.match(page.headers.get('Content-Security-Policy')!, /script-src 'self'/);
    const script = await fetch(f.base + '/ontology/manager.js').then(response => response.text()); assert(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage/.test(script));
    assert.equal((await f.post('/ontology/v1/commands', { operation: 'create_ontology', name: 'x', padding: 'x'.repeat(49000) })).status, 400);
    assert.equal((await f.post('/ontology/query', { type: 'OfficeRoom', padding: 'x'.repeat(66000) })).status, 413, 'Business body bound was not broadened');
  } finally { await f.close(); }
});

test('metadata HTTP and MCP reuse active membership and connection checks', async () => {
  const f = await startOntologyManagementFixture('jwt');
  try {
    assert.equal((await f.post('/ontology/v1/query', { operation: 'list_ontologies' })).status, 403);
    const member = f.gateway.members.login(f.people.alice!); f.gateway.members.apply(member.id, { displayName: 'Model author', locale: 'zh-CN', timezone: 'Asia/Shanghai', consent: true }, false);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'list_ontologies' })).status, 200); await f.connect();
    const visible = await f.mcp('query_ontology_definitions', { operation: 'list_ontologies' }); assert(visible.items.length);
    f.gateway.members.setStatus(member.id, 'suspended');
    assert.equal((await f.post('/ontology/v1/query', { operation: 'list_ontologies' })).status, 403);
    await assert.rejects(f.client.callTool({ name: 'query_ontology_definitions', arguments: { operation: 'list_ontologies' } }), /403|membership|Forbidden/i);
  } finally { await f.close(); }
});

test('draft and release history pages expose bounded summaries and real continuation', async () => {
  const f = await startOntologyManagementFixture();
  try {
    let namespace = await f.http('/ontology/v1/commands', { operation: 'create_ontology', name: 'Paged metadata' });
    for (let index = 0; index < 2; index++) {
      const draft = await f.http('/ontology/v1/commands', { operation: 'create_draft', ontologyId: namespace.id, title: 'Review ' + index });
      const published = await f.http('/ontology/v1/commands', { operation: 'publish_draft', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision });
      namespace = await f.http('/ontology/v1/commands', { operation: 'activate_release', ontologyId: namespace.id, release: published.release, expectedGeneration: namespace.generation });
    }
    await f.http('/ontology/v1/commands', { operation: 'create_draft', ontologyId: namespace.id, title: 'Pending review' });
    for (const operation of ['list_drafts', 'list_releases']) {
      const first = await f.http('/ontology/v1/query', { operation, ontologyId: namespace.id, limit: 1, offset: 0 });
      const second = await f.http('/ontology/v1/query', { operation, ontologyId: namespace.id, limit: 1, offset: 1 });
      assert.equal(first.total, 3); assert.equal(first.items.length, 1); assert.equal(first.page.hasMore, true); assert.equal(second.items.length, 1);
      assert.notDeepEqual(first.items[0], second.items[0]); assert.equal('document' in first.items[0], false);
    }
  } finally { await f.close(); }
});
