import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { CodexExecutor } from '../packages/capabilities/executor.js';
import { withModelUsage } from '../packages/core/model-usage-context.js';
import { DatabaseSync } from 'node:sqlite';
import { initializeMemberUsage, beginModelUsage, finishModelUsage } from '../packages/core/member-usage.js';
import { NativeModelTrace } from '../packages/capabilities/native-model-timing.js';
import { ownerKey } from '../packages/core/domain.js';
import { evidence, principal } from './backend-fixture.js';

test('member usage spans tasks and installations, stays isolated, and imposes no member limit', () => {
  const store = new JobStore(':memory:'), tasks = new TaskService(store, { catalog: createExecutionCatalog() });
  try {
    const bob = { ...principal, subject: 'bob' }, a = tasks.submit(principal, { goal: 'A', requestId: randomUUID() }), a2 = tasks.submit({ ...principal, clientId: 'another-installation' }, { goal: 'A2', requestId: randomUUID() }), b = tasks.submit(bob, { goal: 'B', requestId: randomUUID() });
    const run = { ...evidence(), usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } };
    store.recordModelUsage(ownerKey(principal), a.id, run); store.recordModelUsage(ownerKey(principal), a.id, run);
    store.recordModelUsage(ownerKey(principal), a2.id, { ...run, id: randomUUID() });
    store.recordModelUsage(ownerKey(bob), b.id, { ...run, id: randomUUID(), usage: { input_tokens: 99 } });
    const usage = tasks.usage(principal); assert.equal(usage.models.attempts, 2); assert.equal(usage.models.reportedUsage.input_tokens, 20);
    assert.equal(tasks.usage(bob).models.reportedUsage.input_tokens, 99); assert.equal(usage.limitsEnforced, false); assert.equal(usage.remaining, null); assert.equal(usage.resetsAt, null);
    assert.equal(tasks.get(principal, a.id).memberUsage!.models.attempts, 2);
    assert.throws(() => store.recordModelUsage(ownerKey(bob), b.id, run), /another execution/);
    assert.throws(() => store.recordModelUsage(ownerKey(principal), a.id, { ...run, usage: { input_tokens: 999 } }), /changed/);
    assert.throws(() => tasks.usage({ ...principal, scopes: ['tasks:write'] }));
    assert(tasks.submit(principal, { goal: 'Usage does not consume a member allowance', requestId: randomUUID() }));
  } finally { store.close(); }
});

test('private attempt diagnostics reject payload fields and preserve the first valid timing across late accounting', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE jobs(owner TEXT,id TEXT,body TEXT)'); initializeMemberUsage(db);
    const at = '2026-01-01T00:00:00.000Z'; let now = 0;
    const trace = new NativeModelTrace(() => now, at); trace.mark('spawnRequested'); now = 10; trace.mark('processExited');
    const timing = trace.finish('process_failed'), evidence = { id: 'attempt', runtime: 'codex-exec', startedAt: at, completedAt: at, nativeTiming: timing };
    beginModelUsage(db, 'owner', 'task', evidence.id, evidence.runtime, at, 'claim-digest');
    const read = () => JSON.parse(String(db.prepare('SELECT body FROM member_model_usage WHERE run_id=?').get(evidence.id)!.body));
    const unexpectedPayload = { ...timing, prompt: 'PRIVATE_PROMPT' };
    finishModelUsage(db, 'owner', 'task', evidence.id, { ...evidence, nativeTiming: unexpectedPayload }, 'failed');
    assert.equal(read().nativeTiming, undefined); assert(!JSON.stringify(read()).includes('PRIVATE_PROMPT'));
    finishModelUsage(db, 'owner', 'task', evidence.id, evidence, 'failed'); assert.deepEqual(read().nativeTiming, timing);
    finishModelUsage(db, 'owner', 'task', evidence.id, undefined, 'failed'); assert.deepEqual(read().nativeTiming, timing);
    assert.throws(() => finishModelUsage(db, 'other-owner', 'task', evidence.id, evidence, 'failed'), /another execution/);
    assert.equal(db.prepare('SELECT count(*) n FROM jobs').get()!.n, 0, 'Diagnostics cannot create or advance business work');
  } finally { db.close(); }
});

test('concurrent model execution records the correct owner, including failed attempts with unknown usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-usage-')), store = new JobStore(join(dir, 'tasks.sqlite')), tasks = new TaskService(store, { catalog: createExecutionCatalog() });
  const binary = join(dir, 'fixture-model');
  writeFileSync(binary, `#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(input==='fail')process.exit(1);const fs=require('node:fs');fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],'{}');console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:input==='alice'?10:20,output_tokens:1}}));});`, { mode: 0o700 });
  try {
    const bob = { ...principal, subject: 'bob' }; tasks.submit(principal, { goal: 'A', requestId: randomUUID() }); tasks.submit(bob, { goal: 'B', requestId: randomUUID() });
    const a = store.claim(['eigos.delegate'], 10000)!, b = store.claim(['eigos.delegate'], 10000)!;
    const run = (claim: typeof a, prompt: string) => withModelUsage({ begin: (id, runtime, at) => store.beginModelUsage(claim, id, runtime, at), finish: (id, receipt, state) => store.finishModelUsage(claim, id, receipt, state) }, () => new CodexExecutor(binary).runStructured(prompt, {}, new AbortController().signal));
    await Promise.all([run(a, a.owner === ownerKey(principal) ? 'alice' : 'bob'), run(b, b.owner === ownerKey(principal) ? 'alice' : 'bob')]);
    const alice = a.owner === ownerKey(principal) ? a : b;
    const beforeFailedAttempt = store.get(alice.owner, alice.job.id);
    await assert.rejects(run(alice, 'fail'));
    assert.deepEqual(store.get(alice.owner, alice.job.id), beforeFailedAttempt, 'Failure diagnostics only update accounting, never the task or lease');
    const reader = new DatabaseSync(join(dir, 'tasks.sqlite'), { readOnly: true });
    try {
      const row = JSON.parse(String(reader.prepare("SELECT body FROM member_model_usage WHERE job_id=? AND state='failed'").get(alice.job.id)!.body));
      assert.equal(row.nativeTiming.outcome, 'process_failed'); assert.equal(row.nativeTiming.stage, 'cli_or_mcp_startup');
      assert(row.nativeTiming.markers.processExited >= row.nativeTiming.markers.spawnRequested);
      assert.equal(row.nativeTiming.durations.turnMs, null); assert.equal(row.usageReported, false);
    } finally { reader.close(); }
    const usage = tasks.usage(principal); assert.equal(usage.models.attempts, 2); assert.equal(usage.models.states.failed, 1); assert.equal(usage.models.attemptsWithoutReportedUsage, 1); assert.equal(usage.models.reportedUsage.input_tokens, 10);
    assert.equal(tasks.usage(bob).models.reportedUsage.input_tokens, 20);
    tasks.cancel(principal, alice.job.id); await assert.rejects(run(alice, 'alice'), /lease/);
    assert.equal(tasks.usage(principal).models.attempts, 2, 'A fenced dispatch adds no usage record');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
