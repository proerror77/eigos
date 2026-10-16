import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { SCOPES, type Principal, type Job } from '../packages/core/domain.js';
import { PILOT, type Fault, type DatasetId } from '../packages/capabilities/pilot/contracts.js';
import { AuditPilot } from '../packages/capabilities/pilot/service.js';
import { SimulatedProvider } from '../packages/capabilities/pilot/providers.js';
import { accept, produce, render, parse } from '../packages/capabilities/pilot/quality.js';
import { readConfig } from '../packages/core/config.js';
const p: Principal = { issuer: 'test', tenant: 'org', subject: 'alice', clientId: 'c', scopes: [...SCOPES] };
function fixture(fault: Fault = 'none', path = ':memory:', afterEffect?: () => void) {
  let now = Date.parse('2026-10-15T00:00:00Z');
  const store = new JobStore(path); const provider = new SimulatedProvider(store, fault);
  const pilot = new AuditPilot(store, provider, () => now, afterEffect);
  const tasks = new TaskService(store, { pilot });
  return { store, provider, pilot, tasks, step: (ms = 1000) => { now += ms; pilot.tick(); }, advance: (ms: number) => { now += ms; },
    submit: (datasetId: DatasetId = 'duplicate-and-missing-v1', requestId: string = randomUUID()) => tasks.submit(p, { service: PILOT, goal: 'Audit synthetic CSV', datasetId, requestId }),
    confirm: (j: Job, requestId: string = randomUUID()) => tasks.reply(p, { taskId: j.id, requestId, action: 'confirm_simulated_payment', quoteId: j.pilot!.quote.id, quoteDigest: j.pilot!.quoteDigest }) };
}
for (const dataset of ['clean-v1', 'duplicate-and-missing-v1', 'invalid-values-v1'] as const) {
  test(`independent oracle and report corruption: ${dataset}`, () => {
    const id = randomUUID(); const report = produce(dataset, id, Date.now());
    const json = JSON.stringify(report); assert(accept(dataset, id, json, render(report)).accepted);
    assert(!accept(dataset, randomUUID(), json, render(report)).accepted);
    assert(!accept(dataset, id, json, render(report) + 'changed').accepted);
    report.inputSha256 = 'wrong'; assert(!accept(dataset, id, JSON.stringify(report), render(report)).accepted);
  });
}
test('same issue count but wrong rows rejected; repeated row IDs rejected', () => {
  const id = randomUUID(); const report = produce('invalid-values-v1', id, Date.now());
  report.findings[0]!.rows = [2];
  assert(!accept('invalid-values-v1', id, JSON.stringify(report), render(report)).accepted);
  report.findings[0]!.rows = [1, 1];
  assert(!accept('invalid-values-v1', id, JSON.stringify(report), render(report)).accepted);
  assert.throws(() => parse('wrong\n'));
  assert.throws(() => parse('record_id,email,amount_cny,event_date\n"x",y,0,2026-01-01'));
});
for (const [fault, expectedState, remediation, checks] of [
  ['none', 'completed', 'none', 1], ['bad-once', 'completed', 'none', 2], ['bad-always', 'failed', 'refunded', 2],
  ['no-delivery', 'failed', 'refunded', 0], ['declined', 'failed', 'none', 0],
] as const) {
  test(`simulation flow ${fault}`, () => {
    const f = fixture(fault);
    try {
      const j = f.submit(); assert.equal(j.state, 'input-required'); assert.equal(f.provider.query(j.pilot!.orderId), undefined);
      f.confirm(j); for (let n = 0; n < 12; n++) f.step();
      const done = f.tasks.get(p, j.id); assert.equal(done.state, expectedState); assert.equal(done.pilot!.remediation, remediation);
      assert.equal(done.pilot!.checks.length, checks); assert.equal(done.pilot!.step, 'done');
      assert.equal(f.provider.query(j.pilot!.orderId)!.charges, fault === 'declined' ? 0 : 1);
      if (done.state === 'completed') { assert.equal(done.pilot!.acceptance, 'accepted'); assert(done.pilot!.files); }
      else assert.equal(done.artifact, undefined);
    } finally { f.store.close(); }
  });
}
test('unknown payment never retries a new charge; refund pending is not settled', () => {
  for (const fault of ['payment-unknown', 'refund-stuck'] as const) {
    const f = fixture(fault);
    try { const j = f.submit(); f.confirm(j); for (let n = 0; n < 80; n++) f.step();
      const done = f.tasks.get(p, j.id); assert.equal(done.pilot!.remediation, 'needs_review');
      assert.equal(done.state, 'failed'); assert.equal(f.provider.query(j.pilot!.orderId)!.charges, fault === 'payment-unknown' ? 0 : 1);
      if (fault === 'refund-stuck') assert.equal(f.provider.query(j.pilot!.orderId)!.refund, 'pending');
    } finally { f.store.close(); }
  }
});
test('owner/scopes, exact confirmation, quote expiry and idempotency', () => {
  const f = fixture();
  try {
    const j = f.submit('clean-v1', 'same'); assert.equal(f.submit('clean-v1', 'same').id, j.id);
    assert.throws(() => f.submit('invalid-values-v1', 'same'), /different input/);
    assert.throws(() => f.tasks.get({ ...p, subject: 'bob' }, j.id), /not found/);
    assert.throws(() => f.tasks.cancel({ ...p, tenant: 'other' }, j.id), /not found/);
    assert.throws(() => f.tasks.reply(p, { taskId: j.id, requestId: 'plain', answer: 'yes' }));
    const input = { taskId: j.id, requestId: 'confirm', action: 'confirm_simulated_payment', quoteId: j.pilot!.quote.id, quoteDigest: j.pilot!.quoteDigest };
    assert.throws(() => f.tasks.reply({ ...p, scopes: [] }, input), /scope/);
    assert.throws(() => f.tasks.reply(p, { ...input, quoteDigest: 'a'.repeat(64) }), /changed/);
    f.tasks.reply(p, input); f.tasks.reply(p, input); f.step(); f.step();
    assert.equal(f.provider.query(j.pilot!.orderId)!.charges, 1);
    const expired = f.submit(); f.advance(600001); assert.throws(() => f.confirm(expired), /expired/);
  } finally { f.store.close(); }
});
test('disabled service and public/production simulation configuration rejected', () => {
  const f = fixture();
  try {
    assert.throws(() => new TaskService(f.store).submit(p, { service: PILOT, goal: 'x', datasetId: 'clean-v1', requestId: 'x' }), /not configured/);
    assert.throws(() => readConfig({ EIGOS_CSV_PILOT: 'true', HOST: '0.0.0.0' }), /loopback/);
    assert.throws(() => readConfig({ EIGOS_CSV_PILOT: 'true', NODE_ENV: 'production' }), /loopback/);
  } finally { f.store.close(); }
});
test('crash after provider payment persists one charge, restart recovers; cancellation reconciles late success', () => {
  for (const cancel of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'eigos-pilot-')); const path = join(dir, 'db');
    let f = fixture('none', path, () => { throw new Error('crash after remote effect'); });
    const j = f.submit(); f.confirm(j); assert.throws(() => f.step(), /crash/); f.store.close();
    f = fixture('none', path);
    try {
      assert.equal(f.tasks.get(p, j.id).state, 'working');
      if (cancel) f.tasks.cancel(p, j.id);
      for (let i = 0; i < 6; i++) f.step();
      const result = f.tasks.get(p, j.id); assert.equal(result.state, cancel ? 'canceled' : 'completed');
      assert.equal(result.pilot!.remediation, cancel ? 'refunded' : 'none');
      assert.equal(f.provider.query(j.pilot!.orderId)!.charges, 1);
      assert.equal(f.provider.query(j.pilot!.orderId)!.refunds, cancel ? 1 : 0);
    } finally { f.store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
test('cancel before confirmation never charges; cancel after payment never completes', () => {
  for (const paid of [false, true]) {
    const f = fixture(); try {
      const j = f.submit(); if (paid) { f.confirm(j); f.step(); }
      f.tasks.cancel(p, j.id); f.tasks.cancel(p, j.id);
      for (let i = 0; i < 5; i++) f.step();
      const result = f.tasks.get(p, j.id); assert.equal(result.state, 'canceled'); assert.equal(result.artifact, undefined);
      assert.equal(f.provider.query(j.pilot!.orderId)!.charges, paid ? 1 : 0);
    } finally { f.store.close(); }
  }
});
test('signed simulation notification: forged, duplicate, conflicting and late events', () => {
  const f = fixture('payment-unknown');
  try {
    const j = f.submit(); f.confirm(j); f.step(); f.step(60000);
    const ledger = f.provider.query(j.pilot!.orderId)!; ledger.payment = 'paid'; ledger.charges = 1;
    f.store.pilotWrite(`payment:${j.pilot!.orderId}`, ledger);
    const body = new URLSearchParams({ eventId: randomUUID(), orderId: j.pilot!.orderId, environment: 'simulated' }).toString();
    const sign = (s: string) => createHmac('sha256', 'test-secret').update(s).digest('hex');
    assert.throws(() => f.pilot.receive(body, '00', 'test-secret'), /signature/);
    assert.equal(f.pilot.receive(body, sign(body), 'test-secret'), true);
    assert.equal(f.pilot.receive(body, sign(body), 'test-secret'), false);
    f.step(); f.step(); assert.equal(f.tasks.get(p, j.id).pilot!.payment, 'paid');
    // Replaying a notification after acceptance cannot rerun delivery.
    assert.equal(f.pilot.receive(body, sign(body), 'test-secret'), false);
    assert.equal(f.provider.query(j.pilot!.orderId)!.charges, 1);
  } finally { f.store.close(); }
});
