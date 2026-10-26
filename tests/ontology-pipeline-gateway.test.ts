import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startOntologyManagementFixture } from './fixtures/ontology-management.js';
import { eventIntake, pipelineEventType } from './fixtures/ontology-pipeline.js';
import { digest } from '../packages/core/delegation.js';

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
