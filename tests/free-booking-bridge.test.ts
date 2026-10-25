// Local protocol/authorization test only; no browser or Luma service is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { createParticipantBrowserBridge } from '../packages/capabilities/free-booking/browser-bridge.js';
import { participantFixture } from './fixtures/free-booking.js';
import { backend, owner, principal } from './backend-fixture.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';

test('browser operator credentials are separate and task cancellation blocks a queued browser dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-participant-bridge-')), taskPath = join(directory, 'tasks.sqlite'), store = new JobStore(taskPath), modelFixture = participantFixture();
  const workerToken = randomBytes(32).toString('hex'), operatorToken = randomBytes(32).toString('hex'), tokenFile = join(directory, 'source-token');
  writeFileSync(tokenFile, workerToken, { mode: 0o600 });
  const bridge = await createParticipantBrowserBridge({ databasePath: join(directory, 'bridge.sqlite'), taskDatabasePath: taskPath, evidenceDirectory: join(directory, 'evidence'), bindingId: 'synthetic-local-protocol', attendeeRef: modelFixture.source.attendeeRef, workerToken, operatorToken });
  try {
    const health = await fetch(bridge.endpoint + '/health').then(r => r.json());
    assert.equal(health.backend, BACKEND_VERSION); assert.equal(health.operatorRequired, true); assert.equal(health.unattended, false);
    const catalog = createExecutionCatalog({ participantBooking: { endpoint: bridge.endpoint, tokenFile, bindingId: 'synthetic-local-protocol', attendeeRef: modelFixture.source.attendeeRef } }), b = backend(catalog, modelFixture.model, store);
    const sent = b.submit({ goal: 'Local bridge protocol fixture only', executionEnvironment: 'live' });
    await b.run(); await b.run();
    const intent = store.intents(owner, sent.id)[0]!; assert.equal(intent.state, 'awaiting_remote');
    const unauthorized = await fetch(bridge.endpoint + '/operator/next', { headers: { authorization: `Bearer ${workerToken}` } }); assert.equal(unauthorized.status, 403);
    const operatorHeaders = { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' };
    const queued = await fetch(bridge.endpoint + '/operator/next', { headers: operatorHeaders }).then(r => r.json()); assert.equal(queued.operations.length, 1); assert.equal(queued.operations[0].key, intent.businessOperationKey);
    const wrongRole = await fetch(bridge.endpoint + '/operations/' + intent.businessOperationKey, { headers: operatorHeaders }); assert.equal(wrongRole.status, 403);
    const crossOrigin = await fetch(bridge.endpoint + '/operator/next', { headers: { ...operatorHeaders, origin: 'https://example.com' } }); assert.equal(crossOrigin.status, 403);
    b.tasks.cancel(principal, sent.id);
    const canceled = await fetch(bridge.endpoint + '/operator/dispatch/' + intent.businessOperationKey, { method: 'POST', headers: operatorHeaders }); assert.equal(canceled.status, 403);
    assert.match((await canceled.json()).error, /canceled|stopped/);
    assert.equal(store.get(owner, sent.id).state, 'canceled'); assert.equal(store.get(owner, sent.id).artifact, undefined);
    assert.equal(modelFixture.counters().submits, 0);
  } finally { await bridge.close(); store.close(); modelFixture.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

import { meituanPrimitiveFixture } from './fixtures/meituan-agent.js';
import { evidence, interpretation, syntheticGoalReview } from './backend-fixture.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import { digest } from '../packages/core/delegation.js';
import { randomUUID } from 'node:crypto';

test('browser bridge accepts the exact selected composition component and rechecks its zero-charge grant at dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-composed-browser-')), taskPath = join(directory, 'tasks.sqlite'), store = new JobStore(taskPath), f = participantFixture(), geo = meituanPrimitiveFixture();
  const workerToken = randomBytes(32).toString('hex'), operatorToken = randomBytes(32).toString('hex'), tokenFile = join(directory, 'worker-token'), evidenceDirectory = join(directory, 'evidence');
  writeFileSync(tokenFile, workerToken, { mode: 0o600 });
  const bridge = await createParticipantBrowserBridge({ databasePath: join(directory, 'bridge.sqlite'), taskDatabasePath: taskPath, evidenceDirectory, bindingId: 'composed-protocol', attendeeRef: f.source.attendeeRef, workerToken, operatorToken });
  const operatorHeaders = { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' };
  try {
    const catalog = createExecutionCatalog({ store, meituan: geo.reader, participantBooking: { endpoint: bridge.endpoint, tokenFile, bindingId: 'composed-protocol', attendeeRef: f.source.attendeeRef } });
    const input = { components: [
      { id: 'registration', capabilityRef: { id: 'booking.participant.free', version: '1' }, goal: 'Synthetic free registration', input: f.input, dependsOn: [], bindings: [], requirementIds: [], conditionIds: [] },
      { id: 'geo', capabilityRef: { id: 'geo.search', version: '1' }, goal: 'Synthetic public query', input: { city: '北京市', keyword: '天安门' }, dependsOn: [], bindings: [], requirementIds: [], conditionIds: [] },
    ] };
    const model: Reasoner = { reviewGoal: syntheticGoalReview, ground: async request => ({ decision: { ...interpretation(request, 'services.compose.live', input), capabilityRef: { id: 'services.compose.live', version: '1' } }, evidence: evidence() }), plan: async () => { throw new Error('No legacy recipe'); }, act: async (ctx, _signal, access) => {
      const c = ctx.state.components!.registration!;
      access.session.call('describe_ontology', { actions: ['InspectRegistrationPage', 'SubmitFreeRegistration'] });
      access.session.call('query_ontology', { object: ctx.state.scope }); access.session.call('query_ontology', { object: c.scope });
      const offer = c.observations.at(-1);
      if (offer) { access.session.call('query_ontology', { object: offer }); access.session.call('evaluate_ontology', { function: 'registrationStatus', object: offer }); }
      const decision = { kind: 'execute' as const, requestRevision: ctx.request.revision, message: 'Synthetic component action', completionJson: '', steps: [{ id: offer ? 'submit' : 'inspect', action: offer ? 'SubmitFreeRegistration' : 'InspectRegistrationPage', argumentsJson: JSON.stringify({ scope: c.scope, ...(offer ? { offer } : {}) }), dependsOn: [], inputRefs: [] }] };
      return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    } };
    const b = backend(catalog, model, store), job = b.submit({ executionEnvironment: 'live' });
    await b.run(); await b.run();
    const inspection = store.intents(owner, job.id)[0]!; assert.equal(inspection.state, 'awaiting_remote');
    const saved = store.get(owner, job.id), wrong = structuredClone(saved); wrong.delegation!.agent!.components!.registration!.programDigest = '0'.repeat(64); store.save(owner, wrong);
    assert.equal((await fetch(`${bridge.endpoint}/operator/dispatch/${inspection.businessOperationKey}`, { method: 'POST', headers: operatorHeaders })).status, 403);
    store.save(owner, saved);
    assert.equal((await fetch(`${bridge.endpoint}/operator/dispatch/${inspection.businessOperationKey}`, { method: 'POST', headers: operatorHeaders })).status, 200);
    const now = new Date().toISOString(), startsAt = new Date(Date.now() + 86400000).toISOString(), title = 'Synthetic composed participant event';
    const data = { serviceUrl: f.input.serviceUrl, title, kind: 'event_registration', startsAt, endsAt: new Date(Date.parse(startsAt) + 3600000).toISOString(), timeZone: 'Asia/Shanghai', participants: 1, attendeeRef: f.source.attendeeRef, payment: { requirement: 'not_required', total: { minor: '0', currency: 'CNY' }, feesComplete: true }, termsRef: 'synthetic-terms', availability: 'available', alreadyRegistered: false, requiresApproval: false, requiresAdditionalConsent: false, observedAt: now, expiresAt: new Date(Date.now() + 300000).toISOString() };
    const snapshotPath = join(evidenceDirectory, 'snapshot.txt'), screenshotPath = join(evidenceDirectory, 'screenshot');
    writeFileSync(snapshotPath, `eigos-synthetic-free ${title} Free`); writeFileSync(screenshotPath, 'synthetic local evidence only');
    const resolved = await fetch(`${bridge.endpoint}/operator/resolve/${inspection.businessOperationKey}`, { method: 'POST', headers: operatorHeaders, body: JSON.stringify({ data, pageUrl: f.input.serviceUrl, snapshotPath, screenshotPath }) }); assert.equal(resolved.status, 200);
    await new Promise(r => setTimeout(r, Math.max(0, store.intents(owner, job.id)[0]!.nextAt - Date.now()) + 10));
    await b.run(); await b.run(); const waiting = store.get(owner, job.id); assert.equal(waiting.state, 'auth-required', JSON.stringify(waiting.delegation!.agent!.feedback));
    const a = waiting.delegation!.authorizationRequest!;
    b.tasks.authorize(principal, job.id, { requestId: randomUUID(), action: 'approve_plan', planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'live_free' });
    await b.run(); const submit = store.intents(owner, job.id).find(i => i.effect === 'reserve')!; assert.equal(submit.state, 'awaiting_remote');
    store.revokeGrants(owner, job.id);
    const denied = await fetch(`${bridge.endpoint}/operator/dispatch/${submit.businessOperationKey}`, { method: 'POST', headers: operatorHeaders }); assert.equal(denied.status, 403); assert.match((await denied.json()).error, /expired|revoked/);
    assert.equal(geo.calls.length, 0); assert.equal(store.get(owner, job.id).artifact, undefined);
  } finally { await bridge.close(); store.close(); f.store.close(); rmSync(directory, { recursive: true }); }
});
