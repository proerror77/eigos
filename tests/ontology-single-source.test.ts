import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { openOntologyMcp } from '../packages/coordinator/ontology-mcp.js';
import { managedFixtureObject, publishManagedFixture } from './fixtures/dynamic-ontology.js';
import { owner, principal } from './backend-fixture.js';
import type { Job } from '../packages/core/domain.js';

test('Gateway, Worker and native MCP share persisted definitions and current facts while tasks retain exact releases', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-single-ontology-'));
  const path = join(directory, 'shared.sqlite');
  const gateway = new JobStore(path), worker = new JobStore(path);
  const tasks = new TaskService(gateway, { catalog: createExecutionCatalog({ store: gateway }) });
  const connections: { close: () => Promise<void> }[] = [];
  const connect = async (job: Job) => {
    const graph = worker.ontologyForJob(owner, job);
    const session = new OntologyPlanningSession(graph, owner, job.delegation!.request);
    const mcp = await openOntologyMcp(session, new AbortController().signal);
    const client = new Client({ name: 'single-ontology-fixture', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(mcp.connection.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.connection.token}` } } });
    connections.push({ close: async () => { await client.close(); await transport.close(); await mcp.close(); } });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert(!response.isError);
      return (response.structuredContent as { result: { result: any } }).result.result;
    };
    return { graph, call };
  };
  try {
    const fixture = publishManagedFixture(gateway, owner, 'single.source');
    const submit = () => tasks.submit(principal, { requestId: randomUUID(), service: 'eigos.delegate', ontologyId: fixture.ontologyId, goal: 'Inspect a synthetic owned resource' });
    const first = submit(), original = await connect(first);
    const described = await original.call('describe_ontology', { search: 'OfficeAsset', limit: 1 });
    assert.deepEqual(described.model, gateway.ontologyForJob(owner, first).model.ref);
    assert.equal(described.types[0].name, 'Office resource');

    const asset = { type: 'OfficeAsset', id: 'synthetic-shared-asset' };
    fixture.graph.ingest(owner, { objects: [{ ref: asset, properties: { id: asset.id, label: 'Original label', status: 'available' } }] }, { kind: 'user', id: 'synthetic-input', observedAt: new Date().toISOString() });
    assert.equal((await original.call('query_ontology', { object: asset })).items[0].properties.label, 'Original label');
    const before = fixture.graph.read(owner, asset);
    fixture.graph.ingest(owner, { objects: [{ ref: asset, properties: { ...before.properties, label: 'Updated through Gateway storage' }, expectedRevision: before.revision }] }, { kind: 'user', id: 'synthetic-update', observedAt: new Date().toISOString() });
    const stale = await original.call('query_ontology', { object: asset });
    assert.equal(stale.error, 'CONFLICT', 'A decision must detect an independent change in the shared store');

    const namespace = gateway.definitions.namespace(fixture.ontologyId);
    let draft = gateway.definitions.createDraft(owner, fixture.ontologyId, 'Revise display metadata');
    draft = gateway.definitions.putResource(owner, draft.id, draft.revision, 'object', { ...managedFixtureObject, name: 'Revised office resource' });
    const published = gateway.definitions.publish(owner, draft.id, draft.revision);
    gateway.definitions.activate(owner, published.release, namespace.generation);
    const releaseCount = gateway.definitions.releases(fixture.ontologyId).length;
    assert.deepEqual(worker.definitions.active(fixture.ontologyId).ref, published.release);
    assert.deepEqual(worker.ontologyReleaseForJob(owner, first), fixture.release);

    const oldDecision = await connect(worker.get(owner, first.id));
    assert.equal((await oldDecision.call('describe_ontology', { search: 'OfficeAsset', limit: 1 })).types[0].name, 'Office resource');
    assert.equal((await oldDecision.call('query_ontology', { object: asset })).items[0].properties.label, 'Updated through Gateway storage');
    const second = submit(), nextDecision = await connect(second);
    assert.deepEqual(second.delegation!.ontologyRelease, published.release);
    const current = await nextDecision.call('describe_ontology', { search: 'OfficeAsset', limit: 1 });
    assert.equal(current.types[0].name, 'Revised office resource');
    assert.deepEqual(current.model, gateway.ontologyForJob(owner, second).model.ref);
    assert.equal(gateway.definitions.releases(fixture.ontologyId).length, releaseCount, 'MCP sessions must not persist their own definition copies');
    assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.sqlite')), ['shared.sqlite']);
  } finally {
    for (const connection of connections) await connection.close();
    worker.close(); gateway.close(); rmSync(directory, { recursive: true, force: true });
  }
});
