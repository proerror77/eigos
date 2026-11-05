import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID,generateKeyPairSync} from 'node:crypto';
import {rootCertificates} from 'node:tls';
import {digest} from '../packages/core/delegation.js';
import {runtimeAuthorityDigest,type RuntimeAuthority} from '../packages/core/runtime-authority.js';
import {readConfig} from '../packages/core/config.js';
import {postgresBindingSchema,readPostgresBinding,postgresConnectionOptions,assertPostgresBindingAuthority,postgresBindingIdentity,POSTGRES_RUNTIME_SCHEMA_CONTRACT,readPostgresRelaySecrets,readPostgresTaskRelayConfiguration,readPostgresRelaySourceInventory,type PostgresBinding} from '../packages/deployment/postgres-binding.js';
import {assertPostgresImportReceipts,assertReviewedPostgresActivation,createPostgresPrimaryHostResources,assertPostgresBuiltinSourceConfiguration,assertPostgresRelayHostConfiguration} from '../packages/postgres/host-runtime.js';
import {modelEnvironment} from '../packages/capabilities/model-process.js';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'eigos-pg-binding-'));
  const authority:RuntimeAuthority={version:1,id:randomUUID(),revision:1,canonicalOrigin:'https://primary.example',issuer:'https://identity.example/',ontologyId:'eigos.business',databasePath:join(directory,'tasks.sqlite'),membershipDatabasePath:join(directory,'members.sqlite'),
    ingresses:[{origin:'https://primary.example',audience:'https://primary.example/',tenantClaim:'tenant_id',agentClientId:'connector',agentClientIds:['connector'],nativeClientIds:[],browserRedirect:false,newRegistrations:true}]};
  const reference={id:authority.id,revision:authority.revision,digest:runtimeAuthorityDigest(authority)},sha='a'.repeat(64),policy='b'.repeat(64),ca=rootCertificates[0]!;
  const business={version:2,status:'imported-not-activated',sourceFileDigest:sha,schemaDigest:'c'.repeat(64),authorityDigest:reference.digest,policyDigest:policy,tables:[{name:'jobs',rows:1,digest:sha}]};
  const membership={version:1,status:'imported-not-activated',sourceFileDigest:'d'.repeat(64),tables:['members','member_sessions','member_connections','agent_registrations','agent_access_tokens','member_invitations'].map(table=>({table,rows:1,digest:sha}))};
  const caPath=join(directory,'ca.pem'),authorityPath=join(directory,'authority.json'),bindingPath=join(directory,'binding.json');writeFileSync(caPath,ca,{mode:0o600});writeFileSync(authorityPath,JSON.stringify(authority),{mode:0o600});
  const binding:PostgresBinding={version:1,kind:'eigos.postgres-binding',authority:reference,sourceAuthority:reference,policyDigest:policy,
    business:{schema:'eigos_business_synthetic',sourceFileDigest:business.sourceFileDigest,schemaDigest:business.schemaDigest,importPolicyDigest:policy,receiptDigest:digest(business)},membership:{schema:'eigos_membership_synthetic',sourceFileDigest:membership.sourceFileDigest,receiptDigest:digest(membership)},
    connection:{host:'db.synthetic.supabase.co',port:5432,database:'postgres',user:'synthetic_runtime.project',role:'synthetic_runtime',tls:{ca:{path:caPath,sha256:createHash('sha256').update(ca).digest('hex')}},passwordEnv:'EIGOS_POSTGRES_PASSWORD'}};
  writeFileSync(bindingPath,JSON.stringify(binding),{mode:0o600});
  const env={EIGOS_AUTH_MODE:'jwt',EIGOS_SECURITY_MODE:'foundation',PUBLIC_URL:authority.canonicalOrigin,OAUTH_ISSUER:authority.issuer,OAUTH_JWKS_URL:'https://identity.example/jwks',OAUTH_AUDIENCE:'https://primary.example/',OIDC_AGENT_CLIENT_ID:'connector',DATABASE_PATH:authority.databasePath,MEMBERSHIP_DATABASE_PATH:authority.membershipDatabasePath,EIGOS_AUTHORITY_FILE:authorityPath};
  return {directory,authority,reference,business,membership,binding,bindingPath,authorityPath,caPath,env,close:()=>rmSync(directory,{recursive:true,force:true})};
}

// Synthetic metadata only. These hash-pinned shapes exercise admission; they
// are not source snapshots, imported nodes or a completed migration receipt.
function relayFixture(f:ReturnType<typeof fixture>){
  const write=(name:string,value:unknown)=>{const path=join(f.directory,name),bytes=JSON.stringify(value);writeFileSync(path,bytes,{mode:0o600});return {path,sha256:createHash('sha256').update(bytes).digest('hex')};};
  const key=generateKeyPairSync('ed25519').privateKey.export({format:'jwk'}),enrollmentKey=write('synthetic-enrollment.json',key);
  const configuration=write('relay.json',{version:1,relayUrl:'https://relay.example'}),keyBytes=Buffer.alloc(32,7),agentId=`agent_${'a'.repeat(43)}`;
  const gatewayNode={nodeId:'synthetic-original-gateway',agentId,importDigest:'a'.repeat(64)},endpoint={endpointId:randomUUID(),agentId:`agent_${'b'.repeat(43)}`,importDigest:'b'.repeat(64)};
  const counts={outbox:0,inbox:0,retained:0},inventoryNode=(node:typeof gatewayNode)=>({...node,counts,
    importReceipt:write(`${node.nodeId.replace(':','-')}-import.json`,{status:'imported',nodeId:node.nodeId,agentId:node.agentId,digest:node.importDigest,counts}),
    independentReadback:write(`${node.nodeId.replace(':','-')}-readback.json`,{agentId:node.agentId,digest:node.importDigest,counts})});
  const inventory={version:1,kind:'eigos.relay-node-source-inventory',sourceAuthority:f.binding.sourceAuthority,businessSnapshotDigest:f.binding.business.sourceFileDigest,baseUrl:'https://relay.example',configurationDigest:configuration.sha256,
    gatewayNode:inventoryNode(gatewayNode),endpointImports:[{...inventoryNode({nodeId:`communication:${endpoint.endpointId}`,agentId:endpoint.agentId,importDigest:endpoint.importDigest}),endpointId:endpoint.endpointId}]};
  const sourceInventory=write('synthetic-inventory.json',inventory);
  const binding=postgresBindingSchema.parse({...f.binding,relay:{baseUrl:'https://relay.example',configuration,sourceInventory,wrappingKey:{env:'EIGOS_RELAY_WRAPPING_KEY',sha256:createHash('sha256').update(keyBytes).digest('hex')},enrollmentKey,gatewayNode,endpointImports:[endpoint]}});
  return {write,key,keyBytes,binding,inventory,endpoint};
}

test('host backend defaults to SQLite and requires an explicit private PG binding without credentials in Config',()=>{
  const f=fixture();try{
    assert.equal(readConfig(f.env).EIGOS_STORAGE_BACKEND,'sqlite');
    assert.throws(()=>readConfig({...f.env,EIGOS_STORAGE_BACKEND:'postgres'}),/binding/);
    assert.throws(()=>readConfig({...f.env,EIGOS_POSTGRES_BINDING_FILE:f.bindingPath}),/explicit PostgreSQL/);
    const config=readConfig({...f.env,EIGOS_STORAGE_BACKEND:'postgres',EIGOS_POSTGRES_BINDING_FILE:f.bindingPath,EIGOS_POSTGRES_PASSWORD:'synthetic-not-part-of-config'});
    assert.equal('EIGOS_POSTGRES_PASSWORD'in config,false);assertPostgresBindingAuthority(config,f.binding);
    const messaging=readConfig({...f.env,EIGOS_STORAGE_BACKEND:'postgres',EIGOS_POSTGRES_BINDING_FILE:f.bindingPath,EIGOS_MESSAGING_ENABLED:'true',EIGOS_TASK_RELAY_FILE:join(f.directory,'not-opened-relay.json')});assert.equal(messaging.EIGOS_MESSAGING_NODE_DIR,undefined);
    assert.throws(()=>readConfig({...f.env,EIGOS_MESSAGING_ENABLED:'true',EIGOS_TASK_RELAY_FILE:join(f.directory,'not-opened-relay.json')}),/private node directory/);
    assert.throws(()=>assertPostgresBindingAuthority(config,{...f.binding,authority:{...f.reference,id:randomUUID()}}),/differs/);
  }finally{f.close();}
});

test('binding files reject symlinks, permissive modes, unknown secrets and authority replacement',()=>{
  const f=fixture();try{
    assert.deepEqual(readPostgresBinding(f.bindingPath).binding,f.binding);
    const link=join(f.directory,'link.json');symlinkSync(f.bindingPath,link);assert.throws(()=>readPostgresBinding(link),/owned PostgreSQL binding/);
    chmodSync(f.bindingPath,0o644);assert.throws(()=>readPostgresBinding(f.bindingPath),/owned PostgreSQL binding/);chmodSync(f.bindingPath,0o600);
    assert.equal(postgresBindingSchema.safeParse({...f.binding,password:'synthetic-forbidden'}).success,false);
    assert.equal(postgresBindingSchema.safeParse({...f.binding,connection:{...f.binding.connection,url:'postgresql://synthetic:forbidden@db.example/postgres'}}).success,false);
    assert.equal(postgresBindingSchema.safeParse({...f.binding,sourceAuthority:{...f.reference,id:randomUUID()}}).success,false);
    assert.equal(postgresBindingSchema.safeParse({...f.binding,connection:{...f.binding.connection,proxyUrl:'http://synthetic:forbidden@127.0.0.1:8080/'}}).success,false);
  }finally{f.close();}
});

test('formal resources reject missing real handoff before credentials and cannot silently omit configured providers',async()=>{
  const f=fixture();try{
    const config=readConfig({...f.env,EIGOS_STORAGE_BACKEND:'postgres',EIGOS_POSTGRES_BINDING_FILE:f.bindingPath});
    await assert.rejects(createPostgresPrimaryHostResources(config,'worker',{}),/actual reviewed handoff and activation proofs are absent/);
    assertPostgresBuiltinSourceConfiguration(config);
    assert.throws(()=>assertPostgresBuiltinSourceConfiguration({...config,EIGOS_DIDI_KEY_FILE:'/synthetic/not-read.json'}),/DiDi/);
    assert.throws(()=>assertPostgresBuiltinSourceConfiguration({...config,EIGOS_ALIPAY_CONNECTION_FILE:'/synthetic/not-read.json'}),/payment-commerce/);
    assert.throws(()=>assertPostgresBuiltinSourceConfiguration({...config,EIGOS_FREE_BOOKING_BRIDGE_URL:'https://synthetic-booking.example'}),/booking\/registration/);
  }finally{f.close();}
});

test('PG options use a pinned valid CA and fixed runtime secret without URL or PG environment fallbacks',()=>{
  const f=fixture();try{
    const options=postgresConnectionOptions(f.binding,{EIGOS_POSTGRES_PASSWORD:'synthetic-!@#-password',PGHOST:'untrusted.example',PGPASSWORD:'ignored'});
    assert.equal(options.host,f.binding.connection.host);assert.equal(options.password,'synthetic-!@#-password');assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.ssl.servername,f.binding.connection.host);assert.equal('connectionString'in options,false);
    assert.throws(()=>postgresConnectionOptions(f.binding,{PGPASSWORD:'must-not-be-used'}),/password is unavailable/);
    assert.throws(()=>postgresConnectionOptions(f.binding,{EIGOS_POSTGRES_PASSWORD:'synthetic',PGOPTIONS:'-c role=unreviewed'}),/ambient PostgreSQL/);
    const priorBinary=process.env.PGBINARY;process.env.PGBINARY='1';try{assert.throws(()=>postgresConnectionOptions(f.binding,{EIGOS_POSTGRES_PASSWORD:'synthetic'}),/ambient PostgreSQL/);}finally{if(priorBinary===undefined)delete process.env.PGBINARY;else process.env.PGBINARY=priorBinary;}
    writeFileSync(f.caPath,'not a certificate',{mode:0o600});assert.throws(()=>postgresConnectionOptions(f.binding,{EIGOS_POSTGRES_PASSWORD:'synthetic'}),/CA differs/);
    const previous=process.env.EIGOS_POSTGRES_PASSWORD;process.env.EIGOS_POSTGRES_PASSWORD='synthetic-model-env-exclusion';try{assert.equal('EIGOS_POSTGRES_PASSWORD'in modelEnvironment(),false);}finally{if(previous===undefined)delete process.env.EIGOS_POSTGRES_PASSWORD;else process.env.EIGOS_POSTGRES_PASSWORD=previous;}
  }finally{f.close();}
});

test('Relay secret input pins existing host keys and imported identities without accepting secret JSON or creating a node',()=>{
  const f=fixture();try{
    const {key,keyBytes,binding,endpoint}=relayFixture(f),value=keyBytes.toString('base64url'),relayConfigPath=binding.relay!.configuration.path;
    assert.equal(readPostgresTaskRelayConfiguration(binding,relayConfigPath).credentialPath,undefined);assert.throws(()=>readPostgresTaskRelayConfiguration(binding,binding.relay!.enrollmentKey.path),/configuration differs/);
    const secrets=readPostgresRelaySecrets(binding,{EIGOS_RELAY_WRAPPING_KEY:value});assert.deepEqual(secrets.wrappingKeyBytes,keyBytes);assert.equal(secrets.enrollmentKey.x,key.x);secrets.wrappingKeyBytes.fill(0);
    assert.throws(()=>readPostgresRelaySecrets(binding,{}),/wrapping key is unavailable/);
    assert.throws(()=>readPostgresRelaySecrets(binding,{EIGOS_RELAY_WRAPPING_KEY:Buffer.alloc(32,8).toString('base64url')}),/differs/);
    assert.equal(postgresBindingSchema.safeParse({...binding,relay:{...binding.relay,wrappingKey:{env:'EIGOS_RELAY_WRAPPING_KEY',sha256:'a'.repeat(64),value:'must-not-be-in-JSON'}}}).success,false);
    assert.equal(postgresBindingSchema.safeParse({...binding,relay:{...binding.relay,endpointImports:[endpoint,endpoint]}}).success,false);
    const prior=process.env.EIGOS_RELAY_WRAPPING_KEY;process.env.EIGOS_RELAY_WRAPPING_KEY=value;try{assert.equal('EIGOS_RELAY_WRAPPING_KEY'in modelEnvironment(),false);}finally{if(prior===undefined)delete process.env.EIGOS_RELAY_WRAPPING_KEY;else process.env.EIGOS_RELAY_WRAPPING_KEY=prior;}
  }finally{f.close();}
});

test('Relay startup requires complete source inventory and matching whole-node import and independent readback evidence',()=>{
  const f=fixture();try{
    const {binding,inventory,write}=relayFixture(f),relay=binding.relay!;
    assert.deepEqual(readPostgresRelaySourceInventory(binding),inventory);
    const enabled={EIGOS_TASK_RELAY_FILE:relay.configuration.path,EIGOS_MESSAGING_ENABLED:'true' as const};assertPostgresRelayHostConfiguration(enabled,binding);
    assert.throws(()=>assertPostgresRelayHostConfiguration({...enabled,EIGOS_TASK_RELAY_FILE:undefined},binding),/original enabled configuration/);
    assert.throws(()=>assertPostgresRelayHostConfiguration(enabled,f.binding),/reviewed node migration/);
    assert.notEqual(postgresBindingIdentity(binding),postgresBindingIdentity(f.binding));
    const withInventory=(value:unknown)=>({...binding,relay:{...relay,sourceInventory:write('synthetic-inventory.json',value)}});
    assert.throws(()=>readPostgresRelaySourceInventory(withInventory({...inventory,endpointImports:[]})),/Complete Relay source inventory/);
    assert.throws(()=>readPostgresRelaySourceInventory(withInventory({...inventory,sourceAuthority:{...inventory.sourceAuthority,revision:inventory.sourceAuthority.revision+1}})),/Complete Relay source inventory/);
    const badNode={...inventory.gatewayNode,independentReadback:write('bad-readback.json',{agentId:inventory.gatewayNode.agentId,digest:inventory.gatewayNode.importDigest,counts:{outbox:1,inbox:0,retained:0}})};
    assert.throws(()=>readPostgresRelaySourceInventory(withInventory({...inventory,gatewayNode:badNode})),/independent readback differs/);
    const forbidden=write('unknown-readback.json',{approved:true});
    assert.throws(()=>readPostgresRelaySourceInventory(withInventory({...inventory,gatewayNode:{...inventory.gatewayNode,independentReadback:forbidden}})));
    const valid=withInventory(inventory);chmodSync(valid.relay.sourceInventory.path,0o644);assert.throws(()=>readPostgresRelaySourceInventory(valid),/evidence is unavailable/);
  }finally{f.close();}
});

test('immutable import receipt checking preserves the original source/target and policy mapping',()=>{
  const f=fixture();try{
    const evidence={business:f.business,membership:f.membership,authority:{id:f.reference.id,revision:1,configuration_digest:f.reference.digest,body:JSON.stringify(f.authority)},policyDigest:f.binding.policyDigest};
    assertPostgresImportReceipts(f.binding,evidence);
    assertPostgresImportReceipts(f.binding,{...evidence,authority:{id:f.reference.id,revision:1,configuration_digest:f.reference.digest}});
    assert.throws(()=>assertPostgresImportReceipts(f.binding,{...evidence,business:{...f.business,sourceFileDigest:'f'.repeat(64)}}),/receipts differ/);
    assert.throws(()=>assertPostgresImportReceipts(f.binding,{...evidence,authority:{...evidence.authority,id:randomUUID()}}),/authority or policy differs/);
    assert.throws(()=>assertPostgresImportReceipts(f.binding,{...evidence,policyDigest:'f'.repeat(64)}),/authority or policy differs/);
  }finally{f.close();}
});

test('primary evidence validation requires real references and never converts verifier false flags into activation',()=>{
  const f=fixture();try{
    assert.throws(()=>assertReviewedPostgresActivation(f.binding,{handoff:{},sourceFence:{},businessVerification:{},identityAudit:{},runtimeSchema:{},activation:{},businessImport:f.business}),/not ready/);
    const at='2026-11-04T00:00:00Z',file={path:join(f.directory,'not-generated.json'),sha256:'e'.repeat(64)},id=randomUUID();
    const schema={version:1,kind:'eigos.postgres-runtime-schema',businessSchema:f.binding.business.schema,baseSchemaDigest:f.binding.business.schemaDigest,contractDigest:digest(POSTGRES_RUNTIME_SCHEMA_CONTRACT),baseVerificationDigest:file.sha256,installedAt:at};
    const binding={...f.binding,handoff:file,activation:{id,receiptDigest:'f'.repeat(64),runtimeSchemaReceiptDigest:digest(schema)}};
    const handoff={version:1,kind:'eigos.postgres-handoff',activationId:id,bindingIdentity:postgresBindingIdentity(binding),sourceAuthority:f.reference,targetAuthority:f.reference,businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,sourceFence:file,businessVerification:file,identityAudit:file,reviewDigest:'a'.repeat(64)};
    const sourceFence={version:1,kind:'eigos.source-authority-fence',sourceAuthority:f.reference,businessSnapshotDigest:f.binding.business.sourceFileDigest,membershipSnapshotDigest:f.binding.membership.sourceFileDigest,fencedAt:at,gatewayStopReceiptDigest:file.sha256,workerDrainReceiptDigest:file.sha256,claimsObservationDigest:file.sha256,authorityFenceReceiptDigest:file.sha256};
    const verification={version:1,status:'verified-at-snapshot',transactionStartedAt:at,sourceFileDigest:f.business.sourceFileDigest,schemaDigest:f.business.schemaDigest,authorityDigest:f.reference.digest,policyDigest:f.business.policyDigest,tables:f.business.tables,sequenceObservation:{checked:1,atomicWithRows:false},writerFenceVerified:false,runtimeActivated:false};
    const identity={version:1,status:'audit-only',checkedAt:Date.parse(at),activeSubjects:0,mismatchedSubjects:0,runtimeActivated:false};
    assert.throws(()=>assertReviewedPostgresActivation(binding,{handoff,sourceFence,businessVerification:{...verification,writerFenceVerified:true},identityAudit:identity,runtimeSchema:schema,activation:{},businessImport:f.business}));
    assert.throws(()=>assertReviewedPostgresActivation(binding,{handoff,sourceFence,businessVerification:verification,identityAudit:identity,runtimeSchema:schema,activation:{approved:true},businessImport:f.business}));
    // Pure shape/equality coverage only: these synthetic references are not
    // files, database records or evidence that any actual writer stopped.
    const activation={version:1,kind:'eigos.postgres-activation',id,bindingIdentity:postgresBindingIdentity(binding),sourceAuthority:f.reference,targetAuthority:f.reference,businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,
      handoffDigest:file.sha256,sourceFenceDigest:file.sha256,businessVerificationDigest:file.sha256,identityAuditDigest:file.sha256,runtimeSchemaReceiptDigest:binding.activation.runtimeSchemaReceiptDigest,reviewDigest:handoff.reviewDigest};
    binding.activation.receiptDigest=digest(activation);
    assertReviewedPostgresActivation(binding,{handoff,sourceFence,businessVerification:verification,identityAudit:identity,runtimeSchema:schema,activation,businessImport:f.business});
    assert.equal(verification.writerFenceVerified,false);assert.equal(verification.runtimeActivated,false);
  }finally{f.close();}
});
