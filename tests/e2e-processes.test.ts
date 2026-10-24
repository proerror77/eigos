import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureProcesses } from './fixtures/process-scope.js';

function fixture(owner: TestContext, context: Pick<TestContext, 'after' | 'signal'> = owner) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-process-scope-')), script = join(directory, 'fixture.cjs');
  writeFileSync(script, `
const mode = process.env.MODE;
if (mode === 'exit') { console.error('synthetic startup failure'); process.exit(7); }
if (mode === 'stubborn') process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
if (mode !== 'silent') {
  console.log(JSON.stringify({ notice: 'not a readiness receipt' }));
  setTimeout(() => console.log(JSON.stringify({ ready: true, pid: process.pid })), 100);
}
`);
  let processes: FixtureProcesses;
  // A regressed helper must produce a bounded test failure, not another CI hang.
  owner.after(() => {
    for (const pid of processes.pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  processes = new FixtureProcesses(context, () => rmSync(directory, { recursive: true, force: true }), 100);
  return { directory, script, processes };
}
function gone(pid: number) {
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
}

test('Fixture startup failure reaps the failed child and cleans earlier children at the test boundary', { timeout: 5000 }, async t => {
  let f: ReturnType<typeof fixture>;
  await t.test('partially initialized process fixture', async subtest => {
    f = fixture(t, subtest);
    const earlier = await f.processes.start(f.script);
    await assert.rejects(f.processes.start(f.script, { MODE: 'silent' }, 200), /fixture\.cjs did not become ready within 200ms/);
    const pids = f.processes.pids(); assert.equal(pids.length, 2);
    gone(pids[1]!);
    assert.doesNotThrow(() => process.kill(earlier.process.pid!, 0));
  });
  for (const pid of f!.processes.pids()) gone(pid);
  assert(!existsSync(f!.directory));
});

test('Fixture readiness ignores unrelated JSON and waits for the actual startup receipt', { timeout: 5000 }, async t => {
  const f = fixture(t), child = await f.processes.start(f.script);
  assert.equal(child.ready.pid, child.process.pid);
  await f.processes.close(); gone(child.process.pid!);
});

test('Fixture teardown forcefully reaps a child that ignores graceful shutdown', { timeout: 5000 }, async t => {
  const f = fixture(t), child = await f.processes.start(f.script, { MODE: 'stubborn' });
  await f.processes.close(); await f.processes.close();
  assert.equal(child.process.signalCode, 'SIGKILL'); gone(child.process.pid!);
});

test('Fixture early exit reports the child and startup diagnostics without leaving a live process', { timeout: 5000 }, async t => {
  const f = fixture(t);
  await assert.rejects(f.processes.start(f.script, { MODE: 'exit' }), /fixture\.cjs exited before readiness \(7\): synthetic startup failure/);
  for (const pid of f.processes.pids()) gone(pid);
});

test('Fixture test cancellation interrupts startup and reaps the pending child', { timeout: 5000 }, async t => {
  const controller = new AbortController(), f = fixture(t, { after: t.after.bind(t), signal: controller.signal });
  const pending = f.processes.start(f.script, { MODE: 'silent' });
  controller.abort();
  await assert.rejects(pending, /startup was aborted/);
  for (const pid of f.processes.pids()) gone(pid);
});
