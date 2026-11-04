import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { ontologyManagerPage, ontologyManagerScript } from '../apps/gateway/ontology/page.js';
import { workbenchEntries, workbenchRelations, workbenchSummary } from '../packages/ontology/definition-workbench.js';
import type { OntologyDocument } from '../packages/ontology/definition-contracts.js';
import { startOntologyManagementFixture, officeManagementResources } from './fixtures/ontology-management.js';

test('HTTP and MCP expose version-bound Functions, source dependencies and bounded relation navigation', async () => {
  const f = await startOntologyManagementFixture();
  try {
    await f.connect();
    const namespace = await f.http('/ontology/v1/query', { operation: 'get_ontology' });
    const source = { ontologyId: namespace.id, release: namespace.active };
    const summary = await f.mcp('query_ontology_definitions', { operation: 'workspace_summary', ...source });
    const document = f.gateway.store.definitions.resolve(namespace.active).document;
    assert.deepEqual(summary.counts, workbenchSummary(document).counts);
    assert.equal(summary.functionContract, 'input_types_and_handler_only');
    assert.equal(summary.sourceOperations, document.actions.filter(action => action.read?.mcp).length);
    const first = await f.http('/ontology/v1/query', { operation: 'list_definitions', ...source, kind: 'function', limit: 1 });
    const second = await f.mcp('query_ontology_definitions', { operation: 'list_definitions', ...source, kind: 'function', limit: 1, offset: 1 });
    assert(first.page.hasMore); assert.equal(first.total, document.functions.length); assert.notEqual(first.items[0].id, second.items[0].id);
    const fn = await f.mcp('query_ontology_definitions', { operation: 'get_definition', ...source, kind: 'function', resourceId: 'function:selectDidiPlace' });
    assert.equal(fn.readOnly, true); assert.equal(fn.definition.id, 'selectDidiPlace'); assert(fn.definition.inputTypes.length);
    assert.deepEqual(fn.definition.handlerRef, document.functions.find(value => value.id === 'selectDidiPlace')!.handlerRef);
    assert.deepEqual(fn.release, namespace.active); assert.equal('availability' in fn, false);
    const action = workbenchEntries(document).find(value => value.kind === 'action' && value.definition.id === 'EstimateDidiRide')!;
    const args = { operation: 'list_definition_relations', ...source, kind: 'action', resourceId: action.definition.resourceId };
    const edges = await f.http('/ontology/v1/query', { ...args, limit: 50 });
    assert(edges.items.some((edge: any) => edge.to.id === 'selectDidiPlace' && edge.role === 'derive:origin'));
    assert(edges.items.some((edge: any) => edge.to.id === 'SearchDidiPlaces' && edge.role === 'requires:destination'));
    const narrow = await f.http('/ontology/v1/query', { ...args, limit: 1, search: 'derive:origin' });
    assert.equal(narrow.total, 1); assert.equal(narrow.items[0].to.kind, 'function'); assert.equal(narrow.page.hasMore, false);
    const page1 = await f.http('/ontology/v1/query', { ...args, limit: 1 }), page2 = await f.http('/ontology/v1/query', { ...args, limit: 1, offset: 1 });
    assert(page1.page.hasMore); assert.deepEqual(page1.release, page2.release); assert.notDeepEqual(page1.items[0], page2.items[0]);
    const reverse = await f.http('/ontology/v1/query', { operation: 'list_definition_relations', ...source, kind: 'function', resourceId: fn.definition.resourceId, limit: 50 });
    assert(reverse.items.some((edge: any) => edge.from.id === 'EstimateDidiRide'));
    assert.equal(new Set(workbenchRelations(document).map(edge => JSON.stringify(edge))).size, workbenchRelations(document).length);
  } finally { await f.close(); }
});

test('workbench reads preserve namespace ownership, immutable history, draft isolation and Function write restrictions', async () => {
  const f = await startOntologyManagementFixture();
  try {
    const namespace = await f.http('/ontology/v1/commands', { operation: 'create_ontology', name: 'Private model' });
    const source = { ontologyId: namespace.id, release: namespace.active };
    const original = await f.http('/ontology/v1/query', { operation: 'workspace_summary', ...source });
    let draft = await f.http('/ontology/v1/commands', { operation: 'create_draft', ontologyId: namespace.id, title: 'Add internal room' });
    draft = await f.http('/ontology/v1/commands', { operation: 'put_definition', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision, ...officeManagementResources[2] });
    const candidate = await f.http('/ontology/v1/query', { operation: 'workspace_summary', ontologyId: namespace.id, draftId: draft.id });
    assert.equal(candidate.publication, 'draft'); assert.equal(candidate.counts.object, original.counts.object + 1);
    assert.deepEqual((await f.http('/ontology/v1/query', { operation: 'workspace_summary', ...source })).counts, original.counts);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'workspace_summary', ...source }, 'bob')).status, 403);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'workspace_summary', ...source }, '')).status, 401);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'workspace_summary', ...source }, 'taskOnly')).status, 403);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'workspace_summary', ...source, draftId: draft.id })).status, 400);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'workspace_summary', ...source, release: { ...namespace.active, ontologyId: 'eigos.business' } })).status, 400);
    const related = { operation: 'list_definition_relations', ontologyId: namespace.id, draftId: draft.id, kind: 'object', resourceId: 'office:object:OfficeRequest' };
    assert.equal((await f.post('/ontology/v1/query', related, 'bob')).status, 403);
    assert.equal((await f.post('/ontology/v1/query', { ...related, release: namespace.active, draftId: undefined })).status, 404);
    assert.equal((await f.post('/ontology/v1/commands', { operation: 'put_definition', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision, kind: 'function', definition: { id: 'untrusted' } })).status, 400);
    assert.equal((await f.post('/ontology/v1/commands', { operation: 'retire_definition', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision, resourceId: 'function:selectDidiPlace' })).status, 404);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'list_definition_relations', ...source, kind: 'function', resourceId: 'function:selectDidiPlace', limit: 51 })).status, 400);
    assert.equal(f.gateway.store.definitions.draft(draft.id).revision, draft.revision);
  } finally { await f.close(); }
});

test('interface Action contracts retain input and result roles in dependency navigation', () => {
  const document: OntologyDocument = { formatVersion: 1, id: 'test', version: '1', objects: [], links: [], actions: [], functions: [], interfaces: [
    { resourceId: 'test:resource', id: 'Resource', description: 'A requested resource', properties: {}, actions: [{ id: 'RequestUse', inputs: { resource: 'Resource' }, effects: ['object_write'], resultTypes: ['UseRequest'] }] },
    { resourceId: 'test:request', id: 'UseRequest', description: 'A resource use request', properties: {} },
  ] };
  const edges = workbenchRelations(document);
  assert(edges.some(edge => edge.from.id === 'Resource' && edge.to.id === 'Resource' && edge.role === 'input:RequestUse.resource'));
  assert(edges.some(edge => edge.from.id === 'Resource' && edge.to.id === 'UseRequest' && edge.role === 'result:RequestUse'));
});

test('static workbench compiles and keeps untrusted metadata and credentials out of HTML and persistent browser storage', () => {
  new Script(ontologyManagerScript);
  const html = ontologyManagerPage();
  assert.match(html, /Ontology 中台/); assert.match(html, /data-kind="function"/);
  assert(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage/.test(ontologyManagerScript));
  assert(!html.includes('EstimateDidiRide')); assert(!html.includes('Bearer '));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const match of html.matchAll(/aria-controls="([^"]+)"/g)) assert(ids.includes(match[1]));
});
