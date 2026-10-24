import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { securityFixture } from '../fixtures/security.js';
import { businessModel } from '../../packages/ontology/business-model.js';

test('E2E: the existing compiled members CLI enforces the same persistent Worker revocation fence', () => {
  const f = securityFixture();
  try {
    const a = f.installation('Compiled CLI test'); f.approve(a.id); const task = f.task(a.id);
    const claim = f.jobs.claim(['eigos.delegate'], 10000)!; assert(claim);
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: f.database, MEMBERSHIP_DATABASE_PATH: f.membership };
    delete env.EIGOS_SECURITY_MODE;
    const run = spawnSync(process.execPath, [resolve('scripts/members.mjs'), 'suspend', f.member.id], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).status, 'suspended');
    assert.equal(f.jobs.renew(claim, 10000), false); assert.equal(f.jobs.security.workAuthority(f.owner, task.job.id), undefined);
    assert.equal(f.jobs.security.pendingFences().length, 0);
    const restore = spawnSync(process.execPath, [resolve('scripts/members.mjs'), 'approve', f.member.id], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(restore.status, 0, restore.stderr);
    assert.throws(() => f.coordinator.authenticate(f.principal, a.token), /AUTHORIZATION_REQUIRED/);
    assert.equal(f.jobs.security.workAuthority(f.owner, task.job.id), undefined);
  } finally { f.close(); }
});

test('E2E: compiled local policy administration uses revision checks and definition review does not publish',()=>{
  const f=securityFixture();try {
    const a=f.installation('Policy CLI');f.approve(a.id);const policy=f.jobs.security.policies;
    const inputFile=resolve(f.directory,'reviewed-input.json'),candidateFile=resolve(f.directory,'candidate.json');
    const run=(command:string,input?:object)=>{
      if(input)writeFileSync(inputFile,JSON.stringify(input),{mode:0o600});
      return spawnSync(process.execPath,[resolve('scripts/security-admin.mjs'),command,...(input?[inputFile]:[])],{env:{...process.env,DATABASE_PATH:f.database},encoding:'utf8',timeout:10000});
    };
    const initial=run('status');assert.equal(initial.status,0,initial.stderr);const revision=JSON.parse(initial.stdout).policyRevision;assert.equal(revision,policy.revision());
    writeFileSync(candidateFile,JSON.stringify({id:'ServiceRequest',name:'Reviewed synthetic candidate'}),{mode:0o600});
    const request={installationId:a.id,resource:{kind:'objectType',id:'ServiceRequest',version:businessModel.object('ServiceRequest').version},operation:'edit',candidateFile};
    const denied=run('review-definition',{...request,expectedRevision:revision});assert.notEqual(denied.status,0);assert.match(denied.stderr,/AUTHORIZATION_REQUIRED/);
    const role={subjectKind:'installation',subjectId:a.id,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Editor',expiresAt:new Date(Date.now()+3600000).toISOString()};
    const granted=run('grant-role',{...role,expectedRevision:revision});assert.equal(granted.status,0,granted.stderr);const receipt=JSON.parse(granted.stdout);assert.ok(receipt.roleId);assert.equal(receipt.policyRevision,revision+1);
    assert.notEqual(run('grant-role',{...role,expectedRevision:revision}).status,0);assert.equal(policy.revision(),revision+1);
    const reviewed=run('review-definition',{...request,expectedRevision:policy.revision()});assert.equal(reviewed.status,0,reviewed.stderr);const result=JSON.parse(reviewed.stdout);assert.equal(result.allowed,true);assert.equal(result.published,false);assert.match(result.candidateDigest,/^[a-f0-9]{64}$/);assert.equal(policy.revision(),revision+1);
    assert.notEqual(businessModel.object('ServiceRequest').name,'Reviewed synthetic candidate');
    assert.equal(run('revoke-role',{id:receipt.roleId,expectedRevision:policy.revision()}).status,0);
    assert.notEqual(run('review-definition',{...request,expectedRevision:policy.revision()}).status,0);
  }finally{f.close();}
});
