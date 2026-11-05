import {mkdtempSync,chmodSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {JobStore} from '../../packages/core/store.js';
import {MemberStore} from '../../packages/members/store.js';
import {installRuntimeAuthority,runtimeAuthorityDigest,type RuntimeAuthority} from '../../packages/core/runtime-authority.js';
import {planBusinessSnapshot} from '../../packages/postgres/business-snapshot.js';
import {compileBusinessSchema} from '../../packages/postgres/business-schema.js';
import {digest} from '../../packages/core/delegation.js';
import type {PostgresBinding} from '../../packages/deployment/postgres-binding.js';

/** Entirely synthetic/local source. Pure tests write representative receipt
 * shapes; PG tests replace those with outputs from actual read verifiers.
 * No real user, provider, source-stop or production activation is represented. */
export function postgresHandoffFixture(){
  const directory=mkdtempSync(join(tmpdir(),'eigos-synthetic-handoff-')),business=join(directory,'business.sqlite'),membership=join(directory,'membership.sqlite');
  try{
  const write=(name:string,value:unknown)=>{const path=join(directory,name),bytes=JSON.stringify(value);writeFileSync(path,bytes,{mode:0o600});return {path,sha256:createHash('sha256').update(bytes).digest('hex')};};
  const jobs=new JobStore(business,{securityMode:'foundation'});jobs.createMessagingStore();jobs.createNetworkStore();const policy=jobs.security.policies.definitionDigest;jobs.close();
  const members=new MemberStore(membership);members.close();
  const authority:RuntimeAuthority={version:1,id:randomUUID(),revision:4,canonicalOrigin:'https://synthetic-handoff.example',issuer:'https://synthetic-identity.example/',ontologyId:'eigos.business',databasePath:business,membershipDatabasePath:membership,
    ingresses:[{origin:'https://synthetic-handoff.example',audience:'https://synthetic-handoff.example/',tenantClaim:'tenant_id',agentClientId:'synthetic-connector',agentClientIds:['synthetic-connector'],nativeClientIds:[],browserRedirect:false,newRegistrations:true}]};
  const sqlite=new DatabaseSync(business);for(let revision=1;revision<=authority.revision;revision++)installRuntimeAuthority(sqlite,{...authority,revision},revision===1?undefined:runtimeAuthorityDigest({...authority,revision:revision-1}));sqlite.exec('PRAGMA journal_mode=DELETE');const mapping=compileBusinessSchema(sqlite);sqlite.close();
  const memberSqlite=new DatabaseSync(membership);memberSqlite.exec('PRAGMA journal_mode=DELETE');memberSqlite.close();chmodSync(business,0o600);chmodSync(membership,0o600);
  const plan=planBusinessSnapshot(business,runtimeAuthorityDigest(authority),policy);
  const id=randomUUID().replaceAll('-',''),role=`eigos_handoff_${id}`,reference=plan.authority;
  // Snapshot digests are read through an owned descriptor by the real tool.
  // The tests use only their new temporary files, never a host database path.
  const membershipDigest=hashFileForFixture(membership);
  const businessReceipt={version:2,status:'imported-not-activated',sourceFileDigest:plan.fileDigest,schemaDigest:plan.schemaDigest,authorityDigest:reference.digest,policyDigest:policy,tables:plan.tables.map(t=>({name:t.name,rows:t.rows,digest:t.digest}))};
  const membershipReceipt={version:1,status:'imported-not-activated',sourceFileDigest:membershipDigest,tables:['members','member_sessions','member_connections','agent_registrations','agent_access_tokens','member_invitations'].map(table=>({table,rows:0,digest:createHash('sha256').digest('hex')}))};
  const binding:PostgresBinding={version:1,kind:'eigos.postgres-binding',authority:reference,sourceAuthority:reference,policyDigest:policy,business:{schema:`eigos_business_${id}`,sourceFileDigest:plan.fileDigest,schemaDigest:plan.schemaDigest,importPolicyDigest:policy,receiptDigest:digest(businessReceipt)},membership:{schema:`eigos_membership_${id}`,sourceFileDigest:membershipDigest,receiptDigest:digest(membershipReceipt)},connection:{host:'db.synthetic.example',port:5432,database:'postgres',user:role,role,passwordEnv:'EIGOS_POSTGRES_PASSWORD',tls:{ca:{path:join(directory,'not-opened-synthetic-ca.pem'),sha256:'a'.repeat(64)}}}};
  const now=Date.now(),fenceReceipts={gatewayStop:write('synthetic-stop.json',{synthetic:'gateway-stop'}),workerDrain:write('synthetic-drain.json',{synthetic:'worker-drain'}),claimsObservation:write('synthetic-claims.json',{synthetic:'claims-observation'}),authorityFence:write('synthetic-fence.json',{synthetic:'authority-fence'})};
  const sourceFence=write('source-fence.json',{version:1,kind:'eigos.source-authority-fence',sourceAuthority:reference,businessSnapshotDigest:plan.fileDigest,membershipSnapshotDigest:membershipDigest,fencedAt:new Date(now-2000).toISOString(),gatewayStopReceiptDigest:fenceReceipts.gatewayStop.sha256,workerDrainReceiptDigest:fenceReceipts.workerDrain.sha256,claimsObservationDigest:fenceReceipts.claimsObservation.sha256,authorityFenceReceiptDigest:fenceReceipts.authorityFence.sha256});
  const verification={version:1,status:'verified-at-snapshot',transactionStartedAt:new Date(now-1000).toISOString(),sourceFileDigest:plan.fileDigest,schemaDigest:plan.schemaDigest,authorityDigest:reference.digest,policyDigest:policy,tables:businessReceipt.tables,sequenceObservation:{checked:plan.tables.length+mapping.identities.length,atomicWithRows:false},writerFenceVerified:false,runtimeActivated:false};
  const identity={version:1,status:'audit-only',checkedAt:now,activeSubjects:0,mismatchedSubjects:0,runtimeActivated:false};
  const operation={version:1,kind:'eigos.postgres-handoff-operation',phase:'prepare-schema',adminIdentity:{user:'postgres',role:'postgres'},binding:write('binding.json',binding),businessSnapshot:{path:business,sha256:plan.fileDigest},membershipSnapshot:{path:membership,sha256:membershipDigest},sourceFence,businessVerification:write('verification.json',verification),identityAudit:write('identity-audit.json',identity),fenceReceipts};
  return {directory,business,membership,binding,operation,plan,role,verification,write,close:()=>rmSync(directory,{recursive:true,force:true})};
  }catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}

function hashFileForFixture(path:string){return createHash('sha256').update(readFileSync(path)).digest('hex');}
