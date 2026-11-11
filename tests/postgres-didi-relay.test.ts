// Actual LOCAL PG, encrypted Relay, dispatcher and ServiceAgent. Upstream
// provider fetch and model choices are synthetic; this is not live DiDi proof.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../packages/core/delegation.js';
import {SecurityError} from '../packages/security/errors.js';
import {postgresDidiRelayFixture,waitForDidiRelay} from './fixtures/postgres-didi-relay.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
type Fixture=Awaited<ReturnType<typeof postgresDidiRelayFixture>>;
const canonicalTypes=['DidiPlaceObservation','RideEstimateObservation','Place','Provider','RideRoute','RideEstimate','SourceReceipt'];
async function canonicalCount(x:Fixture){return Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.ontology_objects o JOIN ${x.q}.security_object_origins s ON s.owner=o.owner AND s.type=o.type AND s.object_id=o.id AND s.object_revision=o.revision WHERE o.owner=$1 AND o.type=ANY($2::text[]) AND s.body::jsonb->>'programId'=$3`,[x.f.owner,canonicalTypes,'ride.estimate.query'])).rows[0].n);}
async function unchangedTask(x:Fixture,original:Awaited<ReturnType<Fixture['stored']>>){
  const current=await x.stored();assert.equal(current.id,original.id);assert.equal(current.contextId,original.contextId);assert.deepEqual(current.delegation!.ontologyRelease,original.delegation!.ontologyRelease);assert.deepEqual(current.delegation!.agent!.composition!.goal,x.goal);
  assert.deepEqual((await x.t.client.query(`SELECT id FROM ${x.q}.jobs`)).rows.map(row=>row.id),[original.id],'No replacement task can conceal transport or authorization failure');return current;
}

test('actual encrypted DiDi SourceAgent and PG Gateway verify canonical facts on the original native task while its live Goal refuses synthetic provider evidence',local,async()=>{
  const x=await postgresDidiRelayFixture();try{
    const original=await x.stored(),component=await x.prepare(),plan=await x.install(component),result=await x.execute(plan,AbortSignal.timeout(120000));assert(result.object);
    const row=(await x.t.client.query(`SELECT id,peer_id,connection_id,state,request,result FROM ${x.q}.security_relay_reads`)).rows[0];assert(row);assert.equal(row.state,'completed');assert.equal(row.peer_id,x.sourceNode.agentId);
    const request=JSON.parse(row.request),response=JSON.parse(row.result);assert.equal(request.context.requestId,original.id);assert.equal(request.context.intentId,plan.steps[0]!.intentId);assert.equal(response.requestDigest,digest(request));
    assert.deepEqual(x.sourceMessages,[{senderId:x.gatewayNode.agentId,id:row.id,connectionId:row.connection_id,callId:row.id}],'The dispatcher encrypted the original call ID and the real source node decrypted it');
    const ledger=x.sourceLedger();assert.equal(ledger.length,1);assert.equal(ledger[0]!.id,row.id);assert.equal(ledger[0]!.state,'completed');assert.equal(ledger[0]!.requestDigest,digest(request));assert.deepEqual(ledger[0]!.result,response,'ServiceAgent persisted its actual provider receipt before delivering the encrypted reply');
    const audit=JSON.parse(x.sourceAudit().trim());assert.deepEqual(audit.receipt,response.result.receipt);assert.equal(audit.requestId,original.id);assert.equal(audit.attemptId,request.context.attemptId);
    assert.deepEqual(x.sourceEvents.map(event=>event.stage),['request','provider_dispatch','result','delivery']);assert(x.sourceEvents.every(event=>event.outcome==='authorized'&&event.status===200));assert.equal(x.httpChecks.filter(check=>check.status===200).length,4);assert.deepEqual(x.proofReplays,[403]);
    assert.equal(x.port.reads.didiAccount,x.account);assert.equal(x.registry.entries[0]!.didi!.account,x.account);
    const outbox=(await x.t.client.query(`SELECT id,envelope,receipt FROM ${x.q}.eigos_relay_node_outbox WHERE node_id=$1`,[x.nodeId])).rows;assert.equal(outbox.length,1);assert.equal(outbox[0]!.id,row.id);assert(outbox[0]!.receipt);assert(!outbox[0]!.envelope.includes('北京西站'));assert(!outbox[0]!.envelope.includes(original.id));
    await waitForDidiRelay(async()=>Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.eigos_relay_node_inbox WHERE node_id=$1 AND sender=$2 AND state='handled'`,[x.nodeId,x.sourceNode.agentId])).rows[0].n)===1);
    const credentials=(await x.t.client.query(`SELECT node_id,agent_id,credentials FROM ${x.q}.eigos_relay_node_state`)).rows;assert.equal(credentials.length,1);assert.equal(credentials[0]!.agent_id,x.gatewayNode.agentId);assert(!credentials[0]!.credentials.includes('"signingKey"'));assert(!credentials[0]!.credentials.includes('"d":'));
    const accepted=await x.complete(component,result.object);assert.equal(accepted.accepted,false);const done=await unchangedTask(x,original),assessment=done.delegation!.agent!.composition!.assessment!;
    assert.notEqual(done.state,'completed');assert.equal(done.delegation!.acceptance,undefined);assert.equal(assessment.accepted,false);assert.equal(assessment.components[0]!.status,'verified');assert.equal(assessment.components[0]!.delivery?.evidenceLevel,'synthetic');assert.equal(assessment.criteria.find(criterion=>criterion.id==='query')!.result,'unknown','An ordinary live fact goal requires provider evidence; encrypted synthetic data does not become live evidence');assert.equal(done.artifact!.data.execution,'partial');
    const principal={...x.f.principal,access:await x.t.publisher.authenticate(x.f.principal,x.installation.token)},view=await x.commands.get(principal,original.id);assert.equal(view.id,original.id);assert.notEqual(view.state,'completed');assert.notEqual(view.accepted,true);assert(!JSON.stringify(view).includes('claimToken'));assert(!JSON.stringify(view).includes('signingKey'));
    const usage=(await x.t.client.query(`SELECT state,body FROM ${x.q}.member_model_usage WHERE job_id=$1`,[original.id])).rows;assert.equal(usage.length,3);assert(usage.every(row=>row.state==='completed'&&JSON.parse(row.body).runtime==='synthetic-encrypted-didi-native-choice'&&JSON.parse(row.body).usageReported===false&&JSON.parse(row.body).usage===undefined),'Actual acknowledged usage rows retain unknown token usage for synthetic choices, never fabricated zero cost');
    assert(done.delegation!.ontologyReads!.some(receipt=>receipt.tool==='discover_actions'&&receipt.status==='ok'));assert(done.delegation!.ontologyReads!.some(receipt=>receipt.tool==='evaluate_ontology'&&receipt.status==='ok'));assert.equal(done.runs!.filter(run=>run.ontologyMcp).length,3);
    assert.deepEqual(x.provider.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch']);assert.equal(await canonicalCount(x),5);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0].n),1);
  }finally{await x.close();}
});

test('source permission revoked while the actual encrypted ServiceAgent prepares tools blocks the real provider callback and preserves the original uncompleted task',local,async()=>{
  let x:Fixture,revoked=false;x=await postgresDidiRelayFixture({afterToolsListed:async()=>{assert.equal(x.provider.calls.filter(call=>call.method==='tools/call').length,0);revoked=true;await x.revokeSource();}});
  try{
    const original=await x.stored(),component=await x.prepare(),plan=await x.install(component);
    await assert.rejects(x.execution.execute(x.claim,plan.steps[0]!.intentId,AbortSignal.timeout(120000)),error=>error instanceof SecurityError&&error.reason==='SOURCE_NOT_AUTHORIZED');
    await waitForDidiRelay(async()=>x.sourceEvents.some(event=>event.stage==='provider_dispatch'&&event.outcome==='denied'));assert(revoked);assert.equal(x.provider.calls.filter(call=>call.method==='tools/call').length,0);assert(x.httpChecks.some(check=>check.status===403));
    const current=await unchangedTask(x,original);assert.notEqual(current.state,'completed');assert.equal(current.delegation!.acceptance,undefined);assert.equal(current.delegation!.agent!.observations.length,0);assert.equal(await canonicalCount(x),0);
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_attempts`)).rows[0].n),1);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0].n),0);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.security_relay_reads WHERE state='completed'`)).rows[0].n),0);
  }finally{await x.close();}
});

test('a receipt persisted by the real encrypted SourceAgent after provider response cannot be projected or complete the same task after source revocation',local,async()=>{
  let x:Fixture,receiptId:string|undefined;x=await postgresDidiRelayFixture({afterProviderReceipt:async result=>{receiptId=result.receipt.id;await x.revokeSource();}});
  try{
    const original=await x.stored(),component=await x.prepare(),plan=await x.install(component);
    await assert.rejects(x.execution.execute(x.claim,plan.steps[0]!.intentId,AbortSignal.timeout(120000)),error=>error instanceof SecurityError&&error.reason==='SOURCE_NOT_AUTHORIZED');
    await waitForDidiRelay(async()=>x.sourceEvents.some(event=>event.stage==='result'&&event.outcome==='denied'));assert(receiptId);const ledger=x.sourceLedger();assert.equal(ledger.length,1);assert.equal(ledger[0]!.state,'completed');assert.equal(ledger[0]!.result.result.receipt.id,receiptId,'The actual provider receipt remains private on the source for accounting/recovery');
    assert.deepEqual(x.provider.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch']);assert.equal(JSON.parse(x.sourceAudit().trim()).receipt.id,receiptId);assert(x.httpChecks.some(check=>check.status===403));
    const current=await unchangedTask(x,original);assert.notEqual(current.state,'completed');assert.equal(current.delegation!.acceptance,undefined);assert.equal(current.delegation!.agent!.observations.length,0);assert.equal(await canonicalCount(x),0);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0].n),0);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.security_relay_reads WHERE state='completed'`)).rows[0].n),0);
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_attempts`)).rows[0].n),1,'A late denied source response cannot cause a replacement dispatch');
  }finally{await x.close();}
});
