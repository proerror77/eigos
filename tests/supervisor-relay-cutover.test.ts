import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function waitFor(check: () => boolean, child: ReturnType<typeof spawn>) {
  for (const deadline = Date.now() + 15000; Date.now() < deadline; ) {
    if (check()) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Supervisor exited unexpectedly');
    await delay(25);
  }
  throw new Error('Timed out waiting for supervisor state');
}

test('supervisor can pause and resume only Gateway while keeping Worker alive', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(),'eigos-supervisor-cutover-'));
  for (const role of ['gateway','worker']) {
    mkdirSync(join(directory,'dist','apps',role),{recursive:true});
    const program = `const fs=require('node:fs'); const p=${JSON.stringify(join(directory,role+'.log'))}; fs.appendFileSync(p,'start '+process.pid+'\\n'); process.on('SIGTERM',()=>{fs.appendFileSync(p,'stopping\\n');setTimeout(()=>{fs.appendFileSync(p,'stopped\\n');process.exit(0)},300)}); setInterval(()=>{},1000);`;
    writeFileSync(join(directory,'dist','apps',role,'main.js'),program);
  }
  const child = spawn(process.execPath,[resolve('scripts/run-local.mjs'),'--built'],{cwd:directory,env:{...process.env,EIGOS_RELAY_CUTOVER_SIGNALS:'true',EIGOS_FREE_BOOKING_BROWSER_CONFIG:'',EIGOS_MANAGED_COMMERCE_SANDBOX:'false'},stdio:['ignore','pipe','pipe']});
  let output = ''; child.stdout!.on('data',bytes=>{output+=String(bytes)}); child.stderr!.on('data',bytes=>{output+=String(bytes)});
  const file = (role:string) => join(directory,role+'.log');
  const lines = (role:string) => existsSync(file(role)) ? readFileSync(file(role),'utf8').trim().split('\n') : [];
  try {
    await waitFor(()=>lines('gateway').length===1 && lines('worker').length===1,child);
    const workerStart=lines('worker')[0], firstGateway=lines('gateway')[0];
    child.kill('SIGUSR1');
    await waitFor(()=>lines('gateway').includes('stopping'),child);
    child.kill('SIGUSR2'); // An early resume cannot bypass the drain.
    await waitFor(()=>output.includes('Gateway paused; Worker remains running'),child);
    assert.deepEqual(lines('gateway'),[firstGateway,'stopping','stopped']);
    assert.deepEqual(lines('worker'),[workerStart]);
    child.kill('SIGUSR2');
    await waitFor(()=>lines('gateway').filter(line=>line.startsWith('start ')).length===2,child);
    assert.notEqual(lines('gateway').at(-1),firstGateway);
    assert.deepEqual(lines('worker'),[workerStart]);
    assert.equal(child.exitCode,null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited=once(child,'exit'); child.kill('SIGTERM');
      const timer=setTimeout(()=>child.kill('SIGKILL'),10000); timer.unref();
      await exited; clearTimeout(timer);
    }
    rmSync(directory,{recursive:true,force:true});
  }
});

test('a failed Gateway drain is not reported as a successful pause', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(),'eigos-supervisor-failure-'));
  for (const role of ['gateway','worker']) {
    mkdirSync(join(directory,'dist','apps',role),{recursive:true});
    writeFileSync(join(directory,'dist','apps',role,'main.js'), `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(join(directory,role+'.ready'))},'ready'); process.on('SIGTERM',()=>process.exit(${role === 'gateway' ? 3 : 0})); setInterval(()=>{},1000);`);
  }
  const child = spawn(process.execPath,[resolve('scripts/run-local.mjs'),'--built'],{cwd:directory,env:{...process.env,EIGOS_RELAY_CUTOVER_SIGNALS:'true',EIGOS_FREE_BOOKING_BROWSER_CONFIG:'',EIGOS_MANAGED_COMMERCE_SANDBOX:'false'},stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout!.on('data',bytes=>{output+=String(bytes)});
  try {
    await waitFor(()=>existsSync(join(directory,'gateway.ready')) && existsSync(join(directory,'worker.ready')),child);
    const exited=once(child,'exit'); child.kill('SIGUSR1');
    const [code]=await exited;
    assert.equal(code,1); assert(!output.includes('Gateway paused; Worker remains running'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited=once(child,'exit');child.kill('SIGTERM');await exited; }
    rmSync(directory,{recursive:true,force:true});
  }
});
