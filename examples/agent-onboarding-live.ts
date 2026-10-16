// Explicit live acceptance. Real Auth0 device/refresh grants, isolated membership
// and task databases, actual caller/Worker models. Never invoked by npm test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { decodeJwt } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AgentConnector } from '../packages/agent-client/client.js';
import { MemberStore } from '../packages/members/store.js';
import { enrollmentClaim } from '../apps/gateway/members/agent-routes.js';
import { verifyAgentTask } from './lib/verify-agent-task.js';

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Configure ${name} privately`); return value; }
const base = required('PUBLIC_URL'), database = required('DATABASE_PATH'), membershipDatabase = required('MEMBERSHIP_DATABASE_PATH');
const credentialPath = resolve(required('EIGOS_AGENT_CREDENTIAL_PATH')), handoff = resolve(required('EIGOS_ONBOARDING_HANDOFF_PATH'));
const evidence = resolve(required('EIGOS_ONBOARDING_EVIDENCE_DIR'), new Date().toISOString().replaceAll(':', '-'));
mkdirSync(evidence, { recursive: true, mode: 0o700 }); mkdirSync(dirname(handoff), { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const update = (stage: string, value: object = {}) => writeFileSync(handoff, JSON.stringify({ stage, evidenceDirectory: evidence, ...value }, null, 2) + '\n', { mode: 0o600 });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const state = JSON.parse(readFileSync(required('EIGOS_AUTH0_STATE_PATH'), 'utf8'));
assert.equal(state.resource, base); assert(state.configurationComplete && state.connectorId);
const provider = (method: string, path: string, body?: object) => {
  const result = execFileSync('auth0', ['api', method, path, '--tenant', state.tenant, '--json', '--no-input', ...(body ? ['--data', '@-'] : [])], {
    input: body ? JSON.stringify(body) : undefined, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
  });
  return result.length ? JSON.parse(result.toString()) : undefined;
};
const apiPath = `resource-servers/${encodeURIComponent(state.apiId)}`;
const original = provider('get', apiPath);
assert.equal(original.identifier, base); assert.equal(original.token_dialect, 'rfc9068_profile');
const metadata = await (await fetch(base + '/.well-known/eigos-agent-registration')).json();
assert.equal(metadata.admission_policy, 'invite-only'); assert.equal(metadata.client_id, state.connectorId);
const members = new MemberStore(membershipDatabase); assert.equal(members.list().length, 0, 'Use fresh isolated acceptance databases'); members.close();
let changedLifetime = false, restored = false, mcp: Client | undefined;
const restore = () => {
  if (!changedLifetime || restored) return;
  provider('patch', apiPath, { token_lifetime: original.token_lifetime, token_lifetime_for_web: original.token_lifetime_for_web });
  const actual = provider('get', apiPath); assert.equal(actual.token_lifetime, original.token_lifetime); assert.equal(actual.token_lifetime_for_web, original.token_lifetime_for_web);
  restored = true; save('provider-restoration.json', { restoredAt: new Date().toISOString(), tokenLifetimeSeconds: actual.token_lifetime, webTokenLifetimeSeconds: actual.token_lifetime_for_web });
};
try {
  // A temporary 60-second limit proves actual expiry, rather than only forcing a
  // refresh against a still-valid token. Restore before waiting for that expiry.
  save('provider-restore-required.json', { tenant: state.tenant, apiId: state.apiId, tokenLifetime: original.token_lifetime, webTokenLifetime: original.token_lifetime_for_web });
  changedLifetime = true; provider('patch', apiPath, { token_lifetime: 60, token_lifetime_for_web: 60 });
  const agent = await AgentConnector.open({ baseUrl: base, credentialPath, displayName: 'EIGOS self-enrolled acceptance Agent' });
  assert.equal((await agent.status()).status, 'authorization_required');
  for (const path of ['/mcp', '/a2a']) assert.equal((await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const authorization = await agent.beginAuthorization();
  update('awaiting_device_authorization', { authorizationUrl: authorization.verificationUri, userCode: authorization.userCode, registrationId: agent.registrationId });
  console.log('Agent registered itself. Waiting for real Auth0 device authorization:', handoff);
  assert.equal((await agent.finishAuthorization()).status, 'registration_required');
  const initialCredentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
  const initialToken = initialCredentials.accessToken as string, firstClaims = decodeJwt(initialToken);
  assert.equal(firstClaims[enrollmentClaim(base)], true); assert.equal(firstClaims.exp! - firstClaims.iat!, 60);
  assert.equal((await agent.registerMembership({ displayName: 'EIGOS Agent acceptance member', locale: 'zh-CN', timezone: 'Asia/Shanghai' }, true)).status, 'waiting_invitation');
  for (const path of ['/mcp', '/a2a']) assert.equal((await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${initialToken}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const store = new MemberStore(membershipDatabase);
  const member = store.list()[0]!; assert.equal(member.status, 'pending'); store.close();
  const invitationFile = join(evidence, 'private-invitation.json');
  execFileSync(process.execPath, ['scripts/members.mjs', 'invite', member.id, '--output', invitationFile], { env: { ...process.env, MEMBERSHIP_DATABASE_PATH: membershipDatabase }, stdio: ['ignore', 'pipe', 'pipe'] });
  const invitation = JSON.parse(readFileSync(invitationFile, 'utf8'));
  assert.equal((await agent.redeemInvitation(invitation.token)).status, 'active');
  await assert.rejects(agent.redeemInvitation(invitation.token));
  mcp = new Client({ name: 'self-registering-acceptance-agent', version: '1' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { fetch: (input, init) => agent.fetch(input instanceof Request ? input.url : input.toString(), init) }));
  const services = await mcp.callTool({ name: 'list_services', arguments: {} }); assert(!services.isError);
  const list = await agent.fetch('/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'before-refresh', method: 'ListTasks', params: {} }) });
  assert(list.ok); assert((await list.json()).result);
  restore();
  update('waiting_for_real_token_expiry', { registrationId: agent.registrationId, expiresAt: firstClaims.exp! * 1000 });
  console.log('Invitation redeemed; MCP/A2A accepted the first token. Waiting for actual token expiry.');
  while (Date.now() < firstClaims.exp! * 1000 + 6000) await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  for (const path of ['/mcp', '/a2a']) assert.equal((await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${initialToken}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const beforeRefresh = agent.refreshCount;
  const tokens = await Promise.all(Array.from({ length: 6 }, () => agent.accessToken()));
  assert(tokens.every(token => token === tokens[0])); assert.equal(agent.refreshCount, beforeRefresh + 1);
  const refreshedToken = tokens[0]!, after = JSON.parse(readFileSync(credentialPath, 'utf8'));
  assert.notEqual(after.refreshToken, initialCredentials.refreshToken); assert.notEqual(refreshedToken, initialToken);
  assert.equal(decodeJwt(refreshedToken)[enrollmentClaim(base)], false); assert.equal(decodeJwt(refreshedToken).exp! - decodeJwt(refreshedToken).iat!, 900);
  const reopened = await AgentConnector.open({ baseUrl: base, credentialPath, displayName: 'ignored on resume' });
  assert.equal(reopened.registrationId, agent.registrationId); assert.equal(await reopened.accessToken(), refreshedToken);
  assert(!(await mcp.callTool({ name: 'list_services', arguments: {} })).isError);
  const afterList = await reopened.fetch('/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'after-refresh', method: 'ListTasks', params: {} }) }); assert(afterList.ok); assert((await afterList.json()).result);
  await mcp.close(); mcp = undefined;
  save('onboarding-verification.json', { completedAt: new Date().toISOString(), registrationId: agent.registrationId, memberHash: hash(member.id),
    states: ['authorization_required', 'registration_required', 'waiting_invitation', 'active'], auth0DeviceGrant: true, freshEnrollmentClaim: true,
    noTokenStatuses: [401, 401], waitingInvitationStatuses: [403, 403], invitationReplayRejected: true, actualExpiredTokenStatuses: [401, 401],
    initialAccessLifetimeSeconds: 60, restoredAccessLifetimeSeconds: 900, automaticRefreshes: agent.refreshCount - beforeRefresh,
    refreshTokenRotated: true, concurrentRefreshShared: true, resumedSameRegistration: true, mcpAfterRefresh: true, a2aAfterRefresh: true, refreshCannotEnrollNewAgent: decodeJwt(refreshedToken)[enrollmentClaim(base)] === false });
  update('running_real_agent', { registrationId: agent.registrationId });
  const execution = await verifyAgentTask({ base, issuer: required('OAUTH_ISSUER'), audience: required('OAUTH_AUDIENCE'), clientId: state.connectorId,
    tenantClaim: required('OAUTH_TENANT_CLAIM'), token: refreshedToken, database, membershipDatabase, jwksUrl: required('OAUTH_JWKS_URL'), evidenceDirectory: join(evidence, 'execution'), authorization: 'real Auth0 device authorization + automatic rotating refresh after actual expiry' });
  assert.equal((await reopened.revoke()).status, 'agent_registration_revoked');
  for (const path of ['/mcp', '/a2a']) assert.equal((await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${refreshedToken}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  await assert.rejects(reopened.accessToken({ forceRefresh: true }), /revoked/);
  save('revocation-verification.json', { checkedAt: new Date().toISOString(), registrationId: agent.registrationId, liveTokenRejectedByMcp: true, liveTokenRejectedByA2a: true, renewalDoesNotRestoreRevokedAgent: true });
  update('completed', { registrationId: agent.registrationId, taskId: execution.taskId });
  console.log('Real self-registration → invitation → automatic refresh → MCP/A2A → two Agent runtimes → readback and revocation verified:', execution.taskId);
} catch (error) {
  update('not_completed'); save('failure.json', { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'Verification failed' });
  console.error('Live onboarding verification stopped. Inspect private evidence and original tasks before retrying.'); process.exitCode = 1;
} finally {
  await mcp?.close(); restore();
}
