import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {postgresHandoffFixture} from './fixtures/postgres-handoff.js';
import {previewPostgresHandoff,readPostgresHandoffOperation,postgresRuntimeGrantPlan,postgresHandoffOperationSchema} from '../packages/deployment/postgres-handoff.js';

test('handoff defaults to a pure preview without asserting stop or activation and preserves exact authority revision',()=>{
  const f=postgresHandoffFixture();try{
    const preview=previewPostgresHandoff(f.operation);assert.equal(preview.status,'preview-only');assert.equal(preview.runtimeActivated,false);assert.equal(preview.sourceAuthority.revision,4);assert.equal(preview.writeScope,'exact-runtime-extension-and-acl-only');
    assert.equal('sourceStopped'in preview,false);assert.equal('approved'in preview,false);
    assert.equal(postgresHandoffOperationSchema.safeParse({...f.operation,approved:true}).success,false);
    assert.throws(()=>readPostgresHandoffOperation({...f.operation,businessSnapshot:{...f.operation.businessSnapshot,sha256:'0'.repeat(64)}}),/Source snapshots differ/);
    const different={...f.binding,authority:{...f.binding.authority,revision:5}},ref=f.write('different-binding.json',different);
    assert.throws(()=>readPostgresHandoffOperation({...f.operation,binding:ref}),/exact original authority/);
  }finally{f.close();}
});

test('handoff requires the actual raw fence hashes and unchanged verifier false flags, with a separate activation review',()=>{
  const f=postgresHandoffFixture();try{
    writeFileSync(f.operation.fenceReceipts.gatewayStop.path,'synthetic changed stop output',{mode:0o600});
    assert.throws(()=>readPostgresHandoffOperation(f.operation),/receipt changed/);
    const restored=f.write('synthetic-stop.json',{synthetic:'gateway-stop'});assert.equal(restored.sha256,f.operation.fenceReceipts.gatewayStop.sha256);
    const dishonest=f.write('verification.json',{...f.verification,writerFenceVerified:true});
    assert.throws(()=>readPostgresHandoffOperation({...f.operation,businessVerification:dishonest}));
    f.write('verification.json',f.verification);
    assert.throws(()=>readPostgresHandoffOperation({...f.operation,phase:'activate'}),/separate reviewed final binding/);
  }finally{f.close();}
});

test('fixed runtime ACL plan preserves authority, history and activation protection and never grants DDL or TRUNCATE',()=>{
  const f=postgresHandoffFixture();try{
    const grants=postgresRuntimeGrantPlan(f.binding,f.plan.tables.map(t=>t.name)),tables=grants.business.tables;
    assert.deepEqual(tables.runtime_authority,[]);assert.deepEqual(tables.eigos_runtime_activation,['SELECT']);assert.deepEqual(tables.eigos_runtime_schema_receipt,['SELECT']);assert.deepEqual(tables.security_policy_definitions,['SELECT']);
    assert.deepEqual(tables.action_attempts,['SELECT','INSERT']);assert.deepEqual(tables.ontology_object_versions,['SELECT','INSERT']);assert.deepEqual(tables.eigos_relay_node_state,['SELECT','INSERT']);
    assert.deepEqual(tables.ontology_projection_epochs,['SELECT','INSERT','UPDATE']);assert.deepEqual(tables.ontology_projection_checkpoints,['SELECT']);
    assert(!grants.business.functions.includes('eigos_projection_epoch_invalidate()'));
    for(const group of [grants.business,grants.membership])for(const privileges of Object.values(group.tables))assert(privileges.every(value=>['SELECT','INSERT','UPDATE','DELETE'].includes(value)));
    assert(!grants.business.functions.includes('eigos_immutable_history()'));assert(!grants.business.sequencePrivileges.includes('UPDATE'));
    assert.throws(()=>postgresRuntimeGrantPlan(f.binding,['jobs; DROP SCHEMA public CASCADE']),/Invalid reviewed/);
    assert.throws(()=>postgresRuntimeGrantPlan(f.binding,['eigos_runtime_activation']),/Invalid reviewed/);
  }finally{f.close();}
});

test('handoff CLI help performs no database operation and does not accept a source-stopped or credential argument',()=>{
  const help=spawnSync(process.execPath,['scripts/postgres-primary-handoff.mjs','--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/\[--apply/);
  const rejected=spawnSync(process.execPath,['scripts/postgres-primary-handoff.mjs','--source-stopped'],{encoding:'utf8'});assert.equal(rejected.status,2);assert.match(rejected.stderr,/Usage:/);
});
