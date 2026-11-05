import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {JobStore} from '../packages/core/store.js';
import {digest} from '../packages/core/delegation.js';
import {upgradeRideSources} from '../packages/security/ride-sources-upgrade.js';
import {securityFixture} from './fixtures/security.js';
test('explicit SQLite v30 activation and policy upgrade are atomic, generation-bound and add no grant',{timeout:300000},()=>{
 const f=securityFixture(),db=new DatabaseSync(f.database);try{
  const ns=f.jobs.definitions.namespace(),expected={release:ns.active,generation:ns.generation,digest:f.jobs.security.policies.definitionDigest,revision:f.jobs.security.policies.revision()};f.coordinator.close();
  const sources=db.prepare('SELECT * FROM security_sources').all(),grants=db.prepare('SELECT * FROM security_grants').all(),roles=db.prepare('SELECT * FROM security_roles').all();
  const before=()=>({policy:db.prepare('SELECT * FROM security_policy_definitions').all(),namespace:db.prepare('SELECT * FROM ontology_namespaces').all(),releases:db.prepare('SELECT * FROM ontology_definition_releases').all()});const original=before();
  assert.equal(upgradeRideSources(db,expected).applied,false);assert.deepEqual(before(),original);assert.throws(()=>upgradeRideSources(db,{...expected,generation:expected.generation+1},true),/generation/);assert.deepEqual(before(),original);
  db.exec("CREATE TRIGGER synthetic_upgrade_failure BEFORE UPDATE ON security_policy_definitions BEGIN SELECT RAISE(ABORT,'synthetic policy failure'); END");assert.throws(()=>upgradeRideSources(db,expected,true),/synthetic policy failure/);assert.deepEqual(before(),original);db.exec('DROP TRIGGER synthetic_upgrade_failure');
  const applied=upgradeRideSources(db,expected,true);assert.equal(applied.actionsAdded,0);assert.equal(applied.functionsAdded,0);assert.equal(applied.expiryExtended,false);assert.equal(applied.generationAfter,ns.generation+1);assert.equal(applied.targetModel.version,'30');
  assert.deepEqual(db.prepare('SELECT * FROM security_sources').all(),sources);assert.deepEqual(db.prepare('SELECT * FROM security_grants').all(),grants);assert.deepEqual(db.prepare('SELECT * FROM security_roles').all(),roles);
  const reopened=new JobStore(f.database,{securityMode:'foundation'});try{assert.equal(reopened.security.model.ref.version,'30');assert.equal(reopened.ontology.model.ref.version,'30');assert.equal(reopened.security.policies.definitionDigest,applied.after);const draft=reopened.definitions.createDraft('synthetic-operator','eigos.business','Identical definitions, new release label',true),published=reopened.definitions.publish('synthetic-operator',draft.id,draft.revision,true);reopened.definitions.activate('synthetic-operator',published.release,reopened.definitions.namespace().generation,true);}finally{reopened.close();}
  const relabeled=new JobStore(f.database,{securityMode:'foundation'});try{assert.equal(relabeled.security.model.ref.version,'30');assert.equal(relabeled.ontology.model.ref.digest,applied.targetModel.digest);assert.notEqual(relabeled.ontology.model.ref.version,'30');}finally{relabeled.close();}
  assert.throws(()=>upgradeRideSources(db,expected,true),/generation/);
 }finally{db.close();f.close();}
});
