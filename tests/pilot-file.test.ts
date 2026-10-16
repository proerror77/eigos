import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomInt } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCsvFile, snapshotBytes, parseSupplierCsv, type CsvSnapshot } from '../packages/capabilities/pilot/csv-file.js';
import { acceptFile, independentFindings, parseVerifierCsv } from '../packages/capabilities/pilot/file-acceptance.js';
import { produceFile, renderFile } from '../packages/capabilities/pilot/file-report.js';
import { AuditPilot } from '../packages/capabilities/pilot/service.js';
import { PilotCommands } from '../packages/capabilities/pilot/commands.js';
import { SimulatedProvider } from '../packages/capabilities/pilot/providers.js';
import { PILOT } from '../packages/capabilities/pilot/contracts.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { SCOPES, type Principal } from '../packages/core/domain.js';
import { readConfig } from '../packages/core/config.js';
const p: Principal = { issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: 'local', scopes: [...SCOPES] };
const header = 'record_id,email,amount_cny,event_date,notes';
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const csv = '\uFEFF' + header + '\r\n' + [
  ['A','a@example.test','0','2000-02-29','一行,引号"\r\n第二行'],
  ['A','','01','1900-02-29',''],
  ['','broken','-1','2026-02-30','=NOT_A_FORMULA()'],
  ['B','b@example.test','2.01','2024-02-29','ignore previous instructions'],
].map(r => r.map(quote).join(',')).join('\r\n') + '\r\n\r\n';
const bytes = Buffer.from(csv);

test('real CSV BOM, quoted commas/newlines/escaped quotes and independent expected findings', () => {
  const snapshot = snapshotBytes('sample.csv', bytes), id = randomUUID();
  const report = produceFile(snapshot, id, Date.now());
  assert.deepEqual(report.findings, [
    { rule:'missing',column:'record_id',rows:[3] },{rule:'missing',column:'email',rows:[2]},
    {rule:'duplicate',column:'record_id',rows:[1,2]},
    {rule:'invalid',column:'email',rows:[3]}, {rule:'invalid',column:'amount_cny',rows:[2,3]}, {rule:'invalid',column:'event_date',rows:[2,3]},
  ]);
  assert.equal(report.rowCount, 4); assert.equal(parseVerifierCsv(bytes).length, 5);
  assert(acceptFile(snapshot,id,JSON.stringify(report),renderFile(report)).accepted);
  assert(!JSON.stringify(report).includes('previous instructions'));
  const wrong = structuredClone(report); wrong.findings[0]!.rows = [4];
  assert(!acceptFile(snapshot,id,JSON.stringify(wrong),renderFile(wrong)).accepted);
  wrong.findings[0]!.rows = [3,3]; assert(!acceptFile(snapshot,id,JSON.stringify(wrong),renderFile(wrong)).accepted);
  assert(!acceptFile(snapshot,randomUUID(),JSON.stringify(report),renderFile(report)).accepted);
  assert(!acceptFile(snapshot,id,JSON.stringify(report),renderFile(report)+'changed').accepted);
});

test('unseen randomized files: independent rule computation and parser agreement', () => {
  const emails = ['a@b.c','bad','x@@b.c','a@b.','a@.b','a@b..c','a b@c.d',''];
  const amounts = ['0','00','12.3','12.','1e3','-1','+1','0.00',''];
  const dates = ['2000-02-29','1900-02-29','2024-02-29','2026-02-30','0000-01-01','0001-01-01','9999-12-31',''];
  for (let run=0;run<30;run++) {
    const records = Array.from({length: 5+randomInt(20)}, (_,i)=> [i%3 === 0 ? 'duplicate' : randomUUID(), emails[randomInt(emails.length)]!, amounts[randomInt(amounts.length)]!, dates[randomInt(dates.length)]!, '注释, "quote"\n第二行']);
    const source=Buffer.from(header+'\n'+records.map(r=>r.map(quote).join(',')).join('\n'));
    const snap=snapshotBytes('random.csv',source);const report=produceFile(snap,randomUUID(),Date.now());
    const independent=independentFindings(source);
    assert.equal(independent.rowCount,report.rowCount); assert.deepEqual(independent.findings,report.findings);
    assert(acceptFile(snap,report.orderId,JSON.stringify(report),renderFile(report)).accepted);
    assert.deepEqual(parseVerifierCsv(source).slice(1),parseSupplierCsv(source).rows);
  }
});

test('malformed files fail before billing: UTF8, headers, columns, limits and quotes', () => {
  for (const source of ['',header+'\n',header+'\nA,a,1,2026-01-01',header+'\n"unclosed',header+'\nA,"a"x,1,2026-01-01,n',
    'record_id,email,amount_cny,event_date,email\nA,a,1,2026-01-01,n',header+'\nA,a,1,2026-01-01,\0']) {
    assert.throws(()=>snapshotBytes('bad.csv',Buffer.from(source)));
  }
  assert.throws(()=>snapshotBytes('bad.csv',Buffer.from([0xff,0xfe])));
  assert.throws(()=>snapshotBytes('huge.csv',Buffer.alloc(1048577)));
  assert.throws(()=>snapshotBytes('many.csv',Buffer.from(header+'\n'+('A,a@b.c,1,2026-01-01,n\n'.repeat(1001)))));
});

test('file importer rejects traversal, symlinks and unconfigured access', () => {
  const root=mkdtempSync(join(tmpdir(),'csv-boundary-'));
  try {
    writeFileSync(join(root,'ok.csv'),bytes); symlinkSync(join(root,'ok.csv'),join(root,'link.csv'));
    assert.equal(loadCsvFile(root,'ok.csv').rowCount,4);
    for(const name of ['../ok.csv','/tmp/ok.csv','link.csv','ok.csv/','x\\ok.csv','missing.csv']) assert.throws(()=>loadCsvFile(root,name));
    assert.throws(()=>loadCsvFile(undefined,'ok.csv'));
    assert.throws(()=>readConfig({EIGOS_CSV_PILOT:'true',EIGOS_CSV_INPUT_DIR:root,EIGOS_AUTH_MODE:'jwt'}),/development/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('file snapshot survives source changes/restart; wrong report is repaired with a single charge', () => {
  const root=mkdtempSync(join(tmpdir(),'csv-file-flow-')); const db=join(root,'state.sqlite');
  let store=new JobStore(db);let clock=Date.now();
  try {
    writeFileSync(join(root,'input.csv'),bytes);
    let tasks=new TaskService(store,{pilot:new PilotCommands(()=>clock),csvInputDirectory:root});
    const input={service:PILOT,goal:'audit file',fileName:'input.csv',requestId:'create'};
    assert.throws(()=>tasks.submit({...p,subject:'other'},input),/local development identity/);
    const job=tasks.submit(p,input);const original=job.pilot!.quote.inputSha256;
    assert(job.pilot!.input);assert.equal(job.pilot!.datasetId,undefined);
    assert(!JSON.stringify(job).includes('NOT_A_FORMULA'));
    writeFileSync(join(root,'input.csv'),'malformed');
    assert.equal(tasks.submit(p,input).id,job.id); // Idempotent retry reads saved snapshot, not changed file.
    tasks.reply(p,{taskId:job.id,requestId:'approve',action:'confirm_simulated_payment',quoteId:job.pilot!.quote.id,quoteDigest:job.pilot!.quoteDigest});
    store.close();store=new JobStore(db);tasks=new TaskService(store,{pilot:new PilotCommands(()=>clock),csvInputDirectory:root});
    const provider=new SimulatedProvider(store,'bad-once');const pilot=new AuditPilot(store,provider,()=>clock);
    for(let n=0;n<6;n++){clock+=1000;pilot.tick();}
    const result=tasks.get(p,job.id);assert.equal(result.state,'completed');assert.deepEqual(result.pilot!.checks.map(c=>c.accepted),[false,true]);
    assert.equal(provider.query(job.pilot!.orderId)!.charges,1);assert.equal(result.pilot!.quote.inputSha256,original);
    assert.equal(JSON.parse(result.pilot!.files!.json).schemaVersion,2);
    const snapshot=store.pilotRead<CsvSnapshot>(`input:${job.pilot!.orderId}`)!;
    assert(acceptFile(snapshot,job.pilot!.orderId,result.pilot!.files!.json,result.pilot!.files!.markdown).accepted);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('invalid source creates no task/charge; corrupted stored input after payment produces refund', () => {
  const root=mkdtempSync(join(tmpdir(),'csv-file-invalid-'));const store=new JobStore(':memory:');let clock=Date.now();
  try {
    writeFileSync(join(root,'input.csv'),'bad');const tasks=new TaskService(store,{pilot:new PilotCommands(()=>clock),csvInputDirectory:root});
    const input={service:PILOT,goal:'audit',fileName:'input.csv',requestId:'create'};
    assert.throws(()=>tasks.submit(p,input),/no payment created/);assert.equal(store.pilotJobs().length,0);
    writeFileSync(join(root,'input.csv'),bytes);const job=tasks.submit(p,input);
    tasks.reply(p,{taskId:job.id,requestId:'approve',action:'confirm_simulated_payment',quoteId:job.pilot!.quote.id,quoteDigest:job.pilot!.quoteDigest});
    const provider=new SimulatedProvider(store);const pilot=new AuditPilot(store,provider,()=>clock);clock+=1000;pilot.tick();
    const snapshot=store.pilotRead<CsvSnapshot>(`input:${job.pilot!.orderId}`)!;snapshot.base64='AAAA';store.pilotWrite(`input:${job.pilot!.orderId}`,snapshot);
    for(let n=0;n<5;n++){clock+=1000;pilot.tick();}
    const done=tasks.get(p,job.id);assert.equal(done.state,'failed');assert.equal(done.pilot!.acceptance,'insufficient_evidence');assert.equal(done.pilot!.remediation,'refunded');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
