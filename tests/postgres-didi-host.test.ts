import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {readConfig} from '../packages/core/config.js';
import {didiSourceOwner,type DidiMemberConnection} from '../packages/core/didi-source.js';
import {runtimeAuthorityDigest,type RuntimeAuthority} from '../packages/core/runtime-authority.js';
import {PostgresDatabase} from '../packages/postgres/database.js';
import {PostgresRelayReadAuthority} from '../packages/postgres/relay-read-authority.js';
import {assertPostgresBuiltinSourceConfiguration,createPostgresProgramTransport,readPostgresDidiHostConfiguration} from '../packages/postgres/host-runtime.js';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'eigos-didi-host-synthetic-')),descriptorPath=join(directory,'current-descriptor.json'),authorityPath=join(directory,'authority.json'),keyPath=join(directory,'provider-key-must-not-be-opened'),auditDirectory=join(directory,'source-audit-not-opened');
  const authority:RuntimeAuthority={version:1,id:randomUUID(),revision:1,canonicalOrigin:'https://synthetic-primary.example',issuer:'https://synthetic-issuer.example/',ontologyId:'eigos.business',databasePath:join(directory,'not-opened-business.sqlite'),membershipDatabasePath:join(directory,'not-opened-members.sqlite'),ingresses:[{origin:'https://synthetic-primary.example',audience:'https://synthetic-primary.example/',tenantClaim:'tenant_id',agentClientId:'synthetic-agent',agentClientIds:['synthetic-agent'],nativeClientIds:[],browserRedirect:false,newRegistrations:true}]};
  const descriptor:DidiMemberConnection={version:1,connectionId:randomUUID(),revision:1,memberId:randomUUID(),owner:{issuer:authority.issuer,tenant:'synthetic',subject:'source-owner'},localUid:process.getuid!(),purpose:'ride_estimate_readonly',state:'active',expiresAt:new Date(Date.now()+3600000).toISOString(),binding:{bindingId:'synthetic-owned-didi',keyFile:keyPath,keySha256:'d'.repeat(64),environment:'production',auditDirectory}};
  const write=(value:DidiMemberConnection)=>writeFileSync(descriptorPath,JSON.stringify(value),{mode:0o600});write(descriptor);writeFileSync(authorityPath,JSON.stringify(authority),{mode:0o600});
  const config=readConfig({EIGOS_AUTHORITY_FILE:authorityPath,EIGOS_AUTH_MODE:'jwt',EIGOS_SECURITY_MODE:'foundation',EIGOS_STORAGE_BACKEND:'postgres',EIGOS_POSTGRES_BINDING_FILE:join(directory,'not-opened-pg-binding.json'),HOST:'127.0.0.1',PUBLIC_URL:authority.canonicalOrigin,OAUTH_ISSUER:authority.issuer,OAUTH_AUDIENCE:'https://synthetic-primary.example/',OAUTH_JWKS_URL:'https://synthetic-issuer.example/jwks',OIDC_AGENT_CLIENT_ID:'synthetic-agent',DATABASE_PATH:authority.databasePath,MEMBERSHIP_DATABASE_PATH:authority.membershipDatabasePath,EIGOS_EXECUTOR:'harness',EIGOS_HARNESS_CREDENTIAL_FILE:join(directory,'not-opened-harness.json'),EIGOS_TASK_RELAY_FILE:join(directory,'not-opened-relay.json'),EIGOS_PERSONAL_SOURCE_OWNER:didiSourceOwner(descriptor),EIGOS_DIDI_MEMBER_CONNECTION_FILE:descriptorPath,EIGOS_DIDI_RELAY_AGENT_ID:`agent_${'a'.repeat(43)}`,EIGOS_DIDI_BINDING_ID:descriptor.binding.bindingId,EIGOS_DIDI_KEY_FILE:keyPath,EIGOS_DIDI_KEY_SHA256:descriptor.binding.keySha256,EIGOS_DIDI_AUDIT_DIR:auditDirectory});
  const reference={id:authority.id,revision:authority.revision,digest:runtimeAuthorityDigest(authority)},policyDigest='c'.repeat(64);let connections=0;
  const pool={connect:async():Promise<PoolClient>=>{connections++;throw new Error('Pure host assembly cannot connect to PostgreSQL');},end:async()=>{}};
  const database=new PostgresDatabase(pool,'eigos_business_pure_didi',reference);
  const options={database,policyDigest,authority:reference};
  return {directory,descriptorPath,keyPath,descriptor,write,config,options,connections:()=>connections,close:async()=>{await database.close();rmSync(directory,{recursive:true,force:true});}};
}

test('actual Gateway DiDi transport shares one current account with Relay and registry without opening the provider Key or a database',async()=>{
  const f=fixture();try{
    const host=createPostgresProgramTransport(f.config,{...f.options,role:'gateway'}),didi=host.registry.entries.find(entry=>entry.kind==='didi');
    assert(host.taskRelay);assert.equal(host.reads,host.taskRelay.reads);assert.equal(host.reads!.didiAccount,host.account);assert.equal(didi?.didi?.account,host.account);assert(host.account?.permitted(f.config.EIGOS_PERSONAL_SOURCE_OWNER!));assert.equal(host.registry.policies().length,2);
    assert.equal(f.connections(),0);assert.equal(existsSync(f.keyPath),false);assert.equal('publisher'in host,false);assert.equal('wrappingKey'in host,false);
  }finally{await f.close();}
});

test('actual Worker DiDi transport has only its source-read authority and registry and keeps the same account',async()=>{
  const f=fixture();try{
    const host=createPostgresProgramTransport(f.config,{...f.options,role:'worker'}),didi=host.registry.entries.find(entry=>entry.kind==='didi');
    assert.equal(host.taskRelay,undefined);assert(host.reads instanceof PostgresRelayReadAuthority);assert.equal(host.reads.didiAccount,host.account);assert.equal(didi?.didi?.account,host.account);assert.equal(f.connections(),0);assert.equal(existsSync(f.keyPath),false);
    f.write({...f.descriptor,revision:2,state:'revoked'});assert.equal(host.account?.permitted(f.config.EIGOS_PERSONAL_SOURCE_OWNER!),false);assert.equal(didi?.program.permitted(f.config.EIGOS_PERSONAL_SOURCE_OWNER!),false);
  }finally{await f.close();}
});

test('DiDi host rejects incomplete flags, changed hashes and unreadable descriptors while other provider guards remain active',async()=>{
  const f=fixture();try{
    assert.throws(()=>assertPostgresBuiltinSourceConfiguration({...f.config,EIGOS_DIDI_RELAY_AGENT_ID:undefined}),/complete current member-owned readonly Relay/);
    assert.throws(()=>assertPostgresBuiltinSourceConfiguration({...f.config,EIGOS_DIDI_ORDER_TEST_ENABLED:'true'}),/order\/direct-provider/);
    assert.throws(()=>readPostgresDidiHostConfiguration({...f.config,EIGOS_DIDI_KEY_SHA256:'0'.repeat(64)}),/credential fingerprint/);
    assert.throws(()=>assertPostgresBuiltinSourceConfiguration({...f.config,EIGOS_WECHATPAY_CONNECTION_FILE:'/synthetic/not-opened.json'}),/payment-commerce/);
    chmodSync(f.descriptorPath,0o644);assert.throws(()=>readPostgresDidiHostConfiguration(f.config),/unavailable/);
    assert.equal(f.connections(),0);assert.equal(existsSync(f.keyPath),false);
  }finally{await f.close();}
});
