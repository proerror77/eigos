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

test('browser operator credentials are separate and task cancellation blocks a queued browser dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-participant-bridge-')), taskPath = join(directory, 'tasks.sqlite'), store = new JobStore(taskPath), modelFixture = participantFixture();
  const workerToken = randomBytes(32).toString('hex'), operatorToken = randomBytes(32).toString('hex'), tokenFile = join(directory, 'source-token');
  writeFileSync(tokenFile, workerToken, { mode: 0o600 });
  const bridge = await createParticipantBrowserBridge({ databasePath: join(directory, 'bridge.sqlite'), taskDatabasePath: taskPath, evidenceDirectory: join(directory, 'evidence'), bindingId: 'synthetic-local-protocol', attendeeRef: modelFixture.source.attendeeRef, workerToken, operatorToken });
  try {
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
