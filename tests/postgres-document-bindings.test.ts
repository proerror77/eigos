import {SecurityError} from '../packages/security/errors.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertPostgresPlanningDiscoveryContext} from '../packages/postgres/native-planning-session.js';
import {resolvePostgresDocumentBinding,postgresReadRegistry,type PostgresDocumentBindingOptions} from '../packages/postgres/document-bindings.js';
import {roleSchema} from '../packages/security/resource-role.js';
import {postgresGoalFixture} from './fixtures/postgres-goal.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
test('default document registration retains identity within its original host options and changes with source configuration',()=>{
  const options:PostgresDocumentBindingOptions={policyDigest:'a'.repeat(64),modelChannel:'synthetic-metadata-only',sourceBindingId:'original-source',inspectClaim:async()=>undefined};
  const original=postgresReadRegistry(options);assert.strictEqual(postgresReadRegistry(options),original);assert.strictEqual(postgresReadRegistry(options).entries[0],original.entries[0]);
  assert.notStrictEqual(postgresReadRegistry({...options}),original,'Independent host scopes never share mutable registration instances');
  options.sourceBindingId='changed-source';const changed=postgresReadRegistry(options);assert.notStrictEqual(changed,original);assert.equal(changed.entries[0]!.sourceBindingId,'changed-source');
  options.policyDigest='b'.repeat(64);assert.notStrictEqual(postgresReadRegistry(options),changed);
  options.registry=original;assert.strictEqual(postgresReadRegistry(options),original,'An explicitly installed registry retains its own original instance');
});
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
    const original=JSON.parse(row.body),unrelated=roleSchema.parse({...original,role:'Editor',resource:{kind:'namespace',id:'unrelated-namespace',version:original.resource.version}});
    await x.t.client.query(`UPDATE ${x.q}.security_roles SET body=$1 WHERE id=$2`,[JSON.stringify(unrelated),row.id]);
    await assert.rejects(x.t.database.run(client=>resolvePostgresDocumentBinding(client,x.claim,x.request,pin,x.options)),error=>error instanceof SecurityError&&['AUTHORIZATION_REQUIRED','INSUFFICIENT_ACCESS','AUTHORITY_UNAVAILABLE'].includes(error.reason));
  }finally{await x.close();}
});
