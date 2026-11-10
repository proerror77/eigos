import {consentExpiryIndex} from '../packages/security/consent-lifetime.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { securityFixture } from './fixtures/security.js';
import { installPostgresAuthorityLock } from '../packages/postgres/authority-lock.js';
import { postgresBusinessTransaction,postgresBusinessToken,postgresBusinessReadOnly } from '../packages/postgres/runtime-transaction.js';
import { createStagedPostgresTaskReader, postgresTaskDirectBindingEvidence, postgresTaskFieldClassification, postgresTaskReadClearance, postgresTaskReadGrant, postgresTaskReadOntology, postgresTaskResourceViewAllowed, withPostgresTaskReadGrant, withPostgresTaskReadSnapshot,withPostgresAgentRequestReadRows } from '../packages/postgres/task-read-access.js';
import { POLICY_VERSION, SECURITY_CONTRACT } from '../packages/security/contracts.js';
import { StagedKernelBuilder } from '../packages/ontology/seed-definition.js';
import { sourceMatchesObservation } from '../packages/security/source-policy.js';
import { taskContextMembers } from '../packages/security/task-context.js';
import { postgresTaskContextMembers } from '../packages/postgres/task-context-membership.js';
import { postgresTaskContextBindingCandidate } from '../packages/postgres/task-context-binding.js';
import { digest } from '../packages/core/delegation.js';
import { submissionDigest } from '../packages/security/submission-digest.js';
import { postgresTaskAuthorizeOutput, withPostgresTaskReadAuthorization, withPostgresWorkerEvidenceAuthorization,withPostgresWorkerRequestAuthorization,type PostgresTaskReadAuthorization } from '../packages/postgres/task-output.js';
import { postgresTaskView } from '../packages/postgres/task-view.js';
import { TaskSecurity } from '../packages/security/task-service.js';
import { DomainError } from '../packages/core/domain.js';
import type { TaskServicePort } from '../packages/core/task-service-port.js';
import { PostgresTaskReadService } from '../packages/postgres/task-read-service.js';
import { PostgresDatabase } from '../packages/postgres/database.js';
import { taskProtocolFixture } from './fixtures/task-protocol.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {postgresOntologyRelease} from '../packages/postgres/ontology-release.js';

test('public PostgreSQL queries reuse exact read-window rows and proofs but reopen after writes and revocation',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
    const f=securityFixture(Date.now,{unified:true}),doc=new DocumentAgentProgram();let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined;
    try{
      const installation=f.installation('Synthetic public immutable reads',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),channel='synthetic:public-row-reuse',bindingId='synthetic-public-row-doc';
      const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only');
      const types=[...new Set(['ServiceRequest','DocumentTask','DocumentDraft','Place',...Object.keys(taskContextFields)])];
      f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[doc.ref.id],resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
      f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},role:'Viewer',executeActions:['ComposeDocument'],invokeFunctions:['taskOutcomeStatus'],expiresAt},f.jobs.security.policies.revision());
      f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
      f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
      f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:doc.ref.id,programDigest:doc.configurationDigest,operations:['ComposeDocument'],outputTypes:['DocumentTask','DocumentDraft'],expiresAt},f.jobs.security.policies.revision());
      target=await importPostgresPrimaryFixture(f);const t=target,q=`"${t.schema}"`,principal={...f.principal,access:await t.publisher.authenticate(f.principal,installation.token)};
      const commands=new PostgresTaskCommandService(t.database,t.policy),task=await commands.submit(principal,{requestId:randomUUID(),goal:'Synthetic public read-window proof'}),worker=new PostgresWorkerStore(t.database,t.policy);
      const claim=await worker.claim(['eigos.delegate'],300000);assert(claim);await worker.catalogue(claim,[{program:doc,capability:doc.capability()}],channel);assert(await worker.releaseCheckpoint(claim));
      const root={type:'ServiceRequest',id:task.id},request=await t.database.read(c=>c.query(`SELECT body::jsonb#>'{delegation,request}' AS request FROM ${q}.jobs WHERE id=$1`,[task.id]).then(rows=>rows.rows[0].request));
      type Counts={direct:Map<string,number>;members:number;submissions:number};const windows:Counts[]=[];
      const measured={read:<T>(action:(client:pg.Client)=>Promise<T>)=>t.database.read(async client=>{
        assert.equal(postgresBusinessReadOnly(client,postgresBusinessToken(client)),true);
        const counts:Counts={direct:new Map(),members:0,submissions:0},query=client.query;windows.push(counts);
        client.query=new Proxy(query,{apply(method,self,args){
          const sql=typeof args[0]==='string'?args[0]:args[0]?.text,values=typeof args[0]==='string'?args[1]:args[0]?.values;
          if(typeof sql==='string'){
            if(sql.includes('SELECT b.owner,b.task_id,b.request_revision,b.object_revision,')){const key=JSON.stringify(values);counts.direct.set(key,(counts.direct.get(key)??0)+1);}
            if(sql.includes('WITH candidates AS MATERIALIZED'))counts.members++;
            if(sql.startsWith("SELECT CASE WHEN octet_length((body.value#>'{delegation,request}')::text)<=8388608"))counts.submissions++;
          }
          return Reflect.apply(method,self,args);
        }});
        try{return await action(client);}finally{client.query=query;}
      })};
      const service=new PostgresTaskReadService(measured,t.policy),metadata={version:2,taskId:task.id,query:{type:'RegisteredCapability',select:['id','name']}};
      const first=await service.queryOntology(principal,metadata),second=await service.queryOntology(principal,metadata);assert.deepEqual(second,first);
      assert((first as {items:unknown[]}).items.length>0);
      await service.evaluateOntology(principal,{version:2,taskId:task.id,call:{function:'taskOutcomeStatus',object:root}});
      for(const counts of windows){assert(counts.direct.size>0);assert([...counts.direct.values()].every(count=>count===1));assert(counts.members<=1);assert(counts.submissions<=1);}
      assert.equal(windows[0]!.members,1);assert.equal(windows[0]!.submissions,1);assert.equal(windows[1]!.members,1);assert.equal(windows[1]!.submissions,1,'A new public request repeats its own proof');
      const members=await t.database.read(client=>postgresTaskContextMembers(client,principal,task.id,t.policy));
      let escaped:PostgresTaskReadAuthorization|undefined,assertRows:(()=>void)|undefined,oldToken:object|undefined;
      await measured.read(client=>withPostgresTaskReadAuthorization(client,principal,task.id,t.policy,async auth=>{
        escaped=auth;oldToken=postgresBusinessToken(client);
        for(const ref of members)await auth.readObject(ref);
        const read=await auth.readObject(root,['originalGoal']),envelope={...read.envelope,submission:{taskId:task.id,requestRevision:request.revision,contentDigest:submissionDigest(request)}};
        await auth.authorizeEvidence(envelope);await auth.authorizeEvidence(structuredClone(envelope));
        const evidence=await postgresTaskDirectBindingEvidence(client,principal,task.id,t.policy,root);assert(evidence);evidence.fields.length=0;
        assert((await postgresTaskDirectBindingEvidence(client,principal,task.id,t.policy,root))!.fields.length>0);
        await assert.rejects(postgresTaskDirectBindingEvidence(client,{...principal,subject:'wrong-owner'},task.id,t.policy,root),/AUTHORIZATION_REQUIRED/);
      }));
      assert.equal(windows[3]!.members,1);assert.equal(windows[3]!.submissions,1);assert([...windows[3]!.direct.values()].every(count=>count===1));
      await assert.rejects(escaped!.readTaskRoot(),/AUTHORIZATION_REQUIRED/);
      await t.database.read(async client=>{
        assert.throws(()=>postgresBusinessReadOnly(client,oldToken!),/exact active/);
        await withPostgresTaskReadSnapshot(client,principal,task.id,t.policy,()=>withPostgresAgentRequestReadRows(client,principal,task.id,t.policy,async guard=>{assertRows=guard;guard();}));
        assert.throws(()=>assertRows!(),/AUTHORIZATION_REQUIRED/);
      });
      // An Agent actor and task snapshot do not make a writable transaction an
      // immutable window. Its lower-level lookups must observe its own writes.
      await t.database.run(client=>withPostgresTaskReadSnapshot(client,principal,task.id,t.policy,async()=>{
        assert.equal(postgresBusinessReadOnly(client,postgresBusinessToken(client)),false);
        await assert.rejects(withPostgresAgentRequestReadRows(client,principal,task.id,t.policy,async()=>{}),/AUTHORIZATION_REQUIRED/);
        const before=await postgresTaskDirectBindingEvidence(client,principal,task.id,t.policy,root);assert(before);
        const binding=(await client.query(`SELECT grant_id,body FROM ${q}.security_bindings WHERE owner=$1 AND task_id=$2 AND type='ServiceRequest' AND object_id=$2`,[f.owner,task.id])).rows[0];
        await client.query(`UPDATE ${q}.security_bindings SET body=jsonb_set(body::jsonb,'{fields}','[]'::jsonb)::text WHERE grant_id=$1 AND type='ServiceRequest' AND object_id=$2`,[binding.grant_id,task.id]);
        assert.deepEqual((await postgresTaskDirectBindingEvidence(client,principal,task.id,t.policy,root))!.fields,[]);
        await client.query(`UPDATE ${q}.security_bindings SET body=$1 WHERE grant_id=$2 AND type='ServiceRequest' AND object_id=$3`,[binding.body,binding.grant_id,task.id]);
      }));
      assert.deepEqual(await service.queryOntology(principal,metadata),first);
      const parent=(await t.client.query(`SELECT id FROM ${q}.security_grants WHERE installation_id=$1 AND kind='agent_access'`,[installation.id])).rows[0].id;
      await t.database.run(client=>client.query(`UPDATE ${q}.security_grants SET state='revoked' WHERE id=$1`,[parent]).then(()=>{}));
      await assert.rejects(service.queryOntology(principal,metadata),/ACCESS_REVOKED|AUTHORIZATION_REQUIRED/);
      await assert.rejects(service.evaluateOntology(principal,{version:2,taskId:task.id,call:{function:'taskOutcomeStatus',object:root}}),/ACCESS_REVOKED|AUTHORIZATION_REQUIRED/);
    }finally{if(target)await target.close();f.close();}
  });

test('Worker request row reuse expires with its immutable scope and never covers source writers',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
    const f=securityFixture(Date.now,{unified:true}),doc=new DocumentAgentProgram();
    let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,renewal:Promise<void>|undefined;
    try{
      const installation=f.installation('Synthetic request-row reuse',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),channel='synthetic:request-row-reuse',bindingId='synthetic-request-row-doc';
      const types=[...new Set(['ServiceRequest','DocumentTask','DocumentDraft','Place',...Object.keys(taskContextFields)])];
      f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[doc.ref.id],resources:types.map(type=>({type,fields:Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only')})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
      f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},role:'Viewer',executeActions:['ComposeDocument'],expiresAt},f.jobs.security.policies.revision());
      f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
      f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
      f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:doc.ref.id,programDigest:doc.configurationDigest,operations:['ComposeDocument'],outputTypes:['DocumentTask','DocumentDraft'],expiresAt},f.jobs.security.policies.revision());
      target=await importPostgresPrimaryFixture(f);const t=target,q=`"${t.schema}"`;
      const principal={...f.principal,access:await t.publisher.authenticate(f.principal,installation.token)},commands=new PostgresTaskCommandService(t.database,t.policy);
      const task=await commands.submit(principal,{requestId:'synthetic-request-row-reuse',goal:'Prepare a synthetic document only.'}),worker=new PostgresWorkerStore(t.database,t.policy);
      const claim=await worker.claim(['eigos.delegate'],15000);assert(claim);assert.equal(claim.job.id,task.id);
      let renewalFailure:unknown;
      heartbeat=setInterval(()=>{if(!renewal)renewal=worker.renew(claim,15000).then(ok=>{if(!ok)renewalFailure??=new Error('Original synthetic claim ended');}).catch(error=>{renewalFailure??=error;}).finally(()=>{renewal=undefined;});},5000);
      await worker.catalogue(claim,[{program:doc,capability:doc.capability()}],channel);
      const root={type:'ServiceRequest',id:task.id},inspect=(reference:Parameters<typeof t.database.inspectClaim>[0])=>t.database.inspectClaim(reference,t.policy);
      const members=await t.database.run(c=>withPostgresWorkerEvidenceAuthorization(c,claim,t.policy,(_auth,_admission,actor)=>postgresTaskContextMembers(c,actor,task.id,t.policy),undefined,channel,inspect));
      assert(members.length>=3);
      await t.database.run(async c=>{
        const originalQuery=c.query,counts={invalid:0,ambiguous:0,candidates:0,links:0},direct=new Map<string,number>();
        c.query=new Proxy(originalQuery,{apply(method,thisArg,args){
          const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
          if(typeof sql==='string'){
            if(sql.includes('eigos_try_jsonb(o.body) IS NULL')&&sql.includes('.ontology_objects o WHERE'))counts.invalid++;
            if(sql.startsWith('WITH relevant AS MATERIALIZED'))counts.ambiguous++;
            if(sql.startsWith('WITH candidates AS MATERIALIZED'))counts.candidates++;
            if(sql.startsWith('WITH task_objects AS MATERIALIZED'))counts.links++;
            if(sql.startsWith('SELECT b.owner,b.task_id,b.request_revision,b.object_revision,')){
              const key=JSON.stringify(typeof args[0]==='string'?args[1]:args[0]?.values);direct.set(key,(direct.get(key)??0)+1);
            }
          }
          return Reflect.apply(method,thisArg,args);
        }});
        try{
          let escaped:PostgresTaskReadAuthorization|undefined;
          await withPostgresWorkerRequestAuthorization(c,claim,t.policy,async(auth,_admission,actor)=>{
            escaped=auth;
            for(const ref of members)await auth.readObject(ref);
            const first=await auth.readObject(root,['originalGoal']),expected=structuredClone(first.object);
            first.object.properties.originalGoal='A caller cannot mutate retained raw rows';
            assert.deepEqual((await auth.readObject(root,['originalGoal'])).object,expected);
            const evidence=await postgresTaskDirectBindingEvidence(c,actor,task.id,t.policy,root);assert(evidence);evidence.fields.length=0;
            assert((await postgresTaskDirectBindingEvidence(c,actor,task.id,t.policy,root))!.fields.length>0);
            await assert.rejects(postgresTaskDirectBindingEvidence(c,{...actor,subject:'wrong-owner'},task.id,t.policy,root),/AUTHORIZATION_REQUIRED/);
            await assert.rejects(postgresTaskDirectBindingEvidence(c,actor,randomUUID(),t.policy,root),/AUTHORIZATION_REQUIRED/);
          },undefined,channel,inspect);
          assert.deepEqual(counts,{invalid:1,ambiguous:1,candidates:1,links:1},'Each request scope performs one complete original membership selection');
          assert(direct.size>=members.length);assert([...direct.values()].every(count=>count===1),'Every direct row is fetched once while logical checks still run');
          await assert.rejects(escaped!.bindingMetadata(root),/AUTHORIZATION_REQUIRED/);
        }finally{c.query=originalQuery;}
        // A new authorization in the same writable transaction must see the
        // intervening binding change. The cache is not a transaction cache.
        const original=(await c.query(`SELECT body FROM ${q}.security_bindings WHERE owner=$1 AND task_id=$2 AND type='ServiceRequest' AND object_id=$2`,[claim.owner,task.id])).rows[0].body;
        await c.query(`UPDATE ${q}.security_bindings SET body=jsonb_set(body::jsonb,'{fields}','[]'::jsonb)::text WHERE owner=$1 AND task_id=$2 AND type='ServiceRequest' AND object_id=$2`,[claim.owner,task.id]);
        await assert.rejects(withPostgresWorkerRequestAuthorization(c,claim,t.policy,auth=>auth.readTaskRoot(),undefined,channel,inspect),/AUTHORIZATION_REQUIRED/);
        await c.query(`UPDATE ${q}.security_bindings SET body=$1 WHERE owner=$2 AND task_id=$3 AND type='ServiceRequest' AND object_id=$3`,[original,claim.owner,task.id]);
        await withPostgresWorkerRequestAuthorization(c,claim,t.policy,auth=>auth.readTaskRoot(),undefined,channel,inspect);
        // The general/source-style API never enables request-row memoization.
        await withPostgresWorkerEvidenceAuthorization(c,claim,t.policy,async(_auth,_admission,actor)=>{
          assert((await postgresTaskDirectBindingEvidence(c,actor,task.id,t.policy,root))!.fields.length>0);
          await c.query(`UPDATE ${q}.security_bindings SET body=jsonb_set(body::jsonb,'{fields}','[]'::jsonb)::text WHERE owner=$1 AND task_id=$2 AND type='ServiceRequest' AND object_id=$2`,[claim.owner,task.id]);
          assert.deepEqual((await postgresTaskDirectBindingEvidence(c,actor,task.id,t.policy,root))!.fields,[]);
          await c.query(`UPDATE ${q}.security_bindings SET body=$1 WHERE owner=$2 AND task_id=$3 AND type='ServiceRequest' AND object_id=$3`,[original,claim.owner,task.id]);
        },undefined,channel,inspect);
      });
      const request=await worker.readRequest(claim,channel),counts={members:0,releases:0,submissions:0},direct=new Map<string,number>();
      const reading=new PostgresWorkerStore({
        run:action=>t.database.run(async c=>{
          const original=c.query;
          c.query=new Proxy(original,{apply(method,thisArg,args){
            const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
            if(typeof sql==='string'){
              if(sql.startsWith('WITH candidates AS MATERIALIZED'))counts.members++;
              if(sql.includes('SELECT body,model_digest,created_at,sequence FROM '))counts.releases++;
              if(sql.startsWith("SELECT CASE WHEN octet_length((body.value#>'{delegation,request}')::text)<=8388608"))counts.submissions++;
              if(sql.startsWith('SELECT b.owner,b.task_id,b.request_revision,b.object_revision,')){
                const key=JSON.stringify(typeof args[0]==='string'?args[1]:args[0]?.values);direct.set(key,(direct.get(key)??0)+1);
              }
            }
            return Reflect.apply(method,thisArg,args);
          }});
          try{return await action(c);}finally{c.query=original;}
        }),
        renewClaim:t.database.renewClaim.bind(t.database),inspectClaim:t.database.inspectClaim.bind(t.database),
        cleanupReleasedClaims:t.database.cleanupReleasedClaims.bind(t.database),
      },t.policy);
      let escaped:PostgresTaskReadAuthorization|undefined;
      await reading.readEvidence(claim,channel,async(auth,_admission,actor,c)=>{
        escaped=auth;
        const ontology=await postgresTaskReadOntology(c,actor,task.id,t.policy);
        await postgresOntologyRelease(c,ontology.ref);await postgresOntologyRelease(c,ontology.ref);
        for(const ref of members)await auth.readObject(ref);
        const read=await auth.readObject(root,['originalGoal']);
        const submitted={...read.envelope,submission:{taskId:task.id,requestRevision:request.revision,contentDigest:submissionDigest(request)}};
        await auth.authorizeEvidence(submitted);await auth.authorizeEvidence(structuredClone(submitted));
        await assert.rejects(auth.authorizeEvidence({...submitted,submission:{...submitted.submission,contentDigest:'0'.repeat(64)}}),/OUTPUT_NOT_ALLOWED/);
        await postgresTaskDirectBindingEvidence(c,actor,task.id,t.policy,root);
        await postgresTaskDirectBindingEvidence(c,actor,task.id,t.policy,root);
      });
      assert.deepEqual(counts,{members:1,releases:1,submissions:1},'A planning tool reads each immutable metadata set and submitted request once');
      assert([...direct.values()].every(count=>count===1),'Planning row reuse does not repeatedly fetch the same direct binding');
      await assert.rejects(escaped!.readTaskRoot(),/AUTHORIZATION_REQUIRED/);
      const rootBinding=(await t.client.query(`SELECT body FROM ${q}.security_bindings WHERE owner=$1 AND task_id=$2 AND type='ServiceRequest' AND object_id=$2`,[claim.owner,task.id])).rows[0].body;
      await t.client.query(`UPDATE ${q}.security_bindings SET body=jsonb_set(body::jsonb,'{fields}','[]'::jsonb)::text WHERE owner=$1 AND task_id=$2 AND type='ServiceRequest' AND object_id=$2`,[claim.owner,task.id]);
      await assert.rejects(reading.readEvidence(claim,channel,auth=>auth.readTaskRoot()),/AUTHORIZATION_REQUIRED/);
      await t.client.query(`UPDATE ${q}.security_bindings SET body=$1 WHERE owner=$2 AND task_id=$3 AND type='ServiceRequest' AND object_id=$3`,[rootBinding,claim.owner,task.id]);
      await reading.readEvidence(claim,channel,auth=>auth.readTaskRoot());
      const read=()=>worker.readRequest(claim,channel);await read();
      await assert.rejects(worker.readRequest({...claim,token:'wrong-original-claim'},channel),/ACCESS_REVOKED/);
      const model=(await t.client.query(`SELECT body FROM ${q}.security_model_channels WHERE id=$1`,[channel])).rows[0].body;
      await t.client.query(`UPDATE ${q}.security_model_channels SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text WHERE id=$2`,[new Date(Date.now()-1).toISOString(),channel]);
      await assert.rejects(read(),/OUTPUT_NOT_ALLOWED/);await t.client.query(`UPDATE ${q}.security_model_channels SET body=$1 WHERE id=$2`,[model,channel]);
      const recipient=(await t.client.query(`SELECT body FROM ${q}.security_recipients WHERE installation_id=$1`,[installation.id])).rows[0].body;
      await t.client.query(`UPDATE ${q}.security_recipients SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text WHERE installation_id=$2`,[new Date(Date.now()-1).toISOString(),installation.id]);
      await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);await t.client.query(`UPDATE ${q}.security_recipients SET body=$1 WHERE installation_id=$2`,[recipient,installation.id]);
      clearInterval(heartbeat);if(renewal)await renewal;assert.equal(renewalFailure,undefined);
      const parent=(await t.client.query(`SELECT id FROM ${q}.security_grants WHERE installation_id=$1 AND kind='agent_access'`,[installation.id])).rows[0].id;
      await t.client.query(`UPDATE ${q}.security_grants SET state='revoked' WHERE id=$1`,[parent]);await assert.rejects(read(),/ACCESS_REVOKED/);
      await t.client.query(`UPDATE ${q}.security_grants SET state='active' WHERE id=$1`,[parent]);
      await t.client.query(`UPDATE ${q}.work_claims SET expires_at=$1 WHERE job_id=$2`,[Date.now()-1,task.id]);await assert.rejects(read(),/ACCESS_REVOKED/);
    }finally{
      clearInterval(heartbeat);if(renewal)await renewal;
      try{if(target)await target.close();}finally{f.close();}
    }
  });

test('PostgreSQL task read admission preserves identity, revocation and grant fences', {skip:process.env.EIGOS_TEST_PG_LOCAL !== '1'}, async () => {
  // Remote setup and large-row validation may outlast the synthetic lease;
  // keep the fixture's copied projection valid throughout those checks.
  const clockOffset=1200000;
  const f=securityFixture(()=>Date.now()+clockOffset), installation=f.installation('Synthetic read',3600000),sourceExpiry=new Date(Date.now()+3600000).toISOString();
  f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:['brief.prepare'],resources:[{type:'ServiceRequest',fields:['requestId','originalGoal']},{type:'Place',fields:['placeId','name','address']},{type:'RequestSpecification',fields:['id','displayTitle','requestRevision']},{type:'RegisteredCapability',fields:['id','name','capabilityRef','contextRequestId']},{type:'RegisteredActionType',fields:['id','displayTitle','actionId']}],sourceBindingIds:['synthetic-source'],channels:['agent_response','registered_model'],expiresAt:sourceExpiry});
  f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId:'synthetic-source',programId:'brief.prepare',programDigest:'b'.repeat(64),operations:['synthetic.read'],outputTypes:['ServiceRequest','Place'],expiresAt:sourceExpiry},f.jobs.security.policies.revision());
  const task=f.task(installation.id), principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
  assert(principal.access.actorKind==='agent');const parentGrantId=principal.access.agentGrant.id;
  f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'objectType',id:'ServiceRequest',version:f.jobs.security.policies.resourceVersion('objectType','ServiceRequest')},role:'Viewer',expiresAt:new Date(Date.now()+3600000).toISOString()},f.jobs.security.policies.revision());
  for(const type of ['Place','RequestSpecification','RegisteredCapability','RegisteredActionType'])f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'objectType',id:type,version:f.jobs.security.policies.resourceVersion('objectType',type)},role:'Viewer',expiresAt:new Date(Date.now()+3600000).toISOString()},f.jobs.security.policies.revision());
  f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'actionType',id:'ReadCommerceContext',version:f.jobs.security.policies.resourceVersion('actionType','ReadCommerceContext')},role:'Viewer',expiresAt:sourceExpiry},f.jobs.security.policies.revision());
  const recipient={classification:'sensitive' as const,markings:['member_private','personal_data'] as const,channels:['agent_response'] as const,expiresAt:new Date(Date.now()+3600000).toISOString()};
  f.jobs.security.policies.setRecipient(installation.id,recipient,f.jobs.security.policies.revision());
  for(const field of ['*','originalGoal','requestId']) f.jobs.security.policies.restrictObject({ownerKey:f.owner,object:{type:'ServiceRequest',id:task.job.id},expectedObjectRevision:1,field,classification:'sensitive',requiredMarkings:['personal_data'],channels:['agent_response']},f.jobs.security.policies.revision());
  const sqlite=new DatabaseSync(f.database), schema=`eigos_business_${randomUUID().replaceAll('-','')}`;
  if(process.env.EIGOS_TEST_REPORT_SCHEMA==='1')console.log(`Synthetic PostgreSQL schema: ${schema}`);
  const stored=sqlite.prepare('SELECT body FROM security_grants WHERE id=?').get(task.grant.id)!;
  const readGrant=JSON.parse(String(stored.body)); readGrant.operations.push('task.result.read'); readGrant.channels.push('agent_response');
  readGrant.outputs.push({programId:'brief.prepare',programDigest:'b'.repeat(64),sourceBindingId:'synthetic-source',type:'Place',fields:['placeId','name']});
  sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(readGrant),task.grant.id);
  // This fixture promotes its synthetic processing-only grant to a read grant;
  // its root seal must admit the response channel as a real read grant does.
  sqlite.prepare("UPDATE security_bindings SET body=json_set(body,'$.envelope.channels',json(?)) WHERE grant_id=? AND type='ServiceRequest' AND object_id=?")
    .run(JSON.stringify(['agent_response','registered_model']),task.grant.id,task.job.id);
  // Preserve a realistic order: two prior task grants precede the current one.
  sqlite.prepare('UPDATE security_grants SET rowid=100 WHERE id=?').run(task.grant.id);
  const priorIds=[randomUUID(),randomUUID()];
  for(const [index,id] of priorIds.entries())sqlite.prepare(`INSERT INTO security_grants(rowid,id,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,state,expires_at,body)
    SELECT ?,?,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,'revoked',expires_at,json_set(body,'$.id',?,'$.status','revoked') FROM security_grants WHERE id=?`)
    .run(10+index,id,id,task.grant.id);
  const policy=f.jobs.security.policies.definitionDigest, authority={id:randomUUID(),revision:1,digest:'a'.repeat(64)};
  const client=new pg.Client(process.env.EIGOS_TEST_PG_CA_FILE?{ssl:{ca:readFileSync(process.env.EIGOS_TEST_PG_CA_FILE,'utf8'),rejectUnauthorized:true}}:{}); await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT)`);
    await client.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`,[authority.id,authority.revision,authority.digest]); await installPostgresAuthorityLock(client,schema);
    await client.query(`CREATE FUNCTION "${schema}".eigos_try_jsonb(value TEXT) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE STRICT AS $$ BEGIN RETURN value::jsonb; EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character THEN RETURN NULL; END $$`);
    for(const table of ['jobs','security_settings','security_manager','security_subjects','security_fences','security_grants','security_policy','security_policy_definitions','security_roles','security_recipients','security_sources','security_object_origins','security_labels','security_bindings','security_outputs','security_private_views','security_artifacts','action_intents','action_observations','ontology_objects','ontology_links','ontology_object_versions','ontology_tombstones','ontology_definition_releases','ontology_definition_fingerprints','ontology_definition_release_aliases','ontology_definition_bootstrap','ontology_namespaces','ontology_task_read_projections']) {
      const cols=sqlite.prepare(`PRAGMA table_info("${table}")`).all();
      const rowIdentity=table==='security_grants' || table==='action_observations';
      await client.query(`CREATE TABLE "${schema}"."${table}" (${cols.map(c=>`"${c.name}" ${String(c.type).toUpperCase()==='INTEGER'?'BIGINT':String(c.type).toUpperCase()==='BLOB'?'BYTEA':'TEXT'}`).join(',')}${rowIdentity?',"__eigos_rowid" BIGINT NOT NULL':''})`);
      const select=rowIdentity?`SELECT rowid AS __eigos_rowid,* FROM "${table}" ORDER BY rowid`:`SELECT * FROM "${table}"`;
      for(const row of sqlite.prepare(select).iterate()) {
        const values=cols.map(c=>row[String(c.name)]);if(rowIdentity)values.push(row.__eigos_rowid);
        await client.query(`INSERT INTO "${schema}"."${table}" VALUES (${values.map((_,i)=>`$${i+1}`).join(',')})`,values);
      }
    }
    const staged=new StagedKernelBuilder();
    assert.throws(()=>createStagedPostgresTaskReader(undefined as unknown as StagedKernelBuilder),/Invalid staged kernel builder/);
    assert.throws(()=>createStagedPostgresTaskReader(staged),/not ready/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadOntology(c,principal,task.job.id,policy,staged)),/not ready/);
    for(let stage=0;stage<StagedKernelBuilder.stages;stage++)staged.step(stage);
    const stagedReader=createStagedPostgresTaskReader(staged);
    await postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadSnapshot(c,principal,task.job.id,policy,async admission=>{
      assert(Object.isFrozen(admission));assert(Object.isFrozen(admission.parent.resources[0]!.fields));
      assert.throws(()=>admission.parent.resources[0]!.fields.push('not_granted'),TypeError);
      await assert.rejects(withPostgresTaskReadGrant(c,{...principal,subject:'another-owner'},task.job.id,policy,async()=>true),/AUTHORIZATION_REQUIRED/);
      await assert.rejects(withPostgresTaskReadSnapshot(c,principal,task.job.id,policy,async()=>true),/Nested PostgreSQL read snapshots/);
    }));
    const contextObjects=[
      {type:'RequestSpecification',id:'synthetic-spec',properties:{requestRevision:1}},
      {type:'RequestInstruction',id:'synthetic-instruction',properties:{introducedRevision:1}},
      {type:'RequestInstruction',id:'synthetic-future',properties:{introducedRevision:2}},
      {type:'ExecutionContext',id:'synthetic-context',properties:{requestRevision:1}},
      {type:'RequestInstruction',id:'synthetic-unlinked',properties:{introducedRevision:1}},
      {type:'RegisteredCapability',id:`capability:${'a'.repeat(64)}`,properties:{definitionDigest:'a'.repeat(64),capabilityRef:{id:'brief.prepare'}}},
      {type:'RegisteredActionType',id:'synthetic-action',properties:{actionId:'ReadCommerceContext'}},
    ];
    for(const object of contextObjects){
      const body=JSON.stringify({source:{kind:'task',id:object.type==='RegisteredCapability'?'another-task':task.job.id},properties:object.properties});
      sqlite.prepare('INSERT INTO ontology_objects(owner,type,id,revision,definition_digest,body) VALUES(?,?,?,?,?,?)').run(f.owner,object.type,object.id,1,'a'.repeat(64),body);
      await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,$5)`,[f.owner,object.type,object.id,'a'.repeat(64),body]);
    }
    const contextLinks=[['RequestSpecificationInstruction','RequestSpecification','synthetic-spec','RequestInstruction','synthetic-instruction'],['RequestSpecificationInstruction','RequestSpecification','synthetic-spec','RequestInstruction','synthetic-future'],['ExecutionStepAction','RequestSpecification','synthetic-spec','RegisteredActionType','synthetic-action'],['CapabilityRequest','RegisteredCapability',`capability:${'a'.repeat(64)}`,'ServiceRequest',task.job.id]];
    for(const [type,fromType,fromId,toType,toId] of contextLinks){
      sqlite.prepare('INSERT INTO ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) VALUES(?,?,?,?,?,?,?)').run(f.owner,type!,fromType!,fromId!,toType!,toId!,'a'.repeat(64));
      await client.query(`INSERT INTO "${schema}".ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) VALUES($1,$2,$3,$4,$5,$6,$7)`,[f.owner,type,fromType,fromId,toType,toId,'a'.repeat(64)]);
    }
    const members=()=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskContextMembers(c,principal,task.job.id,policy,staged));
    const sortRefs=(refs:{type:string;id:string}[])=>refs.map(ref=>JSON.stringify([ref.type,ref.id])).sort();
    assert.deepEqual(sortRefs(await members()),sortRefs([...taskContextMembers(sqlite,f.owner,task.job.id,1).values()]));
    const memberKeys=sortRefs(await members());assert(memberKeys.includes(JSON.stringify(['RequestInstruction','synthetic-instruction'])));assert(memberKeys.includes(JSON.stringify(['RegisteredCapability',`capability:${'a'.repeat(64)}`])));assert(!memberKeys.includes(JSON.stringify(['RequestInstruction','synthetic-future'])));assert(!memberKeys.includes(JSON.stringify(['RequestInstruction','synthetic-unlinked'])));
    const duplicateSource=`{"source":{"kind":"task","id":"another-task","id":${JSON.stringify(task.job.id)}},"properties":{"requestRevision":1}}`;
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,'RequestSpecification','ambiguous-source',1,$2,$3)`,[f.owner,'a'.repeat(64),duplicateSource]);
    await assert.rejects(members(),/POLICY_CHANGED/);
    await client.query(`DELETE FROM "${schema}".ontology_objects WHERE owner=$1 AND type='RequestSpecification' AND id='ambiguous-source'`,[f.owner]);
    await client.query(`UPDATE "${schema}".ontology_objects SET body='invalid' WHERE owner=$1 AND type='RequestInstruction' AND id='synthetic-instruction'`,[f.owner]);
    await assert.rejects(members(),/POLICY_CHANGED/);
    const instruction=JSON.stringify({source:{kind:'task',id:task.job.id},properties:{introducedRevision:1}});
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type='RequestInstruction' AND id='synthetic-instruction'`,[instruction,f.owner]);
    const oversized=JSON.stringify({source:{kind:'task',id:task.job.id},properties:{introducedRevision:1},padding:'x'.repeat(1048577)});
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type='RequestInstruction' AND id='synthetic-instruction'`,[oversized,f.owner]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type='RequestInstruction' AND id='synthetic-instruction'`,[instruction,f.owner]);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,'RequestInstruction',$2,1,$3,$4)`,[f.owner,'x'.repeat(801),'a'.repeat(64),instruction]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`DELETE FROM "${schema}".ontology_objects WHERE owner=$1 AND type='RequestInstruction' AND id=$2`,[f.owner,'x'.repeat(801)]);
    await client.query(`INSERT INTO "${schema}".ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) VALUES($1,'RequestSpecificationInstruction','RequestSpecification','synthetic-spec','RequestInstruction',$2,$3)`,[f.owner,'x'.repeat(801),'a'.repeat(64)]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`DELETE FROM "${schema}".ontology_links WHERE owner=$1 AND type='RequestSpecificationInstruction' AND to_id=$2`,[f.owner,'x'.repeat(801)]);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) SELECT $1,'RequestInstruction','overflow-'||n,1,$2,$3 FROM generate_series(1,2001) n`,[f.owner,'a'.repeat(64),instruction]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`DELETE FROM "${schema}".ontology_objects WHERE owner=$1 AND type='RequestInstruction' AND id LIKE 'overflow-%'`,[f.owner]);
    await client.query(`INSERT INTO "${schema}".ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) SELECT $1,'RequestSpecificationInstruction','RequestSpecification','synthetic-spec','RequestInstruction','overflow-'||n,$2 FROM generate_series(1,4001) n`,[f.owner,'a'.repeat(64)]);
    await assert.rejects(members(),/INSUFFICIENT_ACCESS/);
    await client.query(`DELETE FROM "${schema}".ontology_links WHERE owner=$1 AND type='RequestSpecificationInstruction' AND to_id LIKE 'overflow-%'`,[f.owner]);
    const rootBinding=JSON.parse(String(sqlite.prepare("SELECT body FROM security_bindings WHERE grant_id=? AND type='ServiceRequest' AND object_id=?").get(task.grant.id,task.job.id)!.body));
    const metadataEnvelope={...rootBinding.envelope,channels:['agent_response','registered_model'],lineage:[],lineageComplete:true};
    const specRef={type:'RequestSpecification',id:'synthetic-spec'},capRef={type:'RegisteredCapability',id:`capability:${'a'.repeat(64)}`},actionRef={type:'RegisteredActionType',id:'synthetic-action'};
    const specBody=String(sqlite.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(f.owner,specRef.type,specRef.id)!.body);
    const specBinding={object:specRef,revision:1,fields:['id','displayTitle','requestRevision'],sourceBindingId:'task_context',envelope:rootBinding.envelope,inputEnvelope:metadataEnvelope,
      projectionOrigin:{version:1,contentDigest:digest(['a'.repeat(64),JSON.parse(specBody)]),linksDigest:'b'.repeat(64),inputDigest:digest(metadataEnvelope)}};
    const capBinding={object:capRef,revision:1,fields:['id','name','capabilityRef','contextRequestId'],sourceBindingId:'task_context',envelope:rootBinding.envelope};
    const actionBinding={object:actionRef,revision:1,fields:['id','displayTitle','actionId'],sourceBindingId:'task_context',envelope:rootBinding.envelope};
    for(const value of [specBinding,capBinding,actionBinding]){
      sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(task.grant.id,f.owner,task.job.id,1,value.object.type,value.object.id,1,JSON.stringify(value));
      await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[task.grant.id,f.owner,task.job.id,value.object.type,value.object.id,JSON.stringify(value)]);
    }
    const contextCandidate=(item:{type:string;id:string})=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskContextBindingCandidate(c,principal,task.job.id,policy,item,staged));
    const sqliteContext=(item:{type:string;id:string})=>f.jobs.security.withAgent(principal,task.job.id,'task.result.read',scope=>f.jobs.security.policies.binding(scope,item));
    for(const item of [specRef,capRef,actionRef]){
      const expected=sqliteContext(item);assert(expected?.fields.length,item.type);
      const actual=await contextCandidate(item);assert(actual);assert.deepEqual(actual.fields,expected.fields);assert.deepEqual(actual.object,item);
      if(item.type==='RegisteredCapability')assert(!actual.fields.includes('contextRequestId'));
    }
    const alteredSpec={...specBinding,projectionOrigin:{...specBinding.projectionOrigin,contentDigest:'c'.repeat(64)}};
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(alteredSpec),task.grant.id,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(alteredSpec),task.grant.id,specRef.type,specRef.id]);
    assert.throws(()=>sqliteContext(specRef),/POLICY_CHANGED/);await assert.rejects(contextCandidate(specRef),/POLICY_CHANGED/);
    const alteredInput={...specBinding,projectionOrigin:{...specBinding.projectionOrigin,inputDigest:'d'.repeat(64)}};
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(alteredInput),task.grant.id,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(alteredInput),task.grant.id,specRef.type,specRef.id]);
    assert.throws(()=>sqliteContext(specRef),/POLICY_CHANGED/);await assert.rejects(contextCandidate(specRef),/POLICY_CHANGED/);
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(specBinding),task.grant.id,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(specBinding),task.grant.id,specRef.type,specRef.id]);
    const foreignSpec=JSON.stringify({...JSON.parse(specBody),source:{kind:'task',id:'other-task'}});
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(foreignSpec,f.owner,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[foreignSpec,f.owner,specRef.type,specRef.id]);
    assert.equal(sqliteContext(specRef),undefined);assert.equal(await contextCandidate(specRef),undefined);
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(specBody,f.owner,specRef.type,specRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[specBody,f.owner,specRef.type,specRef.id]);
    const capBody=String(sqlite.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(f.owner,capRef.type,capRef.id)!.body);
    const foreignCap=JSON.parse(capBody);foreignCap.properties.capabilityRef={id:'unapproved-capability'};
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(JSON.stringify(foreignCap),f.owner,capRef.type,capRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[JSON.stringify(foreignCap),f.owner,capRef.type,capRef.id]);
    assert.equal(sqliteContext(capRef),undefined);assert.equal(await contextCandidate(capRef),undefined);
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(capBody,f.owner,capRef.type,capRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[capBody,f.owner,capRef.type,capRef.id]);
    const actionBody=String(sqlite.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(f.owner,actionRef.type,actionRef.id)!.body);
    const foreignAction=JSON.parse(actionBody);foreignAction.properties.actionId='UnapprovedAction';
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(JSON.stringify(foreignAction),f.owner,actionRef.type,actionRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[JSON.stringify(foreignAction),f.owner,actionRef.type,actionRef.id]);
    assert.equal(sqliteContext(actionRef),undefined);assert.equal(await contextCandidate(actionRef),undefined);
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(actionBody,f.owner,actionRef.type,actionRef.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[actionBody,f.owner,actionRef.type,actionRef.id]);
    const place={type:'Place',id:'retained-place'},placeDefinition=f.jobs.ontology.model.fingerprint('Place');
    const placeBody=JSON.stringify({createdAt:new Date().toISOString(),source:{kind:'provider',id:'synthetic-source',observedAt:new Date().toISOString(),readContext:{query:{type:'ServiceRequest',id:task.job.id},collection:'places',observation:{type:'Place',id:'private-observation'}}},properties:{placeId:'retained-place',name:'Synthetic',address:'private'}});
    sqlite.prepare('INSERT INTO ontology_objects(owner,type,id,revision,definition_digest,body) VALUES(?,?,?,?,?,?)').run(f.owner,place.type,place.id,1,placeDefinition,placeBody);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,$5)`,[f.owner,place.type,place.id,placeDefinition,placeBody]);
    const retainedBase={object:place,revision:1,fields:['placeId','name','address'],sourceBindingId:'synthetic-source',envelope:rootBinding.envelope};
    const earlier={...retainedBase,fields:['placeId']};
    for(const [index,value] of [earlier,retainedBase].entries()){
      sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(priorIds[index]!,f.owner,task.job.id,1,place.type,place.id,1,JSON.stringify(value));
      await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[priorIds[index],f.owner,task.job.id,place.type,place.id,JSON.stringify(value)]);
    }
    const submission={taskId:task.job.id,requestRevision:1,contentDigest:submissionDigest(task.job.delegation!.request)};
    const retainedOrigin={programId:'brief.prepare',programDigest:'b'.repeat(64),sourceBindingId:'synthetic-source',inputEnvelope:{...metadataEnvelope,submission}};
    sqlite.prepare('INSERT INTO security_object_origins(owner,type,object_id,object_revision,body) VALUES(?,?,?,?,?)').run(f.owner,place.type,place.id,1,JSON.stringify(retainedOrigin));
    await client.query(`INSERT INTO "${schema}".security_object_origins(owner,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4)`,[f.owner,place.type,place.id,JSON.stringify(retainedOrigin)]);
    const retained=(item:{type:string;id:string},historical=false)=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.retainedBindingEvidence(c,principal,task.job.id,policy,item,historical));
    const privatePolicy=f.jobs.security.policies as unknown as {retainedBinding:(scope:unknown,item:{type:string;id:string},historical:boolean)=>unknown};
    const sqliteRetained=(item:{type:string;id:string},historical=false)=>f.jobs.security.withAgent(principal,task.job.id,'task.result.read',scope=>privatePolicy.retainedBinding(scope,item,historical));
    const retainedPlace=await retained(place);assert.deepEqual(retainedPlace,sqliteRetained(place));assert.deepEqual(retainedPlace?.fields,['placeId','name']);
    const deliverable={message:'Synthetic sealed result'},outputId='synthetic-output';
    const outputEnvelope={...metadataEnvelope,submission,lineage:[{object:place,revision:1,fields:['placeId','name'],contentDigest:digest({placeId:place.id,name:'Synthetic'})}]};
    sqlite.prepare('INSERT INTO security_outputs(owner,task_id,output_id,content_digest,body) VALUES(?,?,?,?,?)').run(f.owner,task.job.id,outputId,digest(deliverable),JSON.stringify(outputEnvelope));
    await client.query(`INSERT INTO "${schema}".security_outputs(owner,task_id,output_id,content_digest,body) VALUES($1,$2,$3,$4,$5)`,[f.owner,task.job.id,outputId,digest(deliverable),JSON.stringify(outputEnvelope)]);
    const sqliteOutput=()=>f.jobs.security.withAgent(principal,task.job.id,'task.result.read',scope=>{
      const envelope=f.jobs.security.policies.output(f.owner,task.job.id,outputId,deliverable);
      if(!envelope)return undefined;
      try {f.jobs.security.policies.requireRecipient(scope,envelope,'agent_response');return envelope;}catch{return undefined;}
    });
    const authorizedOutput=(value:unknown=deliverable)=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskAuthorizeOutput(c,principal,task.job.id,policy,outputId,value,staged));
    assert(sqliteOutput());assert.deepEqual(await authorizedOutput(),sqliteOutput());
    assert.equal(await authorizedOutput({message:'Altered result'}),undefined);
    const historicalContent={message:'Synthetic historical metadata dependency'},historicalEnvelope={...metadataEnvelope,submission,lineage:[{object:capRef,revision:1,fields:['id','name'],contentDigest:digest({})}]};
    sqlite.prepare('INSERT INTO security_outputs(owner,task_id,output_id,content_digest,body) VALUES(?,?,?,?,?)').run(f.owner,task.job.id,'historical-output',digest(historicalContent),JSON.stringify(historicalEnvelope));
    await client.query(`INSERT INTO "${schema}".security_outputs(owner,task_id,output_id,content_digest,body) VALUES($1,$2,'historical-output',$3,$4)`,[f.owner,task.job.id,digest(historicalContent),JSON.stringify(historicalEnvelope)]);
    sqlite.prepare("DELETE FROM ontology_links WHERE owner=? AND type='CapabilityRequest' AND from_id=? AND to_id=?").run(f.owner,capRef.id,task.job.id);
    await client.query(`DELETE FROM "${schema}".ontology_links WHERE owner=$1 AND type='CapabilityRequest' AND from_id=$2 AND to_id=$3`,[f.owner,capRef.id,task.job.id]);
    assert(sqliteContext(capRef)===undefined);
    const historicalSqlite=f.jobs.security.withAgent(principal,task.job.id,'task.result.read',scope=>{
      const envelope=f.jobs.security.policies.output(f.owner,task.job.id,'historical-output',historicalContent);
      if(envelope)f.jobs.security.policies.requireRecipient(scope,envelope,'agent_response');return envelope;
    });
    assert(historicalSqlite);
    assert.deepEqual(await postgresBusinessTransaction(client,schema,authority,c=>postgresTaskAuthorizeOutput(c,principal,task.job.id,policy,'historical-output',historicalContent,staged)),historicalSqlite);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadAuthorization(c,principal,task.job.id,policy,auth=>auth.readObject(capRef),staged)),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare('INSERT INTO ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) VALUES(?,?,?,?,?,?,?)').run(f.owner,'CapabilityRequest',capRef.type,capRef.id,'ServiceRequest',task.job.id,'a'.repeat(64));
    await client.query(`INSERT INTO "${schema}".ontology_links(owner,type,from_type,from_id,to_type,to_id,definition_digest) VALUES($1,'CapabilityRequest',$2,$3,'ServiceRequest',$4,$5)`,[f.owner,capRef.type,capRef.id,task.job.id,'a'.repeat(64)]);
    const readObject=(ref:{type:string;id:string},fields?:string[])=>postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadAuthorization(c,principal,task.job.id,policy,auth=>auth.readObject(ref,fields),staged));
    const visiblePlace=await readObject(place);assert.deepEqual(visiblePlace.object.properties,{placeId:place.id,name:'Synthetic'});assert.equal(visiblePlace.object.source.readContext,undefined);
    await assert.rejects(readObject(place,['address']),/INSUFFICIENT_ACCESS/);
    const visibleRequest=await readObject({type:'ServiceRequest',id:task.job.id},['originalGoal']);
    assert.equal(visibleRequest.object.properties.originalGoal,task.job.goal);
    await postgresBusinessTransaction(client,schema,authority,async c=>{
      const query=c.query,counts={roles:0,recipients:0,labels:0};
      c.query=new Proxy(query,{apply(target,thisArg,args){
        const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
        if(typeof sql==='string'&&sql.includes('SELECT'))for(const [name,table] of Object.entries({roles:'security_roles',recipients:'security_recipients',labels:'security_labels'})){
          if(sql.includes('.'+table))counts[name as keyof typeof counts]++;
        }
        return Reflect.apply(target,thisArg,args);
      }});
      try{
        await withPostgresTaskReadAuthorization(c,principal,task.job.id,policy,async auth=>{
          const first=await auth.readObject(place),before=structuredClone(first.object);
          first.object.properties.name='A caller must not alter the cached source row';
          assert.deepEqual((await auth.readObject(place)).object,before);
          const clearance=await postgresTaskReadClearance(c,principal,task.job.id,policy);assert(clearance);
          const expected=structuredClone(clearance);clearance.channels.length=0;
          assert.deepEqual(await postgresTaskReadClearance(c,principal,task.job.id,policy),expected);
        },staged);
        assert.deepEqual(counts,{roles:1,recipients:1,labels:1},'one immutable read callback does not repeat WAN metadata reads');
      }finally{c.query=query;}
    });
    let escaped:PostgresTaskReadAuthorization|undefined;
    await postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadAuthorization(c,principal,task.job.id,policy,async auth=>{escaped=auth;},staged));
    await assert.rejects(escaped!.output(outputId,deliverable),/AUTHORIZATION_REQUIRED/);
    const sqliteTask=new TaskSecurity(f.jobs),pgTask=()=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskView(c,principal,task.job.id,policy,staged));
    const currentView=await pgTask();assert.equal(currentView.authorityId,authority.id);
    const {authorityId:_authority,...withoutAuthority}=currentView;
    assert.deepEqual(withoutAuthority,sqliteTask.get(principal,task.job.id));
    const pool=new pg.Pool({...process.env.EIGOS_TEST_PG_CA_FILE?{ssl:{ca:readFileSync(process.env.EIGOS_TEST_PG_CA_FILE,'utf8'),rejectUnauthorized:true}}:{},max:2});
    const database=new PostgresDatabase(pool,schema,authority),reads=new PostgresTaskReadService(database,policy,staged,{waitTimeoutMs:1});
    // This isolated server exposes the persisted read side only; task commands
    // are deliberately denied until their PostgreSQL runtime is connected.
    const readPort=new Proxy({} as TaskServicePort,{get(_target,property){
      if(property==='secured')return true;
      if(property==='services')return ()=>[{id:'eigos.delegate',name:'Synthetic persisted reads',description:'Synthetic protocol fixture',requiredInputs:['goal'],tags:[],examples:[],inputModes:['application/json'],outputModes:['application/json']}];
      const method=Reflect.get(reads,property);
      if(typeof method==='function')return method.bind(reads);
      return async()=>{throw new DomainError('FORBIDDEN','This isolated fixture tests persisted reads only');};
    }});
    const protocol=await taskProtocolFixture(readPort,principal);
    try {
      const mcpRead=await protocol.job('get_task',{taskId:task.job.id});assert.equal(mcpRead.id,task.job.id);assert.equal(mcpRead.goal,task.job.goal);
      const a2aRead=await protocol.rpc('GetTask',{id:task.job.id});assert(!a2aRead.error,JSON.stringify(a2aRead));assert.equal(a2aRead.result.id,task.job.id);assert.equal(a2aRead.result.metadata.view,'eigos.task.v2');
      const list=await protocol.rpc('ListTasks',{pageSize:10});assert(!list.error,JSON.stringify(list));assert.equal(list.result.totalSize,1);assert.equal(list.result.tasks[0].id,task.job.id);
      const mcpList=await protocol.call('list_tasks',{limit:10});assert(!mcpList.isError,JSON.stringify(mcpList));assert.equal((mcpList.structuredContent as {result:{total:number}}).result.total,1);
      await assert.rejects(reads.get({...principal,subject:'different-owner'},task.job.id),/AUTHORIZATION_REQUIRED/);
      await assert.rejects(reads.wait(principal,task.job.id),/Blocking task wait interrupted/);
      assert.equal((await reads.getAfterWait(principal,task.job.id,0)).state,task.job.state);
    } finally {await protocol.close();await reads.close();await database.close();}
    const deniedRoot={...rootBinding,envelope:{...rootBinding.envelope,channels:['registered_model']}};
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type='ServiceRequest' AND object_id=$3`,[JSON.stringify(deniedRoot),task.grant.id,task.job.id]);
    await assert.rejects(pgTask(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type='ServiceRequest' AND object_id=$3`,[JSON.stringify(rootBinding),task.grant.id,task.job.id]);
    const taskBody=String(sqlite.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(f.owner,task.job.id)!.body);
    const completed=JSON.parse(taskBody),artifact={id:randomUUID(),name:'result.json',data:{goal:task.job.goal,deliverable:'Synthetic sealed result',execution:'completed',result:{securityEvidenceRefs:[place],privateMarker:'PRIVATE_UNPROJECTED_RESULT'}}};
    completed.state='completed';completed.artifact=artifact;completed.error='PRIVATE_RUNTIME_DIAGNOSTIC';completed.delegation.acceptance={accepted:true};
    sqlite.prepare('UPDATE jobs SET state=?,body=? WHERE owner=? AND id=?').run('completed',JSON.stringify(completed),f.owner,task.job.id);
    await client.query(`UPDATE "${schema}".jobs SET state='completed',body=$1 WHERE owner=$2 AND id=$3`,[JSON.stringify(completed),f.owner,task.job.id]);
    sqlite.prepare('INSERT INTO security_outputs(owner,task_id,output_id,content_digest,body) VALUES(?,?,?,?,?)').run(f.owner,task.job.id,'artifact',digest(artifact),JSON.stringify(outputEnvelope));
    await client.query(`INSERT INTO "${schema}".security_outputs(owner,task_id,output_id,content_digest,body) VALUES($1,$2,'artifact',$3,$4)`,[f.owner,task.job.id,digest(artifact),JSON.stringify(outputEnvelope)]);
    const {authorityId:_completedAuthority,...completedView}=await pgTask();
    assert.deepEqual(completedView,sqliteTask.get(principal,task.job.id));assert.equal(completedView.accepted,true);assert(completedView.artifact);
    assert(!JSON.stringify(completedView).includes('PRIVATE_'));
    await client.query(`UPDATE "${schema}".security_outputs SET content_digest=$1 WHERE owner=$2 AND task_id=$3 AND output_id='artifact'`,['0'.repeat(64),f.owner,task.job.id]);
    const deniedView=await pgTask();assert.equal(deniedView.id,task.job.id);assert.equal(deniedView.outputStatus,'restricted');assert.equal(deniedView.artifact,undefined);assert.equal(deniedView.accepted,undefined);
    sqlite.prepare('UPDATE jobs SET state=?,body=? WHERE owner=? AND id=?').run(task.job.state,taskBody,f.owner,task.job.id);
    await client.query(`UPDATE "${schema}".jobs SET state=$1,body=$2 WHERE owner=$3 AND id=$4`,[task.job.state,taskBody,f.owner,task.job.id]);
    const sourceRows=await client.query(`SELECT body FROM "${schema}".security_sources WHERE owner=$1 AND installation_id=$2`,[f.owner,installation.id]);
    assert.equal(sourceRows.rowCount,1);
    const shortSource={...JSON.parse(String(sourceRows.rows[0].body)),expiresAt:new Date(Date.now()+1000).toISOString()};
    await client.query(`UPDATE "${schema}".security_sources SET body=$1 WHERE owner=$2 AND installation_id=$3`,[JSON.stringify(shortSource),f.owner,installation.id]);
    const originalQuery=client.query,originalNow=Date.now,at=Date.now();let sourceSeen=false,finalChecks=0;
    client.query=(async (...args:unknown[])=>{
      const result=await Reflect.apply(originalQuery,client,args),sql=String(args[0]);
      if(sql.includes('.security_sources'))sourceSeen=true;
      // Recipient metadata may already be memoized inside this read. Advance
      // time at the fresh outer admission after source evidence was checked.
      if(sourceSeen && sql.includes('.security_grants d JOIN') && ++finalChecks===1)Date.now=()=>at+2000;
      return result;
    }) as typeof client.query;
    Date.now=()=>at;
    try {assert.equal(await authorizedOutput(),undefined);assert.equal(finalChecks,1,'Expiry advances only at the outer final admission check');}
    finally {Date.now=originalNow;client.query=originalQuery;}
    await client.query(`UPDATE "${schema}".security_sources SET body=$1 WHERE owner=$2 AND installation_id=$3`,[sourceRows.rows[0].body,f.owner,installation.id]);
    const changedPlace=JSON.stringify({...JSON.parse(placeBody),properties:{...JSON.parse(placeBody).properties,name:'Changed source fact'}});
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(changedPlace,f.owner,place.type,place.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[changedPlace,f.owner,place.type,place.id]);
    assert.equal(sqliteOutput(),undefined);assert.equal(await authorizedOutput(),undefined);
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(placeBody,f.owner,place.type,place.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[placeBody,f.owner,place.type,place.id]);
    const retainedFields=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.retainedFieldCandidates(c,principal,task.job.id,policy,place));
    assert.deepEqual((await retainedFields())?.fields,['placeId','name']);
    const recipientRow=sqlite.prepare('SELECT body FROM security_recipients WHERE installation_id=?').get(installation.id)!;
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[JSON.stringify({...recipient,channels:['registered_model']}),installation.id]);
    assert.equal(await retainedFields(),undefined);
    assert.equal(await authorizedOutput(),undefined);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[recipientRow.body,installation.id]);
    const retainedSource=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.sourceObservationAllowed(c,principal,task.job.id,policy,place));
    assert.equal(sourceMatchesObservation(f.jobs.security.policies.sources(f.owner,installation.id),retainedOrigin,place.type),true);
    assert.equal(await retainedSource(),true);
    sqlite.prepare("UPDATE security_sources SET state='revoked' WHERE owner=? AND installation_id=?").run(f.owner,installation.id);
    await client.query(`UPDATE "${schema}".security_sources SET state='revoked' WHERE owner=$1 AND installation_id=$2`,[f.owner,installation.id]);
    assert.equal(sourceMatchesObservation(f.jobs.security.policies.sources(f.owner,installation.id),retainedOrigin,place.type),false);assert.equal(await retainedSource(),false);assert.equal(sqliteOutput(),undefined);assert.equal(await authorizedOutput(),undefined);
    sqlite.prepare("UPDATE security_sources SET state='active' WHERE owner=? AND installation_id=?").run(f.owner,installation.id);
    await client.query(`UPDATE "${schema}".security_sources SET state='active' WHERE owner=$1 AND installation_id=$2`,[f.owner,installation.id]);
    const foreignGrant=randomUUID(),foreignInstallation=randomUUID();
    sqlite.prepare(`INSERT INTO security_grants(rowid,id,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,state,expires_at,body)
      SELECT 110,?,kind,owner,member_id,?,parent_id,parent_revision,revision,'revoked',expires_at,body FROM security_grants WHERE id=?`).run(foreignGrant,foreignInstallation,task.grant.id);
    await client.query(`INSERT INTO "${schema}".security_grants(id,kind,owner,member_id,installation_id,parent_id,parent_revision,revision,state,expires_at,body,__eigos_rowid)
      SELECT $1,kind,owner,member_id,$2,parent_id,parent_revision,revision,'revoked',expires_at,body,110 FROM "${schema}".security_grants WHERE id=$3`,[foreignGrant,foreignInstallation,task.grant.id]);
    const foreignBinding={...retainedBase,fields:['address']};
    sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(foreignGrant,f.owner,task.job.id,1,place.type,place.id,1,JSON.stringify(foreignBinding));
    await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[foreignGrant,f.owner,task.job.id,place.type,place.id,JSON.stringify(foreignBinding)]);
    assert.deepEqual(await retained(place),sqliteRetained(place),'newer evidence from another installation must not be used');
    const storedJob=String(sqlite.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(f.owner,task.job.id)!.body),retainedChangedJob=JSON.parse(storedJob);retainedChangedJob.delegation.request.originalGoal='different synthetic goal';
    sqlite.prepare('UPDATE jobs SET body=? WHERE owner=? AND id=?').run(JSON.stringify(retainedChangedJob),f.owner,task.job.id);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE owner=$2 AND id=$3`,[JSON.stringify(retainedChangedJob),f.owner,task.job.id]);
    assert.equal(sqliteRetained(place),undefined);assert.equal(await retained(place),undefined);assert.equal(await retainedSource(),false);assert.equal(await retainedFields(),undefined);assert.equal(await authorizedOutput(),undefined);
    sqlite.prepare('UPDATE jobs SET body=? WHERE owner=? AND id=?').run(storedJob,f.owner,task.job.id);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE owner=$2 AND id=$3`,[storedJob,f.owner,task.job.id]);
    const withoutOutput={...readGrant,outputs:[]};
    sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(withoutOutput),task.grant.id);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(withoutOutput),task.grant.id]);
    assert.equal(sqliteRetained(place),undefined);assert.equal(await retained(place),undefined);assert.equal(await retainedSource(),false);
    sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(readGrant),task.grant.id);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(readGrant),task.grant.id]);
    const changedOrigin={...retainedOrigin,inputEnvelope:{...retainedOrigin.inputEnvelope,submission:{...submission,contentDigest:'c'.repeat(64)}}};
    sqlite.prepare('UPDATE security_object_origins SET body=? WHERE owner=? AND type=? AND object_id=? AND object_revision=1').run(JSON.stringify(changedOrigin),f.owner,place.type,place.id);
    await client.query(`UPDATE "${schema}".security_object_origins SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND object_revision=1`,[JSON.stringify(changedOrigin),f.owner,place.type,place.id]);
    assert.equal(sqliteRetained(place),undefined);assert.equal(await retained(place),undefined);assert.equal(await retainedSource(),false);
    sqlite.prepare('UPDATE security_object_origins SET body=? WHERE owner=? AND type=? AND object_id=? AND object_revision=1').run(JSON.stringify(retainedOrigin),f.owner,place.type,place.id);
    await client.query(`UPDATE "${schema}".security_object_origins SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND object_revision=1`,[JSON.stringify(retainedOrigin),f.owner,place.type,place.id]);
    const wrongTask={...retainedBase,sourceBindingId:'task_submission'};
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(wrongTask),priorIds[1]!,place.type,place.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(wrongTask),priorIds[1],place.type,place.id]);
    assert.equal(sqliteRetained(place),undefined);assert.equal(await retained(place),undefined,'newer invalid evidence must not fall back to an older grant');
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(retainedBase),priorIds[1]!,place.type,place.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(retainedBase),priorIds[1],place.type,place.id]);
    const historicalCap={type:'RegisteredCapability',id:`capability:${'f'.repeat(64)}`},historicalCapBody=JSON.stringify({source:{kind:'task',id:'previous-task'},properties:{definitionDigest:'f'.repeat(64)}});
    const historicalBinding={object:historicalCap,revision:1,fields:['id','name'],sourceBindingId:'task_context',envelope:rootBinding.envelope};
    sqlite.prepare('INSERT INTO ontology_objects(owner,type,id,revision,definition_digest,body) VALUES(?,?,?,?,?,?)').run(f.owner,historicalCap.type,historicalCap.id,1,'a'.repeat(64),historicalCapBody);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,$5)`,[f.owner,historicalCap.type,historicalCap.id,'a'.repeat(64),historicalCapBody]);
    sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(priorIds[1]!,f.owner,task.job.id,1,historicalCap.type,historicalCap.id,1,JSON.stringify(historicalBinding));
    await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[priorIds[1],f.owner,task.job.id,historicalCap.type,historicalCap.id,JSON.stringify(historicalBinding)]);
    assert.equal(await retained(historicalCap),undefined);assert.equal(sqliteRetained(historicalCap),undefined);
    assert.deepEqual(await retained(historicalCap,true),sqliteRetained(historicalCap,true));
    const projection={type:'GoalCoverage',id:'retained-projection'},projectionBody=JSON.stringify({source:{kind:'task',id:task.job.id},properties:{requestRevision:1}});
    const projectionBinding={object:projection,revision:1,fields:['id','displayTitle'],sourceBindingId:'task_projection',envelope:rootBinding.envelope};
    sqlite.prepare('INSERT INTO ontology_objects(owner,type,id,revision,definition_digest,body) VALUES(?,?,?,?,?,?)').run(f.owner,projection.type,projection.id,1,'a'.repeat(64),projectionBody);
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,$5)`,[f.owner,projection.type,projection.id,'a'.repeat(64),projectionBody]);
    sqlite.prepare('INSERT INTO security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES(?,?,?,?,?,?,?,?)').run(priorIds[1]!,f.owner,task.job.id,1,projection.type,projection.id,1,JSON.stringify(projectionBinding));
    await client.query(`INSERT INTO "${schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4,$5,1,$6)`,[priorIds[1],f.owner,task.job.id,projection.type,projection.id,JSON.stringify(projectionBinding)]);
    assert.deepEqual(await retained(projection),sqliteRetained(projection));
    const laterProjection=JSON.stringify({source:{kind:'task',id:task.job.id},properties:{requestRevision:2}});
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(laterProjection,f.owner,projection.type,projection.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[laterProjection,f.owner,projection.type,projection.id]);
    assert.equal(sqliteRetained(projection),undefined);assert.equal(await retained(projection),undefined);
    sqlite.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(projectionBody,f.owner,projection.type,projection.id);
    await client.query(`UPDATE "${schema}".ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`,[projectionBody,f.owner,projection.type,projection.id]);
    // Remote retained-evidence validation can finish on one bounded connection
    // without replaying the independent admission/role/clearance suite.
    if(process.env.EIGOS_TEST_RETAINED_ONLY==='1')return;
    if (process.env.EIGOS_TEST_LARGE_ROW==='1') {
      // Generate the synthetic large value inside PostgreSQL; it must never be
      // sent to the client by authorization or ontology-context reads.
      await client.query(`UPDATE "${schema}".jobs SET body=jsonb_set(body::jsonb,'{padding}',to_jsonb(repeat('x',108452531)))::text WHERE id=$1`,[task.job.id]);
      const observed=new Proxy(client,{get(target,property){
        if(property==='query')return async(sql:string,values?:unknown[])=>{
          const result=await target.query(sql,values);
          for(const row of result.rows)for(const value of Object.values(row))if(typeof value==='string')assert(Buffer.byteLength(value)<=8*1024*1024,'A database response returned an unbounded task field');
          return result;
        };
        const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
      }});
      const large=await postgresBusinessTransaction(observed,schema,authority,c=>postgresTaskReadOntology(c,principal,task.job.id,policy,staged));
      assert.deepEqual(large.ref,task.job.delegation!.ontologyRelease);
      await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[JSON.stringify(task.job),task.job.id]);
    }
    const original=f.jobs.security.scope(f.jobs.security.agentContext(principal),task.job.id,'task.result.read').grant!;
    const read=()=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadGrant(c,principal,task.job.id,policy));
    assert.equal((await read()).grant.id,original.id);
    const model=await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.ontology(c,principal,task.job.id,policy));
    assert.deepEqual(model.ref,task.job.delegation!.ontologyRelease);
    const ref={type:'ServiceRequest',id:task.job.id};
    const bindingRow=sqlite.prepare('SELECT body FROM security_bindings WHERE grant_id=? AND type=? AND object_id=?').get(task.grant.id,ref.type,ref.id)!;
    const binding=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.directBindingEvidence(c,principal,task.job.id,policy,ref));
    assert.deepEqual(await binding(),JSON.parse(String(bindingRow.body)));
    const candidateFields=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.directFieldCandidates(c,principal,task.job.id,policy,ref));
    const sqliteFields=()=>f.jobs.security.withAgent(principal,task.job.id,'task.result.read',scope=>f.jobs.security.policies.binding(scope,ref)?.fields);
    const permittedFields=sqliteFields();assert(permittedFields?.includes('requestId') && permittedFields.includes('originalGoal'));
    assert.deepEqual((await candidateFields())?.fields,permittedFields);
    const parentRow=sqlite.prepare('SELECT body FROM security_grants WHERE id=?').get(parentGrantId)!;
    const narrowedParent=JSON.parse(String(parentRow.body));narrowedParent.resources=[{type:'ServiceRequest',fields:['requestId']}];
    sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(narrowedParent),parentGrantId);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(narrowedParent),parentGrantId]);
    const narrowedFields=(await candidateFields())?.fields;
    assert.deepEqual(narrowedFields,sqliteFields());assert(!narrowedFields?.includes('originalGoal'));
    sqlite.prepare('UPDATE security_grants SET body=? WHERE id=?').run(parentRow.body!,parentGrantId);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[parentRow.body,parentGrantId]);
    const sqliteRecipient=sqlite.prepare('SELECT body FROM security_recipients WHERE installation_id=?').get(installation.id)!;
    const restrictedRecipient={...recipient,markings:['member_private']};
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(JSON.stringify(restrictedRecipient),installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[JSON.stringify(restrictedRecipient),installation.id]);
    assert.deepEqual((await candidateFields())?.fields,sqliteFields());
    assert.equal(await candidateFields(),undefined);
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(sqliteRecipient.body!,installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[sqliteRecipient.body,installation.id]);
    const noAgentChannel={...recipient,channels:['registered_model']};
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(JSON.stringify(noAgentChannel),installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[JSON.stringify(noAgentChannel),installation.id]);
    assert.deepEqual((await candidateFields())?.fields,sqliteFields());
    assert.equal(await candidateFields(),undefined);
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(sqliteRecipient.body!,installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[sqliteRecipient.body,installation.id]);
    const fieldLabel=sqlite.prepare("SELECT body FROM security_labels WHERE owner=? AND type=? AND object_id=? AND field='originalGoal'").get(f.owner,ref.type,ref.id)!;
    const internalLabel={...JSON.parse(String(fieldLabel.body)),classification:'internal'};
    sqlite.prepare("UPDATE security_labels SET body=? WHERE owner=? AND type=? AND object_id=? AND field='originalGoal'").run(JSON.stringify(internalLabel),f.owner,ref.type,ref.id);
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='originalGoal'`,[JSON.stringify(internalLabel),f.owner,ref.type,ref.id]);
    assert.deepEqual((await candidateFields())?.fields,sqliteFields());
    sqlite.prepare("UPDATE security_labels SET body=? WHERE owner=? AND type=? AND object_id=? AND field='originalGoal'").run(fieldLabel.body!,f.owner,ref.type,ref.id);
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='originalGoal'`,[fieldLabel.body,f.owner,ref.type,ref.id]);
    const bindingWithRestrictedInput=JSON.parse(String(bindingRow.body));
    bindingWithRestrictedInput.inputEnvelope={...bindingWithRestrictedInput.envelope,classification:'sensitive',requiredMarkings:['health'],channels:['agent_response'],lineage:[],lineageComplete:true};
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(JSON.stringify(bindingWithRestrictedInput),task.grant.id,ref.type,ref.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(bindingWithRestrictedInput),task.grant.id,ref.type,ref.id]);
    assert.deepEqual((await candidateFields())?.fields,sqliteFields());
    assert.equal(await candidateFields(),undefined);
    sqlite.prepare('UPDATE security_bindings SET body=? WHERE grant_id=? AND type=? AND object_id=?').run(bindingRow.body!,task.grant.id,ref.type,ref.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[bindingRow.body,task.grant.id,ref.type,ref.id]);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.directBindingEvidence(c,principal,task.job.id,policy,{type:ref.type,id:'absent'})),undefined);
    await client.query(`UPDATE "${schema}".security_bindings SET grant_id='older-grant' WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[task.grant.id,ref.type,ref.id]);
    assert.equal(await binding(),undefined);
    await client.query(`UPDATE "${schema}".security_bindings SET grant_id=$1 WHERE grant_id='older-grant' AND type=$2 AND object_id=$3`,[task.grant.id,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".security_bindings SET body=repeat('x',1048577) WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[task.grant.id,ref.type,ref.id]);
    await assert.rejects(binding(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[bindingRow.body,task.grant.id,ref.type,ref.id]);
    const alteredBinding={...JSON.parse(String(bindingRow.body)),object:{...ref,id:'different-object'}};
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(alteredBinding),task.grant.id,ref.type,ref.id]);
    await assert.rejects(binding(),/POLICY_CHANGED/);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[bindingRow.body,task.grant.id,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".security_bindings SET task_id='different-task' WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[task.grant.id,ref.type,ref.id]);
    await assert.rejects(binding(),/POLICY_CHANGED/);
    await client.query(`UPDATE "${schema}".security_bindings SET task_id=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[task.job.id,task.grant.id,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".ontology_objects SET revision=2 WHERE owner=$1 AND type=$2 AND id=$3`,[f.owner,ref.type,ref.id]);
    assert.equal(await binding(),undefined);
    await client.query(`UPDATE "${schema}".ontology_objects SET revision=1 WHERE owner=$1 AND type=$2 AND id=$3`,[f.owner,ref.type,ref.id]);
    const origin={programId:'brief.prepare',programDigest:'b'.repeat(64),sourceBindingId:'synthetic-source'};
    const providerBinding={...JSON.parse(String(bindingRow.body)),sourceBindingId:origin.sourceBindingId,sourceObservation:origin};
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(providerBinding),task.grant.id,ref.type,ref.id]);
    const sourceAllowed=()=>postgresBusinessTransaction(client,schema,authority,c=>stagedReader.sourceObservationAllowed(c,principal,task.job.id,policy,ref));
    assert.equal(sourceMatchesObservation(f.jobs.security.policies.sources(f.owner,installation.id),origin,ref.type),true);
    assert.equal(await sourceAllowed(),true);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify({...providerBinding,sourceObservation:{...origin,sourceBindingId:'different-source'}}),task.grant.id,ref.type,ref.id]);
    assert.equal(await sourceAllowed(),false);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify(providerBinding),task.grant.id,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".security_sources SET state='revoked' WHERE installation_id=$1`,[installation.id]);assert.equal(await sourceAllowed(),false);
    await client.query(`UPDATE "${schema}".security_sources SET state='active' WHERE installation_id=$1`,[installation.id]);
    const originalSource=sqlite.prepare('SELECT body FROM security_sources WHERE owner=? AND installation_id=?').get(f.owner,installation.id)!;
    const sourceBody=JSON.parse(String(originalSource.body));
    const updateSource=(body:unknown)=>client.query(`UPDATE "${schema}".security_sources SET body=$1 WHERE installation_id=$2`,[JSON.stringify(body),installation.id]);
    await client.query(`INSERT INTO "${schema}".security_sources(owner,installation_id,binding_id,program_id,state,body) SELECT $1,$2,'overflow-'||n,'program','active',$3 FROM generate_series(1,256) n`,[f.owner,installation.id,originalSource.body]);
    await assert.rejects(sourceAllowed(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`DELETE FROM "${schema}".security_sources WHERE owner=$1 AND installation_id=$2 AND binding_id LIKE 'overflow-%'`,[f.owner,installation.id]);
    await updateSource({...sourceBody,expiresAt:'2000-01-01T00:00:00.000Z'});assert.equal(await sourceAllowed(),false);
    await updateSource({...sourceBody,parentGrant:{...sourceBody.parentGrant,revision:sourceBody.parentGrant.revision+1}});assert.equal(await sourceAllowed(),false);
    await updateSource({...sourceBody,outputTypes:['Place']});assert.equal(await sourceAllowed(),false);
    await updateSource({...sourceBody,bindingId:'different-source'});await assert.rejects(sourceAllowed(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_sources SET body=repeat('x',65537) WHERE installation_id=$1`,[installation.id]);
    await assert.rejects(sourceAllowed(),/OUTPUT_NOT_ALLOWED/);
    const oldOrigin={...origin,sourceBindingId:'previous-source',programDigest:'c'.repeat(64)};
    const historicalSource={...sourceBody,readbackVersions:[{sourceBindingId:oldOrigin.sourceBindingId,programDigest:oldOrigin.programDigest}]};
    await updateSource(historicalSource);
    sqlite.prepare('UPDATE security_sources SET body=? WHERE owner=? AND installation_id=?').run(JSON.stringify(historicalSource),f.owner,installation.id);
    assert.equal(sourceMatchesObservation(f.jobs.security.policies.sources(f.owner,installation.id),oldOrigin,ref.type),true);
    sqlite.prepare('UPDATE security_sources SET body=? WHERE owner=? AND installation_id=?').run(originalSource.body!,f.owner,installation.id);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify({...providerBinding,sourceBindingId:oldOrigin.sourceBindingId,sourceObservation:oldOrigin}),task.grant.id,ref.type,ref.id]);
    assert.equal(await sourceAllowed(),true);
    await updateSource(sourceBody);assert.equal(await sourceAllowed(),false);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[JSON.stringify({...providerBinding,sourceObservation:undefined}),task.grant.id,ref.type,ref.id]);
    await client.query(`DELETE FROM "${schema}".security_object_origins WHERE owner=$1 AND type=$2 AND object_id=$3 AND object_revision=1`,[f.owner,ref.type,ref.id]);
    await client.query(`INSERT INTO "${schema}".security_object_origins(owner,type,object_id,object_revision,body) VALUES($1,$2,$3,1,$4)`,[f.owner,ref.type,ref.id,JSON.stringify(origin)]);
    assert.equal(await sourceAllowed(),true);
    await client.query(`UPDATE "${schema}".security_object_origins SET body='invalid' WHERE owner=$1 AND type=$2 AND object_id=$3 AND object_revision=1`,[f.owner,ref.type,ref.id]);
    await assert.rejects(sourceAllowed(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[bindingRow.body,task.grant.id,ref.type,ref.id]);
    assert.equal(await sourceAllowed(),false,'task-owned bindings are not provider source permissions');
    let labelRoundTrips=0;
    const observedLabels=new Proxy(client,{get(target,property){
      if(property==='query')return async(sql:string,values?:unknown[])=>{
        if(values?.[0]===f.owner&&values[1]===ref.type&&values[2]===ref.id
          &&(sql.includes(`FROM "${schema}".ontology_objects`)||sql.includes(`FROM "${schema}".security_labels`)))labelRoundTrips++;
        return target.query(sql,values);
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
    const labels=await postgresBusinessTransaction(observedLabels,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal']));
    assert.equal(labelRoundTrips,1,'A current object revision and its labels use one database round trip');
    const expectedLabels=sqlite.prepare("SELECT field,body FROM security_labels WHERE owner=? AND type=? AND object_id=? AND field IN ('*','originalGoal') ORDER BY field").all(f.owner,ref.type,ref.id).map(row=>({field:row.field,...JSON.parse(String(row.body))}));
    assert.deepEqual(labels,expectedLabels);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,{...ref,id:randomUUID()},1,['originalGoal'])),/POLICY_CHANGED/);
    const duplicateObjectRow=(await client.query(`INSERT INTO "${schema}".ontology_objects SELECT * FROM "${schema}".ontology_objects WHERE owner=$1 AND type=$2 AND id=$3 RETURNING ctid::text AS ctid`,[f.owner,ref.type,ref.id])).rows[0].ctid;
    try {await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/POLICY_CHANGED/);}
    finally {await client.query(`DELETE FROM "${schema}".ontology_objects WHERE ctid=$1::tid`,[duplicateObjectRow]);}
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,2,['originalGoal'])),/POLICY_CHANGED/);
    await client.query(`UPDATE "${schema}".security_labels SET body=repeat('x',65537) WHERE owner=$1 AND type=$2 AND object_id=$3 AND field='originalGoal'`,[f.owner,ref.type,ref.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/OUTPUT_NOT_ALLOWED/);
    const originalLabel=sqlite.prepare("SELECT body FROM security_labels WHERE owner=? AND type=? AND object_id=? AND field='originalGoal'").get(f.owner,ref.type,ref.id)!;
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='originalGoal'`,[originalLabel.body,f.owner,ref.type,ref.id]);
    const otherLabel=sqlite.prepare("SELECT body FROM security_labels WHERE owner=? AND type=? AND object_id=? AND field='requestId'").get(f.owner,ref.type,ref.id)!;
    await client.query(`UPDATE "${schema}".security_labels SET body='invalid' WHERE owner=$1 AND type=$2 AND object_id=$3 AND field='requestId'`,[f.owner,ref.type,ref.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='requestId'`,[otherLabel.body,f.owner,ref.type,ref.id]);
    await client.query(`INSERT INTO "${schema}".security_labels(owner,type,object_id,field,body) SELECT $1,$2,$3,'synthetic'||n,$4 FROM generate_series(1,254) n`,[f.owner,ref.type,ref.id,originalLabel.body]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/OUTPUT_NOT_ALLOWED/);
    await client.query(`DELETE FROM "${schema}".security_labels WHERE owner=$1 AND type=$2 AND object_id=$3 AND field LIKE 'synthetic%'`,[f.owner,ref.type,ref.id]);
    await client.query(`UPDATE "${schema}".security_labels SET body='{}' WHERE owner=$1 AND type=$2 AND object_id=$3 AND field='originalGoal'`,[f.owner,ref.type,ref.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_labels SET body=$1 WHERE owner=$2 AND type=$3 AND object_id=$4 AND field='originalGoal'`,[originalLabel.body,f.owner,ref.type,ref.id]);
    const projected={type:'RollingGoSearchObservation',id:'synthetic-label-projection'};
    await client.query(`INSERT INTO "${schema}".ontology_objects(owner,type,id,revision,definition_digest,body) VALUES($1,$2,$3,1,$4,'{}')`,[f.owner,projected.type,projected.id,'a'.repeat(64)]);
    assert.deepEqual(await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,projected,1,['observedData'])),[],'An existing unlabeled object stays distinct from a missing object');
    await client.query(`INSERT INTO "${schema}".security_labels(owner,type,object_id,field,body) VALUES($1,$2,$3,'snapshot',$4)`,[f.owner,projected.type,projected.id,originalLabel.body]);
    const projectedLabels=await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,projected,1,['observedData']));
    assert.deepEqual(projectedLabels.map(label=>label.field),['snapshot']);
    for(const [type,field] of [['ServiceRequest','originalGoal'],['ServiceRequest','requestId'],['ServiceRequest','progress'],['ServiceRequest','unreviewed'],['NonexistentType','field']] as const) {
      const expected=f.jobs.security.policies.fieldPolicy(type,field);
      const actual=await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.fieldClassification(c,principal,task.job.id,policy,type,field));
      assert.equal(actual,expected);
    }
    const envelope={version:SECURITY_CONTRACT,ownerKey:f.owner,policyVersion:POLICY_VERSION,requiredMarkings:['member_private'] as const,classification:'private' as const,channels:['agent_response'] as const,lineage:[],lineageComplete:true};
    const sqliteScope=f.jobs.security.scope(f.jobs.security.agentContext(principal),task.job.id,'task.result.read');
    f.jobs.security.policies.requireRecipient(sqliteScope,{...envelope,requiredMarkings:[...envelope.requiredMarkings],channels:[...envelope.channels]},'agent_response');
    const clearance=()=>postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadClearance(c,principal,task.job.id,policy));
    assert.deepEqual(await clearance(),recipient);
    assert.deepEqual(await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.clearance(c,principal,task.job.id,policy)),recipient);
    const recipientBody=String(sqlite.prepare('SELECT body FROM security_recipients WHERE installation_id=?').get(installation.id)!.body);
    const expiredRecipient={...recipient,expiresAt:'2000-01-01T00:00:00.000Z'};
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(JSON.stringify(expiredRecipient),installation.id);
    assert.throws(()=>f.jobs.security.policies.requireRecipient(sqliteScope,{...envelope,requiredMarkings:[...envelope.requiredMarkings],channels:[...envelope.channels]},'agent_response'),/OUTPUT_NOT_ALLOWED/);
    sqlite.prepare('UPDATE security_recipients SET body=? WHERE installation_id=?').run(recipientBody,installation.id);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[JSON.stringify(expiredRecipient),installation.id]);
    assert.equal(await clearance(),undefined);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[recipientBody,installation.id]);
    sqlite.prepare('DELETE FROM security_recipients WHERE installation_id=?').run(installation.id);
    assert.throws(()=>f.jobs.security.policies.requireRecipient(sqliteScope,{...envelope,requiredMarkings:[...envelope.requiredMarkings],channels:[...envelope.channels]},'agent_response'),/OUTPUT_NOT_ALLOWED/);
    sqlite.prepare('INSERT INTO security_recipients VALUES(?,?)').run(installation.id,recipientBody);
    await client.query(`DELETE FROM "${schema}".security_recipients WHERE installation_id=$1`,[installation.id]); assert.equal(await clearance(),undefined);
    await client.query(`INSERT INTO "${schema}".security_recipients VALUES($1,$2)`,[installation.id,recipientBody]);
    await client.query(`UPDATE "${schema}".security_recipients SET body=repeat('x',65537) WHERE installation_id=$1`,[installation.id]);
    await assert.rejects(clearance(),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_recipients SET body=$1 WHERE installation_id=$2`,[recipientBody,installation.id]);
    for(const type of ['ServiceRequest','Place','NonexistentType']) {
      const expected=f.jobs.security.policies.resourceAllowedFor(f.member.id,installation.id,'objectType',type);
      const actual=await postgresBusinessTransaction(client,schema,authority,c=>stagedReader.resourceViewAllowed(c,principal,task.job.id,policy,'objectType',type));
      assert.equal(actual,expected);
    }
    assert.equal(f.jobs.security.policies.resourceAllowedFor(f.member.id,installation.id,'objectType','ServiceRequest'),true);
    const role=sqlite.prepare('SELECT id,body FROM security_roles WHERE subject_id=?').get(installation.id)!;
    const expiredRole={...JSON.parse(String(role.body)),expiresAt:'2000-01-01T00:00:00.000Z'};
    sqlite.prepare('UPDATE security_roles SET body=? WHERE id=?').run(JSON.stringify(expiredRole),role.id!);
    assert.equal(f.jobs.security.policies.resourceAllowedFor(f.member.id,installation.id,'objectType','ServiceRequest'),false);
    sqlite.prepare('UPDATE security_roles SET body=? WHERE id=?').run(role.body!,role.id!);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[JSON.stringify(expiredRole),role.id]);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest',staged)),false);
    assert.equal(await candidateFields(),undefined);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    // A role may expire while the final grant recheck is waiting on PostgreSQL.
    // Advance only this test process's clock after the role query completes.
    const realNow=Date.now,shortRole={...JSON.parse(String(role.body)),expiresAt:new Date(realNow()+30000).toISOString()};
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[JSON.stringify(shortRole),role.id]);
    let clockShift=0,sawRole=false;
    const delayedRole=new Proxy(client,{get(target,property){
      if(property==='query')return async(sql:string,values?:unknown[])=>{
        const result=await target.query(sql,values);
        if(!sawRole && sql.includes('.security_roles')){assert(realNow()<Date.parse(shortRole.expiresAt));sawRole=true;clockShift=40000;}
        return result;
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
    try {
      Date.now=()=>realNow()+clockShift;
      assert.equal(await postgresBusinessTransaction(delayedRole,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest',staged)),false);
      assert(sawRole);
    } finally {
      Date.now=realNow;
      await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    }
    // Historical task models must not revive a namespace role for an old
    // security policy version. SQLite evaluates roles against the reviewed
    // current security model, not the task's historical read model.
    const legacy=f.jobs.definitions.legacy(),historicalJob={...task.job,delegation:{...task.job.delegation!,backendVersion:'historical',ontologyRelease:legacy.ref}};
    assert.notEqual(legacy.model.ref.digest,f.jobs.security.model.ref.digest);
    const historicalRole={...JSON.parse(String(role.body)),resource:{kind:'namespace',id:legacy.model.ref.id,version:legacy.model.ref.digest}};
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(historicalJob),task.job.id);
    sqlite.prepare('UPDATE security_roles SET body=? WHERE id=?').run(JSON.stringify(historicalRole),role.id!);
    assert.equal(f.jobs.security.policies.resourceAllowedFor(f.member.id,installation.id,'objectType','ServiceRequest'),false);
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(task.job),task.job.id);
    sqlite.prepare('UPDATE security_roles SET body=? WHERE id=?').run(role.body!,role.id!);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[JSON.stringify(historicalJob),task.job.id]);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[JSON.stringify(historicalRole),role.id]);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest',staged)),false);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[JSON.stringify(task.job),task.job.id]);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    await client.query(`INSERT INTO "${schema}".security_roles SELECT 'synthetic-'||n,$1,'{}' FROM generate_series(1,257) n`,[installation.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest')),/OUTPUT_NOT_ALLOWED/);
    await client.query(`DELETE FROM "${schema}".security_roles WHERE id LIKE 'synthetic-%'`);
    await client.query(`UPDATE "${schema}".security_roles SET body=repeat('x',65537) WHERE id=$1`,[role.id]);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskResourceViewAllowed(c,principal,task.job.id,policy,'objectType','ServiceRequest')),/OUTPUT_NOT_ALLOWED/);
    await client.query(`UPDATE "${schema}".security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    const wrong={...principal,subject:'someone-else'};
    assert.throws(()=>f.jobs.security.agentContext(wrong),/AUTHORIZATION_REQUIRED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadGrant(c,wrong,task.job.id,policy)),/AUTHORIZATION_REQUIRED/);
    const alteredScopes={...principal,scopes:principal.scopes.filter(scope=>scope!=='tasks:read')};
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadGrant(c,alteredScopes,task.job.id,policy)),/Required scope: tasks:read/);
    sqlite.prepare('UPDATE security_subjects SET epoch=epoch+1 WHERE installation_id=?').run(installation.id);
    assert.throws(()=>f.jobs.security.agentContext(principal),/POLICY_CHANGED/);
    sqlite.prepare('UPDATE security_subjects SET epoch=epoch-1 WHERE installation_id=?').run(installation.id);
    await client.query(`UPDATE "${schema}".security_subjects SET epoch=epoch+1 WHERE installation_id=$1`,[installation.id]);
    await assert.rejects(read(),/POLICY_CHANGED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.ontology(c,principal,task.job.id,policy)),/POLICY_CHANGED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>stagedReader.currentLabels(c,principal,task.job.id,policy,ref,1,['originalGoal'])),/POLICY_CHANGED/);
    await assert.rejects(binding(),/POLICY_CHANGED/);
    await assert.rejects(sourceAllowed(),/POLICY_CHANGED/);
    await assert.rejects(candidateFields(),/POLICY_CHANGED/);
    await assert.rejects(members(),/POLICY_CHANGED/);
    await assert.rejects(contextCandidate(specRef),/POLICY_CHANGED/);
    await client.query(`UPDATE "${schema}".security_subjects SET epoch=epoch-1 WHERE installation_id=$1`,[installation.id]);
    const grantBody=JSON.stringify(readGrant),field=`"taskId":"${task.job.id}"`,duplicate=grantBody.replace(field,`${field},${field}`); assert.notEqual(duplicate,grantBody);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[duplicate,task.grant.id]);
    await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".security_grants SET body=$1 WHERE id=$2`,[grantBody,task.grant.id]);
    const fence:[string,string,string,string,number,string]=[randomUUID(),f.owner,'installation',installation.id,1,'pending'];
    sqlite.prepare('INSERT INTO security_fences VALUES(?,?,?,?,?,?)').run(...fence);
    assert.throws(()=>f.jobs.security.agentContext(principal),/ACCESS_REVOKED/);
    sqlite.prepare('DELETE FROM security_fences WHERE id=?').run(fence[0]);
    await client.query(`INSERT INTO "${schema}".security_fences VALUES($1,$2,$3,$4,$5,$6)`,fence);
    await assert.rejects(read(),/ACCESS_REVOKED/);
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>postgresTaskReadOntology(c,principal,task.job.id,policy)),/ACCESS_REVOKED/);
    await client.query(`DELETE FROM "${schema}".security_fences WHERE id=$1`,[fence[0]]);
    sqlite.prepare('UPDATE security_grants SET expires_at=0 WHERE id=?').run(task.grant.id);
    assert.throws(()=>f.jobs.security.taskGrant(f.jobs.security.agentContext(principal),task.job.id),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare('UPDATE security_grants SET expires_at=? WHERE id=?').run(consentExpiryIndex(task.grant.expiresAt),task.grant.id);
    await client.query(`UPDATE "${schema}".security_grants SET expires_at=0 WHERE id=$1`,[task.grant.id]); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".security_grants SET expires_at=$1 WHERE id=$2`,[consentExpiryIndex(task.grant.expiresAt),task.grant.id]);
    const jobBody=String(sqlite.prepare('SELECT body FROM jobs WHERE id=?').get(task.job.id)!.body),changedJob=JSON.parse(jobBody); changedJob.delegation.request.revision++;
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(changedJob),task.job.id);
    assert.throws(()=>f.jobs.security.taskGrant(f.jobs.security.agentContext(principal),task.job.id),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare('UPDATE jobs SET body=? WHERE id=?').run(jobBody,task.job.id);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[JSON.stringify(changedJob),task.job.id]); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[jobBody,task.job.id]);
    const request=JSON.stringify(JSON.parse(jobBody).delegation.request), ambiguousRequest=request.replace('"revision":1','"revision":1,"revision":1');
    const ambiguousJob=jobBody.replace(`"request":${request}`,`"request":${ambiguousRequest}`); assert.notEqual(ambiguousJob,jobBody);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[ambiguousJob,task.job.id]); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".jobs SET body=$1 WHERE id=$2`,[jobBody,task.job.id]);
    const parent=f.jobs.security.agentGrant(installation.id);
    sqlite.prepare("UPDATE security_grants SET state='revoked' WHERE id=?").run(parent.id);
    assert.throws(()=>f.jobs.security.agentContext(principal),/AUTHORIZATION_REQUIRED/);
    sqlite.prepare("UPDATE security_grants SET state='active' WHERE id=?").run(parent.id);
    await client.query(`UPDATE "${schema}".security_grants SET state='revoked' WHERE id=$1`,[parent.id]); await assert.rejects(read(),/AUTHORIZATION_REQUIRED/);
    await client.query(`UPDATE "${schema}".security_grants SET state='active' WHERE id=$1`,[parent.id]);
    const scoped=structuredClone(principal);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadGrant(c,scoped,task.job.id,policy,async()=>{scoped.subject='changed';return 'scoped';})),'scoped');
    await assert.rejects(postgresBusinessTransaction(client,schema,authority,c=>withPostgresTaskReadGrant(c,principal,task.job.id,policy,async()=>{
      await c.query(`UPDATE "${schema}".security_grants SET revision=revision+1 WHERE id=$1`,[task.grant.id]); return 'not exposed';
    })),/POLICY_CHANGED/);
    assert.equal((await read()).grant.revision,original.revision,'failed post-check rolls back the action');
  } finally {
    try {await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}
    finally {try {await client.end();} finally {sqlite.close();f.close();}}
  }
});
