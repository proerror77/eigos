import {securityGatewayFixture} from './fixtures/security-gateway.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ownerKey } from '../packages/core/domain.js';

const fixture=securityGatewayFixture;

test('foundation HTTP keeps same-client installations distinct and requires versioned data paths', async () => {
  const f = await fixture();
  try {
    const a = f.install(), b = f.install();
    assert.equal((await f.post('/security/context', {})).status, 401);
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${a.token}` })).value.error, 'AUTHORIZATION_REQUIRED');
    const approved = await f.post('/members/security/grants', f.control(f.grantInput(a.id)), f.memberHeaders);
    assert.equal(approved.status, 200); assert.equal(approved.value.grants.length, 1); assert.equal(approved.value.businessAccess, 'task_grant_required');
    const context = await f.post('/security/context', {}, { authorization: `Bearer ${a.token}` });
    assert.equal(context.status, 200); assert.equal(context.value.installationId, a.id);
    assert(!JSON.stringify(context.value).includes(f.p.issuer)); assert(!JSON.stringify(approved.value).includes('ownerKey'));
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${b.token}`, 'x-eigos-installation-id': a.id })).status, 403);
    assert.equal((await f.post('/security/context', { installationId: a.id }, { authorization: `Bearer ${a.token}` })).status, 400);
    const foreign = 'synthetic-other-client'; f.tokens.set(foreign, { ...f.p, clientId: 'unregistered-client' });
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${foreign}` })).status, 403);
    const headers={authorization:`Bearer ${a.token}`};
    assert.equal((await f.post('/ontology/query',{type:'ServiceRequest'},headers)).status,400);
    assert.equal((await f.post('/ontology/evaluate',{},headers)).status,400);
    assert.deepEqual((await f.post('/ontology/describe',{},headers)).value.types,[]);
    assert.equal((await f.post(`/tasks/${randomUUID()}/authorize`,{},headers)).status,403);
    assert.equal((await f.post('/tasks',{service:'eigos.delegate',requestId:'no-viewer',goal:'Synthetic task'},headers)).status,403);
    assert.equal(f.gateway.store.list(ownerKey(f.p), { limit: 10, offset: 0 }).total, 0);
    const card = await fetch(f.base + '/.well-known/agent-card.json').then(r => r.json()); assert.deepEqual(card.skills.map((s:{id:string})=>s.id),['eigos.delegate']);
    const health = await fetch(f.base + '/health').then(r => r.json()); assert.equal(health.securityStage, 'S5_foundation_v2');
  } finally { await f.close(); }
});

test('S1 grant control requires the owning browser session, Origin and CSRF; bearer enrollment cannot self-grant', async () => {
  const f = await fixture();
  try {
    const a = f.install(), input = f.grantInput(a.id);
    assert.equal((await f.post('/members/security/grants', f.control(input), { authorization: `Bearer ${a.token}`, origin: f.base })).status, 401);
    assert.equal((await f.post('/members/security/grants', input, f.memberHeaders)).status, 403);
    assert.equal((await f.post('/members/security/grants', f.control(input), { cookie: f.cookie, origin: 'https://foreign.example' })).status, 403);
    assert.equal((await f.post('/members/security/grants', f.control({ ...input, approvedByMemberId: f.member.id }), f.memberHeaders)).status, 400);
    assert.equal((await f.post('/members/security/grants', f.control({ ...input, resources: [{ type: 'SavedAddress', fields: ['contactInstructions'] }] }), f.memberHeaders)).status, 403);
    const bob = f.gateway.members.login({ ...f.p, subject: 'bob' });
    f.gateway.members.apply(bob.id, { displayName: 'Synthetic Bob', locale: 'zh-CN', timezone: 'Asia/Shanghai', consent: true }, false);
    const session = f.gateway.members.createSession(bob.id);
    assert.equal((await f.post('/members/security/grants', { ...input, _csrf: session.csrf }, { cookie: `eigos-member=${session.token}`, origin: f.base })).status, 403);
    assert.equal(f.gateway.security!.grants(f.member.id).length, 0);
  } finally { await f.close(); }
});

test('S1 member grant revoke and Agent self-revoke both commit the business deny fence before returning', async () => {
  const f = await fixture();
  try {
    const a = f.install(), b = f.install();
    const approved = await f.post('/members/security/grants', f.control(f.grantInput(a.id)), f.memberHeaders);
    const grant = approved.value.grants[0];
    assert.equal((await f.post(`/members/security/grants/${grant.id}/revoke`, f.control({ expectedRevision: grant.revision }), f.memberHeaders)).status, 200);
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${a.token}` })).status, 403);
    await f.post('/members/security/grants', f.control(f.grantInput(b.id)), f.memberHeaders);
    const revoked = await f.post(`/agents/registrations/${b.id}/revoke`, {}, { authorization: `Bearer ${b.token}`, 'x-eigos-registration-token': b.credential });
    assert.equal(revoked.status, 200); assert.equal(revoked.value.status, 'agent_registration_revoked');
    assert(f.gateway.store.security.hasFence({ ownerKey: ownerKey(f.p), kind: 'installation', targetId: b.id }));
    assert.equal(f.gateway.store.security.pendingFences().length, 0);
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${b.token}` })).status, 403);
    const raw = f.gateway.security!.grants(f.member.id); assert(raw.every(g => g.status === 'revoked'));
  } finally { await f.close(); }
});
