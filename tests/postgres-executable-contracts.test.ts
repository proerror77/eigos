import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../packages/core/delegation.js';
import { createExecutableContractKernelDefinition, compiledSeedModel, stagedKernelComponents } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { preparePostgresKernel } from '../packages/postgres/kernel-runtime.js';
import { postgresOntologyRelease } from '../packages/postgres/ontology-release.js';
import { PostgresTaskReadService } from '../packages/postgres/task-read-service.js';
import { withPostgresTaskReadAuthorization } from '../packages/postgres/task-output.js';
import { postgresEvaluateAuthorizedFunction } from '../packages/postgres/ontology-functions.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { projectRideEstimate } from '../packages/ontology/ride-estimate-projection.js';
import { mapDidiResult } from '../packages/capabilities/didi/mapping.js';
import { didiEndpoint } from '../packages/capabilities/didi/contracts.js';
import { persistentConsentPolicyContracts } from '../packages/security/policy-store.js';
import { assertReviewedModel } from '../packages/security/model-review.js';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { input as rideInput, sourcePlace } from './fixtures/didi.js';
import { DynamicOntologyProgram, createDynamicOntologyProgram } from '../packages/capabilities/dynamic-ontology.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { personalActionIds, selfPersonRef, personalPreferenceRef } from '../packages/ontology/personal-context.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresTaskStorage } from '../packages/postgres/task-storage.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';
import { PostgresCallerActionExecution } from '../packages/postgres/caller-action.js';
import { PostgresReadProgramRegistry } from '../packages/postgres/didi-registry.js';
import { postgresWorkerLane, postgresWorkerReservation } from '../packages/postgres/worker-capacity.js';
import { discoverPostgresTaskActions } from '../packages/postgres/action-discovery.js';

test('installed forward registry is sealed, idempotent and isolated from the selected policy document', async () => {
  const a = await preparePostgresKernel(), first = stagedKernelComponents(a), document = a.result().document;
  assert.equal(first.model.ref.version, '28'); assert.equal(first.documentDigest, digest(document));
  const release = createExecutableContractKernelDefinition(), forward = compileOntologyDocument(release.document, first.registry);
  assert.equal(forward.ref.version, '34'); assert.equal(forward.functionBindingStatus('selectDidiPlace').state, 'executable_registered');
  a.installExecutableContracts(); const again = stagedKernelComponents(a);
  assert.equal(again.registry, first.registry); assert.equal(again.model, first.model); assert.equal(again.documentDigest, first.documentDigest);
  assert.deepEqual(persistentConsentPolicyContracts(forward), persistentConsentPolicyContracts(first.model));
  assert.doesNotThrow(() => assertReviewedModel(first.model, forward));
  assert.throws(() => first.registry.registerFunction(forward.function('selectDidiPlace')), /sealed/);
  const b = await preparePostgresKernel(undefined, '29'), other = stagedKernelComponents(b);
  assert.notEqual(other.registry, first.registry); assert.equal(other.model.ref.version, '29'); assert(other.model.functionIds().includes('semanticCandidates'));
  assert(!forward.functionIds().includes('semanticCandidates'));
  assert.equal(compileOntologyDocument(release.document, other.registry).ref.digest, forward.ref.digest);
  const tampered = structuredClone(release.document); tampered.actions.find(action => action.id === 'CompleteCheckout')!.effects = ['read'];
  assert.throws(() => compileOntologyDocument(tampered, first.registry), /kernel resources|effect|contract/i);
});

test('ordinary policy-v28 PostgreSQL host reads an explicitly published v34 task only after its exact role is granted', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const f = securityFixture(Date.now, { unified: true }), sqlite = new DatabaseSync(f.database);
  let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
  try {
    const original = f.jobs.ontology.model, raw = new OntologyObjectStore(sqlite, original, Date.now, undefined, { skipLegacyMigration: true });
    const installation = f.installation('Synthetic forward-function PA', 3600000), expiresAt = new Date(Date.now() + 3600000).toISOString();
    const resources = ['ServiceRequest', 'DidiPlaceObservation', 'RideEstimateTask', 'SourceReceipt'].map(type => ({ type, fields: Object.keys(f.jobs.security.policies.fields(type)).filter(field => f.jobs.security.policies.fieldPolicy(type, field) !== 'internal_only') }));
    f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'], resources, sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt });
    f.jobs.security.policies.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data', 'precise_location', 'financial'], channels: ['agent_response'], expiresAt }, f.jobs.security.policies.revision());
    const role = { subjectKind: 'installation' as const, subjectId: installation.id, role: 'Viewer' as const, resource: { kind: 'namespace' as const, id: original.ref.id, version: original.ref.digest }, invokeFunctions: ['rideEstimateStatus', 'selectDidiPlace'], executeActions: [], expiresAt };
    f.jobs.security.policies.setRole(role, f.jobs.security.policies.revision());
    const principal = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) }, prior = f.task(installation.id), task = f.task(installation.id);
    const scope = { type: 'RideEstimateTask', id: randomUUID() }, root = { type: 'ServiceRequest', id: task.job.id }, configurationDigest = 'c'.repeat(64);
    raw.ingest(f.owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: 'Synthetic route', requestRevision: 1, input: rideInput, configurationDigest, allowedActions: ['SearchDidiPlaces', 'EstimateDidiRide'] } }], links: [{ type: 'RideEstimateTaskRequest', from: scope, to: root }] }, { kind: 'synthetic', id: 'forward-fixture', observedAt: new Date().toISOString() });
    const observation = (offset: number) => {
      const id = randomUUID(), at = new Date(Date.now() + offset).toISOString(), data = mapDidiResult('maps_textsearch', { content: [{ type: 'text', text: JSON.stringify([sourcePlace(rideInput.origin, 2)]) }] });
      const body = { id, requestId: task.job.id, requestRevision: 1, configurationDigest, scope, action: 'SearchDidiPlaces', actionInput: { scope, role: 'origin', keywords: rideInput.origin },
        planId: 'synthetic-plan', intentId: 'synthetic-intent', attemptId: id, modelRunId: 'synthetic-model', evidenceKind: 'fixture', data,
        receipt: { id, bindingId: 'synthetic-forward', environment: 'production', endpoint: didiEndpoint('production'), tool: 'maps_textsearch', inputDigest: digest({ city: rideInput.city, keywords: rideInput.origin }), resultDigest: digest(data), responseSha256: 'a'.repeat(64), toolSchemaDigest: 'b'.repeat(64), startedAt: at, receivedAt: at },
        observedAt: at, expiresAt: new Date(Date.parse(at) + 300000).toISOString(), validityBasis: 'local_refresh_limit', noBusinessWrites: true };
      return projectRideEstimate(raw, f.owner, { ...body, contentDigest: digest(body) });
    };
    const fresh = observation(0), expired = observation(-600000), receipts = [fresh, expired].map(ref => ({ type: 'SourceReceipt', id: `didi:${ref.id}` }));
    const inputs = [scope, fresh, expired, ...receipts].map(object => ({ object, objectRevision: 1, fields: resources.find(value => value.type === object.type)!.fields }));
    for (const value of [prior, task]) {
      f.jobs.security.revokeGrant(f.owner, value.grant.id, 1);
      f.jobs.security.issueTaskGrant({ ...value.grant, id: randomUUID(), operations: ['task.query', 'task.result.read', 'member_asset.read'], channels: ['agent_response'], inputs });
    }
    target = await importPostgresFixture(f); const t = target, q = `"${t.schema}"`;
    const installed = stagedKernelComponents(t.kernel); assert.equal(installed.model.ref.version, '28');
    const forward = createExecutableContractKernelDefinition(), forwardModel = compiledSeedModel(forward, forward.registry);
    const ref = { ontologyId: forward.document.id, releaseId: `synthetic-forward-${randomUUID()}`, digest: digest(forward.document) };
    await t.client.query(`INSERT INTO ${q}.ontology_definition_releases(id,ontology_id,sequence,digest,model_digest,body,created_at) VALUES($1,$2,(SELECT max(sequence)+1 FROM ${q}.ontology_definition_releases WHERE ontology_id=$2),$3,$4,$5,$6)`, [ref.releaseId, ref.ontologyId, ref.digest, forwardModel.ref.digest, JSON.stringify(forward.document), new Date().toISOString()]);
    await t.client.query(`UPDATE ${q}.ontology_namespaces SET active_release_id=$1,generation=generation+1 WHERE id=$2`, [ref.releaseId, ref.ontologyId]);
    await t.client.query(`UPDATE ${q}.jobs SET body=jsonb_set(body::jsonb,'{delegation,ontologyRelease}',$1::jsonb)::text WHERE owner=$2 AND id=$3`, [JSON.stringify(ref), f.owner, task.job.id]);
    assert.equal((await t.run(client => postgresOntologyRelease(client, ref))).model.ref.version, '34', 'the ordinary transaction host installed v34 without changing its field-policy model');
    const service = new PostgresTaskReadService(t.database, t.policy), call = { version: 2, taskId: task.job.id, expectedRequestRevision: 1, call: { function: 'selectDidiPlace', object: fresh } };
    await assert.rejects(service.evaluateOntology(principal, call), /AUTHORIZATION_REQUIRED|INSUFFICIENT_ACCESS/);
    const historical = await service.evaluateOntology(principal, { ...call, taskId: prior.job.id });
    assert.equal(historical.functionRef.id, 'selectDidiPlace', 'the historical task still invokes through its v28 role; incomplete cross-task evidence remains unknown');
    // Explicit fixture authority installs a separate role. Software installation
    // and namespace activation above deliberately did not create this grant.
    const role34 = { ...role, resource: { ...role.resource, version: forwardModel.ref.digest } };
    await t.client.query(`INSERT INTO ${q}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`, [digest([role34.subjectKind, role34.subjectId, role34.resource]), installation.id, JSON.stringify(role34)]);
    const result = await service.evaluateOntology(principal, call);
    if (result.status !== 'known') await t.run(client => withPostgresTaskReadAuthorization(client, principal, task.job.id, t.policy, async auth => {
      await auth.withFunction('selectDidiPlace', async calculation => {
        for (const object of [fresh, scope, receipts[0]!, root]) {
          try { await calculation.readObject(object); } catch (error) { throw new Error(`Synthetic forward read rejected: ${object.type}`, { cause: error }); }
        }
      });
      return postgresEvaluateAuthorizedFunction(client, principal, task.job.id, 1, call.call, t.policy, auth, undefined, { accessErrors: 'throw' });
    }));
    assert.equal(result.status, 'known', result.reason); assert.equal(typeof (result.value as { placeId: unknown }).placeId, 'string');
    await assert.rejects(service.evaluateOntology(principal, { ...call, call: { ...call.call, unexpected: true } }));
    const stale = await service.evaluateOntology(principal, { ...call, call: { function: 'rideEstimateStatus', object: expired } });
    assert.equal(stale.status, 'unknown'); assert.equal(stale.value, undefined); assert.match(stale.reason!, /expired/);
    await t.client.query(`DELETE FROM ${q}.security_roles WHERE id=$1`, [digest([role34.subjectKind, role34.subjectId, role34.resource])]);
    await assert.rejects(service.evaluateOntology(principal, call), /AUTHORIZATION_REQUIRED|INSUFFICIENT_ACCESS/);
  } finally { if (target) await target.close(); sqlite.close(); f.close(); }
});

test('v34 personal Actions retain exact discovery, approval, Worker execution and original-task readback', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const f = securityFixture(Date.now, { unified: true }); let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
  try {
    const forward = createExecutableContractKernelDefinition(), model = compiledSeedModel(forward, forward.registry);
    const release = { ontologyId: forward.document.id, releaseId: `synthetic-managed-v34-${randomUUID()}`, digest: digest(forward.document) };
    const program = new DynamicOntologyProgram(model, release, f.owner), policy = f.jobs.security.policies;
    const expiresAt = new Date(Date.now() + 3600000).toISOString(), installation = f.installation('Synthetic v34 personal-action caller', 3600000), sourceBindingId = `program:${program.ref.id}`;
    const resources = [...new Set(['ServiceRequest', 'Person', 'PersonalPreference', 'SavedAddress', ...Object.keys(taskContextFields)])].map(type => ({ type, fields: Object.keys(policy.fields(type)).filter(field => policy.fieldPolicy(type, field) !== 'internal_only') }));
    f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: [program.ref.id], resources, sourceBindingIds: [sourceBindingId], channels: ['agent_response'], expiresAt });
    const oldRole = { subjectKind: 'installation' as const, subjectId: installation.id, role: 'Viewer' as const, resource: { kind: 'namespace' as const, id: f.jobs.ontology.model.ref.id, version: f.jobs.ontology.model.ref.digest }, executeActions: [...personalActionIds], invokeFunctions: f.jobs.ontology.model.functionIds(), expiresAt };
    policy.setRole(oldRole, policy.revision());
    policy.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data', 'precise_location', 'financial', 'health', 'account_private'], channels: ['agent_response'], expiresAt }, policy.revision());
    // This is an explicit fixture source grant for the exact future release,
    // never an automatic conversion of an old program configuration.
    policy.setSource(f.owner, { installationId: installation.id, bindingId: sourceBindingId, programId: program.ref.id, programDigest: program.configurationDigest, operations: [...personalActionIds], outputTypes: ['Person', 'PersonalPreference'], expiresAt }, policy.revision());
    const principal = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) };
    target = await importPostgresFixture(f); const t = target, q = `"${t.schema}"`;
    assert.equal(stagedKernelComponents(t.kernel).model.ref.version, '28');
    await t.client.query(`INSERT INTO ${q}.ontology_definition_releases(id,ontology_id,sequence,digest,model_digest,body,created_at) VALUES($1,$2,(SELECT max(sequence)+1 FROM ${q}.ontology_definition_releases WHERE ontology_id=$2),$3,$4,$5,$6)`, [release.releaseId, release.ontologyId, release.digest, model.ref.digest, JSON.stringify(forward.document), new Date().toISOString()]);
    await t.client.query(`UPDATE ${q}.ontology_namespaces SET active_release_id=$1,generation=generation+1 WHERE id=$2`, [release.releaseId, release.ontologyId]);
    const tasks = new PostgresTaskCommandService(t.database, t.policy, t.kernel), registry = new PostgresReadProgramRegistry(t.policy);
    const worker = new PostgresWorkerStore(t.database, t.policy, t.kernel, { classify: (job, intents) => postgresWorkerLane(job, intents, registry) });
    const execution = new PostgresCallerActionExecution({ database: t.database, policyDigest: t.policy, builder: t.kernel });
    const read = (id: string) => t.run(client => new PostgresTaskStorage(client, t.kernel).get(f.owner, id));
    await assert.rejects(tasks.prepareOntologyAction(principal, { action: 'BindSelfPerson', input: { self: true, displayTitle: 'Synthetic self' }, requestId: randomUUID() }), /AUTHORIZATION_REQUIRED|INSUFFICIENT_ACCESS/, 'an old namespace role cannot prepare a newly published action');
    const role = { ...oldRole, resource: { ...oldRole.resource, version: model.ref.digest }, invokeFunctions: model.functionIds() };
    const roleId = digest([role.subjectKind, role.subjectId, role.resource]);
    await t.client.query(`INSERT INTO ${q}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`, [roleId, installation.id, JSON.stringify(role)]);
    const directoryTask = await tasks.submit(principal, { requestId: randomUUID(), goal: 'Inspect explicitly authorized personal data actions; do not execute them' });
    const catalog = new ExecutionCatalog([], [], [], [], [], createDynamicOntologyProgram);
    const discover = () => t.database.read(client => discoverPostgresTaskActions(client, principal, directoryTask.id, release.ontologyId, { actionId: 'BindSelfPerson' }, { catalog, policyDigest: t.policy, builder: t.kernel }));
    const directory = await discover(), action = directory.items.find(item => item.action.id === 'BindSelfPerson');
    assert(action); assert.equal(action.status, 'available'); assert.equal(action.bindings[0]!.readiness, 'ready');
    assert.deepEqual(action.action.effects, ['object_write']); assert.deepEqual(action.bindings[0]!.pin.ontologyRelease, release);
    assert.equal(action.bindings[0]!.pin.configurationDigest, program.configurationDigest); assert.equal(directory.authorization, 'per_action_required');
    await tasks.cancel(principal, directoryTask.id);

    const perform = async (actionId: string, input: Record<string, unknown>) => {
      await t.refreshEligibility();
      const command = { action: actionId, input, requestId: randomUUID() }, prepared = await tasks.prepareOntologyAction(principal, command), original = await read(prepared.id);
      assert.equal(prepared.state, 'auth-required'); assert.deepEqual(original.delegation!.ontologyRelease, release);
      assert.equal(original.delegation!.agent!.programDigest, program.configurationDigest);
      assert.equal((await tasks.prepareOntologyAction(principal, command)).id, prepared.id);
      assert.equal(await worker.claim(['eigos.delegate'], 30000), undefined, 'discovery and preparation are not a write permit');
      const preview = await tasks.callerActionPreview(principal, prepared.id), plan = original.delegation!.agent!.plans[0]!;
      assert.equal(preview.status, 'prepared'); assert.equal(preview.planDigest, plan.digest); assert.equal(preview.digest, preview.scope.previewDigest);
      const permit = { action: 'approve_object_write', requestId: randomUUID(), planDigest: plan.digest, objectWrite: preview.scope, expiresAt, environment: 'managed' };
      await assert.rejects(tasks.authorize(principal, prepared.id, { ...permit, objectWrite: { ...preview.scope, inputDigest: 'f'.repeat(64) } }), /preview|differs|changed/i);
      assert.equal((await tasks.authorize(principal, prepared.id, permit)).id, prepared.id);
      const claim = await worker.claim(['eigos.delegate'], 30000); assert(claim); assert.equal(claim.job.id, prepared.id);
      assert.equal(postgresWorkerReservation(claim.token).lane, 'execution');
      await assert.rejects(worker.beginModelUsage(claim, randomUUID(), 'no-model-for-managed-write', new Date().toISOString()), /no model capacity/);
      let renewal: Promise<unknown> | undefined, renewalFailure: unknown;
      const timer = setInterval(() => { if (!renewal) renewal = worker.renew(claim, 30000).catch(error => { renewalFailure = error; }).finally(() => { renewal = undefined; }); }, 5000); timer.unref();
      try { await execution.run(claim, new AbortController().signal); } finally { clearInterval(timer); if (renewal) await renewal; }
      assert.equal(renewalFailure, undefined);
      const completed = await read(prepared.id); assert.equal(completed.id, prepared.id); assert.equal(completed.state, 'completed');
      assert.deepEqual(completed.delegation!.ontologyRelease, release); assert.equal(completed.delegation!.acceptance?.accepted, true); assert.equal(completed.runs!.length, 0);
      const committed = await tasks.callerActionPreview(principal, prepared.id); assert.equal(committed.status, 'committed'); assert.equal(committed.digest, preview.digest);
      const intents = await t.run(client => new PostgresTaskStorage(client, t.kernel).intents(f.owner, prepared.id));
      assert.equal(intents.length, 1); assert.equal(intents[0]!.state, 'effect_confirmed');
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.action_attempts WHERE intent_id=$1`, [intents[0]!.id])).rows[0]!.n), 1);
      assert.equal((await tasks.get(principal, prepared.id)).state, 'completed');
      await assert.rejects(execution.run(claim, new AbortController().signal), /ACCESS_REVOKED|frontier|POLICY_CHANGED/);
      return completed;
    };
    const bound = await perform('BindSelfPerson', { self: true, displayTitle: 'Synthetic v34 self' });
    const person = await tasks.queryOntology(principal, { version: 2, taskId: bound.id, query: { object: selfPersonRef(f.owner) } });
    assert.equal(person.items[0]!.revision, 1);
    await perform('CreatePersonalPreference', { key: 'rideClass', value: { kind: 'rideClass', value: 'comfort' } });
    const changed = await perform('SetPersonalPreference', { key: 'rideClass', expectedRevision: 1, value: { kind: 'rideClass', value: 'standard' } });
    const result = await tasks.queryOntology(principal, { version: 2, taskId: changed.id, query: { object: personalPreferenceRef(f.owner, 'rideClass') } });
    assert.equal(result.items[0]!.revision, 2); assert.deepEqual(result.items[0]!.properties.value, { kind: 'rideClass', value: 'standard' });
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.security_model_channels`)).rows[0]!.n), 0);
    await t.client.query(`DELETE FROM ${q}.security_roles WHERE id=$1`, [roleId]);
    await assert.rejects(discover(), /AUTHORIZATION_REQUIRED|INSUFFICIENT_ACCESS/, 'the remaining old role cannot discover v34 task actions');
    await assert.rejects(tasks.prepareOntologyAction(principal, { action: 'SetPersonalPreference', input: { key: 'rideClass', expectedRevision: 2, value: { kind: 'rideClass', value: 'denied-change' } }, requestId: randomUUID() }), /AUTHORIZATION_REQUIRED|INSUFFICIENT_ACCESS/);
    assert.equal(Number((await t.client.query(`SELECT revision FROM ${q}.ontology_objects WHERE owner=$1 AND type='PersonalPreference' AND id=$2`, [f.owner, personalPreferenceRef(f.owner, 'rideClass').id])).rows[0]!.revision), 2, 'the remaining old role cannot mutate the v34 object');
  } finally { if (target) await target.close(); f.close(); }
});
