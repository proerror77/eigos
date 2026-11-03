import {SecurityError} from '../packages/security/errors.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertPostgresPlanningDiscoveryContext} from '../packages/postgres/native-planning-session.js';
import {resolvePostgresDocumentBinding} from '../packages/postgres/document-bindings.js';
import {postgresGoalFixture} from './fixtures/postgres-goal.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
test('actual native Doc discovery returns the same source pin and closes its host-only callback capability',local,async()=>{
  const x=await postgresGoalFixture();try{
    const selected=await x.prepareDecision(),page=selected.page;assert.deepEqual(page.items[0]!.bindings[0]!.pin,x.sourcePage.items[0]!.bindings[0]!.pin);assert.deepEqual(page.items[0]!.bindings[0]!.inputSchema,x.sourcePage.items[0]!.bindings[0]!.inputSchema);
    assert.equal(page.authorization,'per_action_required');assert.equal(page.items[0]!.bindings[0]!.readiness,'ready');assert(!JSON.stringify(page).includes('assertActive'));
    const host=x.capturedContext();assert(host);assert(Object.isFrozen(host));assert.throws(()=>host.assertActive(),/AUTHORIZATION_REQUIRED/);assert.throws(()=>assertPostgresPlanningDiscoveryContext(Object.freeze({...host,assertActive:()=>{}})),/AUTHORIZATION_REQUIRED/);
    await x.t.database.run(async()=>{assert.throws(()=>host.assertActive(),/AUTHORIZATION_REQUIRED/);});
    await x.t.database.run(async client=>{const resolved=await resolvePostgresDocumentBinding(client,x.claim,x.request,page.items[0]!.bindings[0]!.pin,x.options);assert.deepEqual(resolved.program.ref,x.program.ref);});
    const wrong={...page.items[0]!.bindings[0]!.pin,requestId:'foreign-task'};await assert.rejects(x.t.database.run(client=>resolvePostgresDocumentBinding(client,x.claim,x.request,wrong,x.options)),/POLICY_CHANGED/);
  }finally{await x.close();}
});

test('Doc binding resolution checks the current namespace role and actual source after an earlier discovery receipt',local,async()=>{
  const x=await postgresGoalFixture();try{
    const selected=await x.prepareDecision(),pin=selected.page.items[0]!.bindings[0]!.pin;
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);await assert.rejects(x.t.database.run(client=>resolvePostgresDocumentBinding(client,x.claim,x.request,pin,x.options)),error=>error instanceof SecurityError&&error.reason==='SOURCE_NOT_AUTHORIZED');
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='active' WHERE binding_id=$1`,[x.bindingId]);
    const row=(await x.t.client.query(`SELECT id,body FROM ${x.q}.security_roles WHERE subject_id=$1`,[x.installation.id])).rows[0]!;
    await x.t.client.query(`UPDATE ${x.q}.security_roles SET body=$1 WHERE id=$2`,[JSON.stringify({...JSON.parse(row.body),role:'Editor',resource:{kind:'actionType',id:'NonexistentAction'}}),row.id]);
    await assert.rejects(x.t.database.run(client=>resolvePostgresDocumentBinding(client,x.claim,x.request,pin,x.options)),error=>error instanceof SecurityError&&['AUTHORIZATION_REQUIRED','INSUFFICIENT_ACCESS','AUTHORITY_UNAVAILABLE'].includes(error.reason));
  }finally{await x.close();}
});
