import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import type { AgentProgram } from '../packages/core/agent-program.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import { digest } from '../packages/core/delegation.js';
import { compileOntologyDocument, TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import type { OntologyDocument, SerializableObjectType } from '../packages/ontology/definition-contracts.js';
import type { ActionDefinition } from '../packages/ontology/model.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { DefinitionService } from '../packages/ontology/definition-service.js';
import { principal } from './backend-fixture.js';

const request: ServiceRequest = { id: 'task-1', revision: 1, originalGoal: 'Compare two sources', requirements: [], messages: [] };
function fixture(extraPrograms = 0) {
  const db = new DatabaseSync(':memory:'), registry = new TrustedDefinitionRegistry();
  const object = (id: string): SerializableObjectType => ({ resourceId: `test:object:${id}`, id, version: '1', name: id, description: id, aliases: [], primaryKey: 'id', titleKey: 'id', writePolicy: 'source', properties: {
    id: { kind: 'string', description: 'Identity', source: 'Owned fixture', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } },
    ...(id === 'ServiceRequest' ? { revision: { kind: 'integer' as const, description: 'Request revision', source: 'Owned fixture', required: true, schema: { type: 'integer', minimum: 1 } } } : {}),
  } });
  const schema = z.strictObject({ scope: z.strictObject({ type: z.literal('ServiceRequest'), id: z.string().min(1).max(200) }) });
  const action = (id: string): ActionDefinition => ({ id, version: '1', kind: 'source_read', description: `Read observed quotes with ${id}`, inputs: { scope: 'ServiceRequest' }, effects: ['read'], resultTypes: ['Quote'], changes: ['Quote'], submissionCriteria: ['owned_request'], read: { effect: 'read', version: '1', resultType: 'Quote', inputSchema: z.toJSONSchema(schema) },
    composition: { version: '1', inputs: { scope: { kind: 'object', type: 'ServiceRequest', cardinality: 'one', semantics: { role: 'request', phase: 'request' }, evidence: { origins: ['user'] } } }, outputs: { quote: { kind: 'object', type: 'Quote', cardinality: 'one', semantics: { role: 'quote', phase: 'quote' }, evidence: { origins: ['provider'] } } }, checks: [], effectScope: { effects: ['read'], targetInputs: [], recovery: { kind: 'none' }, compensation: [] } },
  });
  const document: OntologyDocument = { formatVersion: 1, id: 'test.discovery', version: '1', objects: ['ServiceRequest', 'Quote'].map(object), interfaces: [], links: [], functions: [],
    actions: ['ReadA', 'ReadB', 'ReadC'].map(id => { const value = action(id); return { ...value, resourceId: `test:action:${id}`, implementation: { kind: 'trusted', handlerRef: registry.registerAction(value) } }; }),
  };
  const model = compileOntologyDocument(document, registry), release = { ontologyId: document.id, releaseId: 'release-1', digest: digest(document) };
  const graph = new OntologyObjectStore(db, model, Date.now, undefined, { ontologyId: document.id, releaseRef: release });
  graph.ingest('alice', { objects: [{ ref: { type: 'ServiceRequest', id: request.id }, properties: { id: request.id, revision: 1 } }] }, { kind: 'synthetic', id: 'discovery-fixture', observedAt: new Date().toISOString() });
  const flags = { permitted: true, connected: true, digest: 'a'.repeat(64), invokes: 0 };
  const program = (id: string, environment: 'local' | 'sandbox' = 'local'): AgentProgram => ({
    ref: { id, version: '1' }, get configurationDigest() { return flags.digest; }, actionIds: ['ReadA', 'ReadB', 'ReadC'], guidance: 'Synthetic metadata only', completionSchema: {},
    permitted: owner => flags.permitted && owner === 'alice', sourceAuthorization: () => ({ provider: 'fixture', state: flags.connected ? 'connected' : 'revoked', nextAction: flags.connected ? 'continue' : 'connect' }),
    capability: () => ({ ref: { id, version: '1' }, ontologyRef: { id: 'test.discovery', version: '1' }, name: id, description: 'Synthetic source', tags: [], inputSchema: z.toJSONSchema(z.strictObject({})), ontology: {}, actions: [{ ref: { id: 'ReadA', version: '1' }, effect: 'read' }], predicates: [], verifierRef: { id: 'fixture', version: '1' }, environment }),
    initialize: () => ({ scope: { type: 'ServiceRequest', id: request.id }, input: {} }), schema: () => schema,
    definition: (graph, id) => graph.model.action(id), validate: () => {},
    invoke: async () => { flags.invokes++; throw new Error('Discovery must never invoke sources'); }, project: () => { throw new Error('Discovery must not project facts'); }, complete: () => { throw new Error('Discovery is not completion'); },
  });
  const programs = [program('source.one'), program('source.two'), program('sandbox.source', 'sandbox'), ...Array.from({ length: extraPrograms }, (_, index) => program(`extra.source.${index}`))];
  const catalog = new ExecutionCatalog(programs.map(program => program.capability()), [], [], [], programs);
  return { db, graph, catalog, flags };
}

test('one action has distinct versioned bindings and discovery performs no provider calls', () => {
  const f = fixture(); try {
    const page = f.catalog.discoverActions(f.graph, 'alice', request, { actionId: 'ReadA' });
    assert.equal(page.items.length, 1); assert.equal(page.items[0]!.bindings.length, 2);
    const [a, b] = page.items[0]!.bindings;
    assert.notEqual(a!.pin.ref.id, b!.pin.ref.id); assert.notEqual(a!.pin.digest, b!.pin.digest);
    assert.equal(page.items[0]!.status, 'available'); assert.equal(page.authorization, 'per_action_required');
    assert.equal(f.catalog.resolveActionBinding(f.graph, 'alice', request, a!.pin).program.ref.id, a!.pin.programRef.id);
    assert.equal(f.flags.invokes, 0);
    const sandbox = f.catalog.discoverActions(f.graph, 'alice', { ...request, executionEnvironment: 'sandbox' }, { actionId: 'ReadA' });
    assert.equal(sandbox.items[0]!.bindings.length, 3);
  } finally { f.db.close(); }
});

test('typed discovery uses explicit pages and rejects cursors after permission or configuration changes', () => {
  const f = fixture(); try {
    const first = f.catalog.discoverActions(f.graph, 'alice', request, { inputType: 'ServiceRequest', outputType: 'Quote', effects: ['read'], limit: 1 });
    assert.deepEqual(first.items.map(item => item.action.id), ['ReadA']); assert(first.page.hasMore);
    const second = f.catalog.discoverActions(f.graph, 'alice', request, { inputType: 'ServiceRequest', outputType: 'Quote', effects: ['read'], limit: 1, cursor: first.page.cursor });
    assert.deepEqual(second.items.map(item => item.action.id), ['ReadA']);
    assert.notEqual(second.items[0]!.bindings[0]!.pin.digest, first.items[0]!.bindings[0]!.pin.digest);
    assert.throws(() => f.catalog.discoverActions(f.graph, 'alice', request, { search: 'other', cursor: first.page.cursor }), /cursor/);
    f.flags.digest = 'b'.repeat(64);
    assert.throws(() => f.catalog.discoverActions(f.graph, 'alice', request, { inputType: 'ServiceRequest', outputType: 'Quote', effects: ['read'], limit: 1, cursor: first.page.cursor }), /cursor/);
    const fresh = f.catalog.discoverActions(f.graph, 'alice', request, { limit: 1 }); f.flags.permitted = false;
    assert.throws(() => f.catalog.discoverActions(f.graph, 'alice', request, { limit: 1, cursor: fresh.page.cursor }), /cursor/);
    assert(f.catalog.discoverActions(f.graph, 'alice', request, {}).items.every(item => item.bindings.length === 0));
  } finally { f.db.close(); }
});

test('old pins cannot cross owners, revisions, environments, configurations or revoked sources', () => {
  const f = fixture(); try {
    const pin = f.catalog.discoverActions(f.graph, 'alice', request, { actionId: 'ReadA' }).items[0]!.bindings[0]!.pin;
    assert.throws(() => f.catalog.resolveActionBinding(f.graph, 'bob', request, pin), /owned task/);
    assert.throws(() => f.catalog.resolveActionBinding(f.graph, 'alice', { ...request, revision: 2 }, pin), /owned task/);
    assert.throws(() => f.catalog.resolveActionBinding(f.graph, 'alice', request, { ...pin, programRef: { id: 'source.other', version: '1' } }), /owned task/);
    f.flags.connected = false;
    assert.equal(f.catalog.discoverActions(f.graph, 'alice', request, { actionId: 'ReadA' }).items[0]!.bindings[0]!.readiness, 'source_authorization_required');
    assert.throws(() => f.catalog.resolveActionBinding(f.graph, 'alice', request, pin), /source authorization/);
    f.flags.connected = true; f.flags.digest = 'b'.repeat(64);
    assert.throws(() => f.catalog.resolveActionBinding(f.graph, 'alice', request, pin), /unavailable/);
    f.flags.digest = 'a'.repeat(64);
    const sandboxPin = f.catalog.discoverActions(f.graph, 'alice', { ...request, executionEnvironment: 'sandbox' }, { actionId: 'ReadA' }).items[0]!.bindings.find(binding => binding.environment === 'sandbox')!.pin;
    assert.throws(() => f.catalog.resolveActionBinding(f.graph, 'alice', request, sandboxPin), /unavailable/);
    f.flags.permitted = false;
    assert.throws(() => f.catalog.resolveActionBinding(f.graph, 'alice', request, pin), /unavailable/);
    assert.equal(f.flags.invokes, 0);
  } finally { f.db.close(); }
});

test('the planning tool records only actually delivered bindings within the normal read budget', () => {
  const f = fixture(); try {
    const session = new OntologyPlanningSession(f.graph, 'alice', request, [], undefined, undefined, 'request', [], { actionCatalog: f.catalog });
    assert(session.catalog().tools.some(tool => tool.name === 'discover_actions'));
    const page = session.call('discover_actions', { actionId: 'ReadA' }) as ActionDiscoveryPage;
    const receipt = session.lastReceipt()!;
    assert.equal(receipt.status, 'ok'); assert.equal(receipt.outputDigest, digest(page));
    assert.deepEqual(receipt.actionBindings!.pins, page.items[0]!.bindings.map(binding => binding.pin));
    session.call('discover_actions', { cursor: 'malformed' });
    assert.equal(session.lastReceipt()!.status, 'rejected'); assert.equal(session.lastReceipt()!.actionBindings, undefined);
  } finally { f.db.close(); }
});

test('PA discovery uses the same task ownership and ontology access boundary as task readback', () => {
  const store = new JobStore(':memory:'), catalog = new ExecutionCatalog([], [], []), tasks = new TaskService(store, { catalog });
  const service = new DefinitionService(store, tasks, catalog);
  try {
    const job = tasks.submit(principal, { service: 'eigos.delegate', goal: 'Read a catalog', requestId: 'discover-task' });
    const query = { operation: 'discover_task_actions', ontologyId: 'eigos.business', taskId: job.id, query: { actionId: 'SearchPublicCatalog' } };
    const result = service.query(principal, query) as { result: ActionDiscoveryPage };
    assert.equal(result.result.requestId, job.id); assert.equal(result.result.items[0]!.action.id, 'SearchPublicCatalog');
    assert.equal(result.result.items[0]!.status, 'binding_unavailable');
    assert.throws(() => service.query({ ...principal, subject: 'another-user' }, query), /not found|not available/i);
    assert.throws(() => service.query({ ...principal, scopes: ['tasks:read'] }, query), /scope/i);
  } finally { store.close(); }
});


test('bounded bootstrap and binding pagination can discover a service omitted after the sixteenth entry', () => {
  const f = fixture(20);
  try {
    const page = f.catalog.summaryPage('alice', 16);
    assert.equal(page.items.length, 16); assert.equal(page.hasMore, true);
    assert(!page.items.some(item => item.ref.id === 'extra.source.19'));
    const found = f.catalog.discoverActions(f.graph, 'alice', request, { search: 'extra.source.19', actionId: 'ReadA', limit: 1 });
    assert.equal(found.items[0]!.bindings.length, 1);
    assert.equal(found.items[0]!.bindings[0]!.pin.programRef.id, 'extra.source.19');
    const first = f.catalog.discoverActions(f.graph, 'alice', request, { actionId: 'ReadA', limit: 1 });
    let cursor = first.page.cursor, rows = [...first.items.flatMap(item => item.bindings)];
    while (cursor) {
      const next = f.catalog.discoverActions(f.graph, 'alice', request, { actionId: 'ReadA', limit: 1, cursor });
      assert(next.items.flatMap(item => item.bindings).length <= 1);
      rows.push(...next.items.flatMap(item => item.bindings)); cursor = next.page.cursor;
    }
    const last = rows.find(binding => binding.pin.programRef.id === 'extra.source.19')!;
    assert(last); assert.equal(f.catalog.resolveActionBinding(f.graph, 'alice', request, last.pin).program.ref.id, 'extra.source.19');
    f.flags.permitted = false;
    assert.equal(f.catalog.discoverActions(f.graph, 'alice', request, { search: 'extra.source.19' }).items.length, 0);
    assert.equal(f.catalog.summaryPage('alice').hasMore, false);
    assert.equal(f.flags.invokes, 0);
  } finally { f.db.close(); }
});
