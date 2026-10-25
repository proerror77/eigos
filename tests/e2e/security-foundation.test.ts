import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import {promisify} from 'node:util';
import { resolve } from 'node:path';
import { writeFileSync,readFileSync,existsSync } from 'node:fs';
import {randomUUID} from 'node:crypto';
import { securityFixture } from '../fixtures/security.js';
import { currentKernelImplementation } from '../../packages/ontology/definition-store.js';
const policyModel = currentKernelImplementation();
import {securedProgramFixture} from '../fixtures/secured-program.js';
import {participantFixture} from '../fixtures/free-booking.js';
import {ParticipantBookingProgram} from '../../packages/capabilities/free-booking/program.js';

async function compiledCommand(args: string[], env: NodeJS.ProcessEnv) {
  // A separate Gateway would keep publishing eligibility while this CLI runs.
  // Do not block that publisher in the in-process fixture with spawnSync.
  try { const result = await promisify(execFile)(process.execPath, args, { env, encoding: 'utf8', timeout: 30000 }); return { status: 0, ...result }; }
  catch (error) { const failure = error as Error & { code?: number; stdout?: string; stderr?: string }; return { status: failure.code ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr || failure.message }; }
}


test('E2E: the existing compiled members CLI enforces the same persistent Worker revocation fence', async () => {
  const f = securityFixture();
  try {
    const a = f.installation('Compiled CLI test'); f.approve(a.id); const task = f.task(a.id);
    const claimedAt = Date.now(), leaseMs = 120000;
    const claim = f.jobs.claim(['eigos.delegate'], leaseMs)!; assert(claim);
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: f.database, MEMBERSHIP_DATABASE_PATH: f.membership };
    delete env.EIGOS_SECURITY_MODE;
    const run = await compiledCommand([resolve('scripts/members.mjs'), 'suspend', f.member.id], env);
    assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).status, 'suspended');
    assert(Date.now() - claimedAt < leaseMs, 'Revocation must be observed before ordinary lease expiry');
    assert.equal(f.jobs.renew(claim, 10000), false); assert.equal(f.jobs.security.workAuthority(f.owner, task.job.id), undefined);
    assert.equal(f.jobs.security.pendingFences().length, 0);
    const restore = await compiledCommand([resolve('scripts/members.mjs'), 'approve', f.member.id], env);
    assert.equal(restore.status, 0, restore.stderr);
    assert.throws(() => f.coordinator.authenticate(f.principal, a.token), /AUTHORIZATION_REQUIRED/);
    assert.equal(f.jobs.security.workAuthority(f.owner, task.job.id), undefined);
  } finally { f.close(); }
});

test('E2E: compiled local policy administration uses revision checks and definition review does not publish',async()=>{
  const f=securityFixture();try {
    const a=f.installation('Policy CLI');f.approve(a.id);const policy=f.jobs.security.policies;
    const inputFile=resolve(f.directory,'reviewed-input.json'),candidateFile=resolve(f.directory,'candidate.json');
    const run=async(command:string,input?:object)=>{
      if(input)writeFileSync(inputFile,JSON.stringify(input),{mode:0o600});
      return compiledCommand([resolve('scripts/security-admin.mjs'),command,...(input?[inputFile]:[])],{...process.env,DATABASE_PATH:f.database});
    };
    const initial=await run('status');assert.equal(initial.status,0,initial.stderr);const revision=JSON.parse(initial.stdout).policyRevision;assert.equal(revision,policy.revision());
    writeFileSync(candidateFile,JSON.stringify({id:'ServiceRequest',name:'Reviewed synthetic candidate'}),{mode:0o600});
    const request={installationId:a.id,resource:{kind:'objectType',id:'ServiceRequest',version:policyModel.object('ServiceRequest').version},operation:'edit',candidateFile};
    const denied=await run('review-definition',{...request,expectedRevision:revision});assert.notEqual(denied.status,0);assert.match(denied.stderr,/AUTHORIZATION_REQUIRED/);
    const role={subjectKind:'installation',subjectId:a.id,resource:{kind:'namespace',id:policyModel.ref.id,version:policyModel.ref.digest},role:'Editor',expiresAt:new Date(Date.now()+3600000).toISOString()};
    const granted=await run('grant-role',{...role,expectedRevision:revision});assert.equal(granted.status,0,granted.stderr);const receipt=JSON.parse(granted.stdout);assert.ok(receipt.roleId);assert.equal(receipt.policyRevision,revision+1);
    assert.notEqual((await run('grant-role',{...role,expectedRevision:revision})).status,0);assert.equal(policy.revision(),revision+1);
    const reviewed=await run('review-definition',{...request,expectedRevision:policy.revision()});assert.equal(reviewed.status,0,reviewed.stderr);const result=JSON.parse(reviewed.stdout);assert.equal(result.allowed,true);assert.equal(result.published,false);assert.match(result.candidateDigest,/^[a-f0-9]{64}$/);assert.equal(policy.revision(),revision+1);
    assert.notEqual(policyModel.object('ServiceRequest').name,'Reviewed synthetic candidate');
    assert.equal((await run('revoke-role',{id:receipt.roleId,expectedRevision:policy.revision()})).status,0);
    assert.notEqual((await run('review-definition',{...request,expectedRevision:policy.revision()})).status,0);
  }finally{f.close();}
});

test('E2E: a separate compiled Worker claims native source authority and the parent independently reads a protected result',async()=>{
  const source=participantFixture(),f=securedProgramFixture(()=>new ParticipantBookingProgram(source.source),source.input,()=>{throw Error('Parent process must not execute the task');},undefined,{nativeTaskContext:true});
  try {
    const job=f.tasks.submit(f.p,{service:'eigos.delegate',requestId:randomUUID(),goal:'Synthetic existing registration read in a separate Worker',executionEnvironment:'sandbox'}),configFile=resolve(f.directory,'child.json'),resultFile=resolve(f.directory,'result.json');
    writeFileSync(configFile,JSON.stringify({database:f.database,owner:f.owner,taskId:job.id,resultFile}),{mode:0o600});
    try {await promisify(execFile)(process.execPath,[resolve('dist/tests/fixtures/security-native-worker.js'),configFile],{timeout:90000});}
    catch(error){const progress=resultFile+'.progress.json';throw new Error(`Compiled protected Worker failed: ${existsSync(progress)?readFileSync(progress,'utf8'):'no task progress recorded'}`,{cause:error});}
    assert.deepEqual(JSON.parse(readFileSync(resultFile,'utf8')),{state:'completed',reads:1,submits:0});
    const view=f.tasks.get(f.p,job.id);assert.ok('view' in view);assert.equal(view.view,'eigos.task.v2');assert.ok('accepted' in view);assert.equal(view.accepted,true);assert.ok(JSON.stringify(view).includes('synthetic-registration'));assert.ok(!JSON.stringify(view).includes(source.source.attendeeRef));
    f.coordinator.revokeInstallation(f.member.id,f.a.id);assert.throws(()=>f.tasks.get(f.p,job.id),/ACCESS_REVOKED/);
  }finally{f.close();source.store.close();}
});
