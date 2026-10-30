import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startOntologyManagementFixture } from './fixtures/ontology-management.js';
import { eventIntake, pipelineEventType } from './fixtures/ontology-pipeline.js';
import { digest } from '../packages/core/delegation.js';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { securityGatewayFixture } from './fixtures/security-gateway.js';
import { participantFixture } from './fixtures/free-booking.js';
import { participantIntake } from './fixtures/ontology-pipeline.js';
import { ParticipantBookingProgram } from '../packages/capabilities/free-booking/program.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { bindPersonalSourceOwner } from '../packages/core/source-owner.js';
import { ownerKey } from '../packages/core/domain.js';

test('HTTP and MCP use the same versioned intake, validation and publication permissions', async () => {
  const f = await startOntologyManagementFixture();
  try {
    await f.connect();
    const namespace = await f.http('/ontology/v1/commands', { operation: 'create_ontology', id: 'pipeline.http', name: 'Synthetic source intake' });
    let draft = await f.http('/ontology/v1/commands', { operation: 'create_draft', ontologyId: namespace.id, title: 'Fixture intake' });
    draft = await f.http('/ontology/v1/commands', { operation: 'put_definition', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision, kind: 'object', definition: pipelineEventType });
    const intake = eventIntake(f.gateway.store.ontology.model);
    const command = { operation: 'put_pipeline_intake', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision, intake };
    assert.equal((await f.post('/ontology/v1/commands', command, 'reader')).status, 403);
    assert.equal((await f.post('/ontology/v1/commands', command, 'bob')).status, 403);
    draft = await f.mcp('manage_ontology_definitions', command);
    assert.equal((await f.post('/ontology/v1/commands', command)).status, 409);
    const queried = await f.mcp('query_ontology_definitions', { operation: 'get_pipeline_intake', ontologyId: namespace.id, draftId: draft.id, serviceId: intake.serviceId });
    assert.equal(queried.intakeDigest, digest(intake)); assert.equal(queried.publication, 'draft');
    const verify = { operation: 'validate_pipeline_intake', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision, serviceId: intake.serviceId, expiresAt: new Date(Date.now() + 60000).toISOString() };
    assert.equal((await f.post('/ontology/v1/commands', { ...verify, evidenceLevel: 'live_fulfillment' })).status, 400);
    const result = await f.mcp('manage_ontology_definitions', verify);
    assert.equal(result.valid, true); assert.equal(result.verification.level, 'synthetic');
    assert.equal(result.verification.kind, 'mapping_test'); assert.equal(result.verification.authorizationProof, false);
    const published = await f.http('/ontology/v1/commands', { operation: 'publish_draft', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision }, 'publisher');
    await f.http('/ontology/v1/commands', { operation: 'activate_release', ontologyId: namespace.id, release: published.release, expectedGeneration: namespace.generation }, 'publisher');
    const view = await f.http('/ontology/v1/query', { operation: 'get_pipeline_intake', ontologyId: namespace.id, serviceId: intake.serviceId }, 'reader');
    assert.equal(view.publication, 'published'); assert.equal(view.intakeDigest, queried.intakeDigest);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'get_pipeline_intake', ontologyId: namespace.id, serviceId: intake.serviceId }, 'bob')).status, 403);
    const drift = { operation: 'report_pipeline_source_change', ontologyId: namespace.id, serviceId: intake.serviceId, sourceDigest: digest('changed') };
    assert.equal((await f.post('/ontology/v1/commands', drift, 'editor')).status, 403);
    assert.equal((await f.post('/ontology/v1/commands', drift, 'publisher')).status, 200);
    assert.equal((await f.post('/ontology/v1/commands', { ...drift, operation: 'ingest_pipeline_observation', payload: {} })).status, 400);
  } finally { await f.close(); }
});

test('Foundation HTTP and MCP prepare one bounded task and A2A reads the same authorized task', async () => {
  const source = participantFixture(), calls: string[] = [], original = source.source.call.bind(source.source);
  source.source.call = async (...args) => { calls.push(args[1]); return original(...args); };
  const program = new ParticipantBookingProgram(source.source);
  const f = await securityGatewayFixture((store, principal) => {
    bindPersonalSourceOwner(program, ownerKey(principal));
    return new ExecutionCatalog([program.capability()], [], [], [], [program], undefined, store.security);
  });
  const client = new Client({ name: 'foundation-pipeline-fixture', version: '1' });
  try {
    const store = f.gateway.store, owner = ownerKey(f.p), policy = store.security.policies;
    const catalog = new ExecutionCatalog([program.capability()], [], [], [], [program], undefined, store.security);
    const profile = catalog.securityProfiles(owner)[0]!, install = f.install(), until = new Date(Date.now() + 3600000).toISOString();
    const resources = ['ServiceRequest', ...profile.outputTypes].map(type => ({ type, fields: Object.keys(policy.fields(type)).filter(field => policy.fieldPolicy(type, field) !== 'internal_only') }));
    f.gateway.security!.approveAgentGrant(f.member.id, { installationId: install.id, capabilityIds: [program.ref.id], resources,
      sourceBindingIds: [profile.bindingId], channels: ['agent_response'], expiresAt: until });
    f.qualify(install.id);
    policy.setSource(owner, { installationId: install.id, bindingId: profile.bindingId, programId: program.ref.id, programDigest: program.configurationDigest,
      operations: program.actionIds, outputTypes: profile.outputTypes, expiresAt: until }, policy.revision());
    const namespace = store.definitions.namespace('eigos.business'), intake = participantIntake(store.ontology.model, program);
    intake.actions = intake.actions.filter(action => action.actionId === 'ReadParticipantRegistration');
    let draft = store.definitions.createDraft(owner, namespace.id, 'Synthetic gateway validation', true);
    draft = store.definitions.putPipeline(owner, draft.id, draft.revision, intake, true);
    store.definitions.validatePipeline(owner, draft.id, draft.revision, intake.serviceId, until, true);
    const release = store.definitions.publish(owner, draft.id, draft.revision, true).release;
    store.definitions.activate(owner, release, namespace.generation, true);
    const command = { operation: 'prepare_pipeline_validation', ontologyId: namespace.id, release, serviceId: intake.serviceId,
      goal: 'Read an existing synthetic registration only', requestId: randomUUID(), expiresAt: new Date(Date.now() + 300000).toISOString() };
    const headers = { Authorization: `Bearer ${install.token}` };
    const response = await f.post('/ontology/v1/commands', command, headers);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    const resultSchema = z.object({ result: z.object({ task: z.object({ id: z.uuid() }), validationOnly: z.literal(true) }) });
    const prepared = resultSchema.parse(response.value).result;
    await client.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers } }));
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert(tools.includes('prepare_ontology_action') && tools.includes('approve_ontology_action'));
    assert.equal((await client.callTool({ name: 'prepare_ontology_action', arguments: { action: 'CreateOfficeAsset', input: {}, requestId: 'outside-personal-scope' } })).isError, true);
    assert.equal((await f.post('/ontology/v1/actions/prepare', {}, headers)).status, 400);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'list_definitions', ontologyId: namespace.id }, headers)).status, 403);
    const replay = await client.callTool({ name: 'manage_ontology_definitions', arguments: command });
    assert(!replay.isError, JSON.stringify(replay));
    assert.equal(resultSchema.parse(replay.structuredContent).result.task.id, prepared.task.id);
    const query = await client.callTool({ name: 'query_ontology_definitions', arguments: { operation: 'get_pipeline_task_uses', ontologyId: namespace.id, taskId: prepared.task.id } });
    assert(!query.isError, JSON.stringify(query));
    assert.deepEqual(z.object({ result: z.object({ items: z.array(z.unknown()) }) }).parse(query.structuredContent).result.items, []);
    const a2a = await f.post('/a2a', { jsonrpc: '2.0', id: 'read', method: 'GetTask', params: { id: prepared.task.id } }, headers);
    assert.equal(a2a.status, 200, JSON.stringify(a2a.value));
    assert.equal(z.object({ result: z.object({ id: z.uuid() }) }).parse(a2a.value).result.id, prepared.task.id);
    const limited = f.install({ ...f.p, scopes: ['services:read', 'tasks:read', 'tasks:write', 'ontology:read'] });
    f.gateway.security!.approveAgentGrant(f.member.id, f.grantInput(limited.id));
    const limitedHeaders = { Authorization: `Bearer ${limited.token}` };
    assert.equal((await f.post('/ontology/v1/commands', command, limitedHeaders)).status, 403);
    assert.equal((await f.post('/ontology/v1/query', { operation: 'get_pipeline_task_uses', ontologyId: namespace.id, taskId: prepared.task.id }, limitedHeaders)).status, 403);
    const otherRead = await f.post('/a2a', { jsonrpc: '2.0', id: 'denied', method: 'GetTask', params: { id: prepared.task.id } }, limitedHeaders);
    assert(otherRead.status === 403 || !!otherRead.value.error);
    assert(!JSON.stringify(otherRead.value).includes(command.goal));
    f.gateway.security!.revokeInstallation(f.member.id, install.id);
    const denied = await f.post('/ontology/v1/commands', command, headers);
    assert.equal(denied.status, 403);
    assert.equal(calls.length, 0, 'Preparing and reading a task must not invoke its provider in the Gateway');
  } finally { await client.close(); await f.close(); source.store.close(); }
});
