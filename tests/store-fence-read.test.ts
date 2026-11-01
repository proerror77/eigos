import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JobStore} from '../packages/core/store.js';
import {TaskService} from '../packages/core/tasks.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {owner,principal} from './backend-fixture.js';

// Separate-connection mutations exercise fresh ledger reads, never a cached Job.
test('scalar lease fences preserve ownership, revisions, cancellation, recovery and corrupt JSON semantics',()=>{
 const directory=mkdtempSync(join(tmpdir(),'eigos-fence-read-')),path=join(directory,'tasks.sqlite'),store=new JobStore(path),db=new DatabaseSync(path);
 try {
  const tasks=new TaskService(store,{catalog:new ExecutionCatalog([],[],[])}),job=tasks.submit(principal,{service:'eigos.delegate',requestId:randomUUID(),goal:'Synthetic no-execution fence check'}),claim=store.claim(['eigos.delegate'],120000)!;
  const baseline=JSON.stringify(store.get(owner,job.id)),original=JSON.parse(baseline);
  const write=(body:string,state=original.state)=>db.prepare('UPDATE jobs SET body=?,state=? WHERE id=?').run(body,state,job.id);
  const ownershipReads=[()=>store.intents('wrong-owner',job.id),()=>store.grants('wrong-owner',job.id),()=>store.preparationContext('wrong-owner',job.id,'x'),()=>store.hasPreparationContext('wrong-owner',job.id,'x'),()=>store.afterSales('wrong-owner',job.id),()=>store.resultFeedback('wrong-owner',job.id),()=>store.hasClaim('wrong-owner',job.id)];
  for(const read of ownershipReads)assert.throws(read,/Task not found/);
  assert(store.claimActive(claim));
  const detached=store.get(owner,job.id);detached.state='canceled';assert(store.claimActive(claim),'Returned Job remains a detached value');
  write(JSON.stringify({...original,state:'canceled'}));assert.equal(store.claimActive(claim),false,'Read body state even if another connection leaves the indexed column unchanged');
  write(JSON.stringify({...original,revision:original.revision+1}));assert.equal(store.claimActive(claim),false);
  write(JSON.stringify({...original,delegation:{...original.delegation,request:{...original.delegation.request,revision:2}}}));assert.equal(store.claimActive(claim),false);
  write(JSON.stringify({...original,revision:true}));assert.equal(store.claimActive(claim),false,'Boolean is not numeric revision 1');
  write(baseline.replace('"state":"working"','"state":"working","state":"canceled"'));assert.equal(store.get(owner,job.id).state,'canceled');assert.equal(store.claimActive(claim),false);
  write(baseline.replace('"state":"working"','"state":"canceled","state":"working"'));assert.equal(store.get(owner,job.id).state,'working');assert(store.claimActive(claim),'Duplicate-key fallback retains JSON.parse last-key semantics');
  const request=JSON.stringify(original.delegation.request);
  write(baseline.replace(request,'{"revision":2,'+request.slice(1)));assert(store.claimActive(claim),'Nested duplicate revision uses the last value');
  write(baseline.replace(request,request.slice(0,-1)+',"revision":2}'));assert.equal(store.claimActive(claim),false,'A later nested revision fences the old claim');
  write('{"delegation":'+JSON.stringify({...original.delegation,request:{...original.delegation.request,revision:2}})+','+baseline.slice(1));assert(store.claimActive(claim),'Duplicate delegation also retains the last object');
  write('{broken','paused');for(const read of [()=>store.get(owner,job.id),()=>store.intents(owner,job.id),()=>store.grants(owner,job.id),()=>store.claimActive(claim)])assert.throws(read,SyntaxError);
  write(baseline);store.release(claim);
  const recoveryBody={...original,state:'canceled',delegation:{...original.delegation,recoveryPending:true}};
  write(JSON.stringify(recoveryBody),'canceled');const recovery=store.claim(['eigos.delegate'],120000)!;assert(recovery.recovery);assert(store.claimActive(recovery));
  for(const value of [false,null,1,'true']){write(JSON.stringify({...recoveryBody,delegation:{...recoveryBody.delegation,recoveryPending:value}}),'canceled');assert.equal(store.claimActive(recovery),false);}
  write(JSON.stringify(recoveryBody),'canceled');assert(store.claimActive(recovery));store.release(recovery);
 }finally{db.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('lease fencing does not materialize unrelated large task histories into temporary blob tables',t=>{
 const store=new JobStore(':memory:'),db=(store as unknown as {db:DatabaseSync}).db;
 try {
  const tasks=new TaskService(store,{catalog:new ExecutionCatalog([],[],[])}),job=tasks.submit(principal,{service:'eigos.delegate',requestId:randomUUID(),goal:'Synthetic large-history fence'});
  db.prepare("UPDATE jobs SET body=json_set(body,'$.unrelatedHistoricalPayload',?) WHERE id=?").run('synthetic-history'.repeat(500000),job.id);
  const claim=store.claim(['eigos.delegate'],120000)!;let query='';const prepare=db.prepare.bind(db);
  t.mock.method(db,'prepare',(sql:string)=>{if(sql.startsWith('WITH source AS'))query=sql;return prepare(sql);});
  assert(store.claimActive(claim));assert(query);
  const plan=prepare('EXPLAIN QUERY PLAN '+query).all(owner,job.id);
  assert(!plan.some(row=>/MATERIALIZE (source|owned)/.test(String(row.detail))),JSON.stringify(plan));
  store.release(claim);
 }finally{store.close();}
});
