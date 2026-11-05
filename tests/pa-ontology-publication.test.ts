import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { paClassifications } from '../packages/ontology/pa-classification-kernel.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { openOntologyMcp } from '../packages/coordinator/ontology-mcp.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { createCurrentKernelDefinition } from '../packages/ontology/seed-definition.js';
import { backend, owner } from './backend-fixture.js';
import { DomainError } from '../packages/core/domain.js';
import { startOntologyManagementFixture } from './fixtures/ontology-management.js';

test('published PA metadata changes new task discovery while old task pins and actual native MCP reads remain valid', async () => {
  const b = backend(createExecutionCatalog()), before = b.submit(), definitions = b.store.definitions;
  const namespace = definitions.namespace(), previous = definitions.active();
  let client: Client | undefined, mcp: Awaited<ReturnType<typeof openOntologyMcp>> | undefined;
  try {
    let draft = definitions.createDraft(owner, namespace.id, 'PA discovery classification', true);
    for (const type of previous.document.objects) draft = definitions.putResource(owner, draft.id, draft.revision, 'object', { ...type, classification: paClassifications[type.id] }, true);
    assert.equal(definitions.active().ref.releaseId, previous.ref.releaseId, 'Editing a draft never changes active tasks');
    const validation = definitions.validate(draft.id);
    assert.equal(validation.valid, true, JSON.stringify(validation.issues)); assert.equal(validation.migrationRequired, false);
    const published = definitions.publish(owner, draft.id, draft.revision, true);
    assert.equal(definitions.active().ref.releaseId, previous.ref.releaseId, 'Publication is separate from activation');
    definitions.activate(owner, published.release, namespace.generation, true);
    const after = b.submit(), graph = b.store.ontologyForJob(owner, after);
    assert.equal(b.store.ontologyForJob(owner, before).model.ref.digest, previous.model.ref.digest);
    assert.notEqual(graph.model.ref.digest, previous.model.ref.digest);
    assert.deepEqual(b.store.ontologyForJob(owner, before).read(owner, { type: 'ServiceRequest', id: before.id }).properties.originalGoal, before.goal);
    assert.throws(() => graph.read('another-owner', { type: 'ServiceRequest', id: after.id }));
    let active = true;
    const session = new OntologyPlanningSession(graph, owner, after.delegation!.request, [], () => { if (!active) throw new DomainError('FORBIDDEN', 'Expired synthetic task claim'); });
    mcp = await openOntologyMcp(session, new AbortController().signal);
    client = new Client({ name: 'pa-classification-native-fixture', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.connection.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.connection.token}` } } }));
    const tools = await client.listTools(), describe = tools.tools.find(tool => tool.name === 'describe_ontology');
    assert(describe); assert(Reflect.get(describe.inputSchema.properties!, 'view')); assert(Reflect.get(describe.inputSchema.properties!, 'domains'));
    const call = async (args: Record<string, unknown>) => {
      const response = await client!.callTool({ name: 'describe_ontology', arguments: args });
      assert(!response.isError, JSON.stringify(response));
      const result = response.structuredContent as { result: { result?: unknown; data?: unknown; types?: { id: string }[]; hasMore?: boolean; next?: string } };
      // Native task MCP returns the session result directly inside its result envelope.
      const wrapped = result.result;
      const page = (wrapped.data ?? wrapped.result ?? wrapped) as { types: { id: string }[]; next?: string };
      assert(Array.isArray(page.types), JSON.stringify(wrapped));
      return page;
    };
    const hotel = await call({ domains: ['hotel'], search: 'HotelProperty', limit: 5, includeLinks: false });
    assert.deepEqual(hotel.types.map(type => type.id), ['HotelProperty']);
    const unrelated = await call({ view: 'pa', domains: ['hotel'], search: 'Hospital', includeLinks: false });
    assert.deepEqual(unrelated.types, []);
    const support = await call({ search: 'RollingGoSearchTask', limit: 1 });
    assert(JSON.stringify(support).includes('RollingGoSearchTask'));
    assert(session.receipts().every(receipt => receipt.status === 'ok'));
    active = false;
    const expired = await client.callTool({ name: 'describe_ontology', arguments: { view: 'all' } });
    assert.equal(expired.isError, true);
  } finally { await client?.close(); await mcp?.close(); b.store.close(); }
});

test('HTTP and Gateway MCP accept the same classified definition and view selectors under existing namespace ownership', async () => {
  const f = await startOntologyManagementFixture();
  try {
    const namespace = await f.http('/ontology/v1/commands', { operation: 'create_ontology', id: 'pa.fixture', name: 'PA classification fixture' });
    const previous = createCurrentKernelDefinition();
    let draft = await f.http('/ontology/v1/commands', { operation: 'create_draft', ontologyId: namespace.id, title: 'Classify one custom namespace definition' });
    const hotel = previous.document.objects.find(type => type.id === 'HotelProperty')!;
    draft = await f.http('/ontology/v1/commands', { operation: 'put_definition', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision, kind: 'object', definition: { ...hotel, classification: paClassifications.HotelProperty } });
    const validation = await f.http('/ontology/v1/query', { operation: 'validate_draft', ontologyId: namespace.id, draftId: draft.id });
    assert.equal(validation.valid, true, JSON.stringify(validation));
    const published = await f.http('/ontology/v1/commands', { operation: 'publish_draft', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision });
    await f.http('/ontology/v1/commands', { operation: 'activate_release', ontologyId: namespace.id, release: published.release, expectedGeneration: namespace.generation });
    const args = { ontologyId: namespace.id, view: 'pa', domains: ['hotel'], search: 'HotelProperty', limit: 1 };
    const http = await f.post('/ontology/describe', args); assert.equal(http.status, 200);
    await f.connect(); const native = await f.mcp('describe_ontology', args);
    assert.deepEqual(native, http.value);
    const hidden = await f.post('/ontology/describe', args, 'bob'); assert.equal(hidden.status, 403);
  } finally { await f.close(); }
});
