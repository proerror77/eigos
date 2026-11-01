import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AgentCard, SendMessageRequest } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import { createMcpServer } from '../apps/gateway/mcp.js';
import { A2AGateway, AgentUser } from '../apps/gateway/a2a.js';
import { TaskService } from '../packages/core/tasks.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { SecurityError } from '../packages/security/store.js';
import { securityErrorResponse } from '../packages/security/error-guidance.js';
import { securityFixture } from './fixtures/security.js';

test('MCP and A2A explain rejected personal context with the current origin and retain rollback/least privilege', { timeout: 60000 }, async () => {
  const f = securityFixture(), installation = f.installation('Public place query'), policy = f.jobs.security.policies;
  f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'],
    resources: [{ type: 'ServiceRequest', fields: ['requestId', 'displayTitle', 'originalGoal', 'revision', 'conditions', 'progress', 'createdAt'] }],
    sourceBindingIds: [], channels: ['agent_response', 'registered_model'], expiresAt: new Date(Date.now() + 3600000).toISOString() });
  policy.setRole({ subjectKind: 'installation', subjectId: installation.id, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer', expiresAt: new Date(Date.now() + 3600000).toISOString() }, policy.revision());
  policy.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data', 'health'], channels: ['agent_response', 'registered_model'], expiresAt: new Date(Date.now() + 3600000).toISOString() }, policy.revision());
  const principal = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) };
  const tasks = new TaskService(f.jobs, { catalog: new ExecutionCatalog([], [], []) }), instance = 'https://current.example';
  const server = createMcpServer(tasks, principal, undefined, undefined, undefined, { runtime: { instance, backend: 'ontology', ontologyTransport: 'native-mcp' } });
  const client = new Client({ name: 'safe-error-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    const before = structuredClone(f.jobs.security.listGrants(f.owner)), requestId = randomUUID();
    const input = { service: 'eigos.delegate', goal: 'PRIVATE_USER_TEXT public-place query', requestId, personalContext: { self: true } };
    const response = await client.callTool({ name: 'submit_task', arguments: input }); assert.equal(response.isError, true);
    const text = response.content[0]; assert(text?.type === 'text');
    const body = JSON.parse(text.text); assert.equal(body.code, 'INSUFFICIENT_ACCESS');
    assert.equal(body.authorization.stage, 'personal_context');
    assert.equal(body.authorization.nextAction, 'review_request_context');
    assert.equal(body.authorization.reviewUrl, instance + '/members/permissions');
    assert.equal(body.authorization.grantsAuthority, false);
    assert.deepEqual(response.structuredContent, { error: body });
    assert(!JSON.stringify(body).includes('PRIVATE_USER_TEXT'));
    const gateway = new A2AGateway(tasks, AgentCard.fromJSON({ supportedInterfaces: [{ url: instance + '/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }));
    await assert.rejects(gateway.sendMessage(SendMessageRequest.fromJSON({
      message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: input }] }, configuration: { returnImmediately: true },
    }), new ServerCallContext({ user: new AgentUser(principal) })), error => {
      assert(error instanceof RequestMalformedError);
      assert.equal(error.metadata?.eigosCode, body.code);
      assert.deepEqual(JSON.parse(error.metadata!.eigosAuthorization!), body.authorization);
      assert(!error.message.includes('PRIVATE_USER_TEXT')); return true;
    });
    assert.equal(tasks.list(principal, { limit: 10, offset: 0 }).total, 0, 'Rejected context cannot leave a task behind');
    assert.deepEqual(f.jobs.security.listGrants(f.owner), before, 'Error guidance cannot grant access');
    const corrected = await client.callTool({ name: 'submit_task', arguments: { service: input.service, goal: input.goal, requestId } });
    assert(!corrected.isError, JSON.stringify(corrected));
    assert.equal(tasks.list(principal, { limit: 10, offset: 0 }).total, 1);
    assert.deepEqual(f.jobs.security.agentGrant(installation.id), before.find(grant => grant.kind === 'agent_access'));
  } finally { await client.close(); await server.close(); f.close(); }
});

test('authorization advice never infers a task-creation grant or leaks raw private denial details', () => {
  for (const code of ['AUTHORIZATION_REQUIRED', 'ACCESS_REVOKED', 'AUTHORITY_UNAVAILABLE', 'REVOCATION_PENDING', 'POLICY_CHANGED', 'SOURCE_NOT_AUTHORIZED', 'OUTPUT_NOT_ALLOWED', 'INSUFFICIENT_ACCESS'] as const) {
    const result = securityErrorResponse(new SecurityError(code, 'PRIVATE_POLICY_OBJECT_AND_FIELDS'), 'https://current.example');
    assert.equal(result.code, code); assert.equal(result.authorization.grantsAuthority, false);
    assert.equal(result.authorization.preserveOriginalTask, true);
    assert.equal(new URL(result.authorization.reviewUrl!).origin, 'https://current.example');
    assert(!JSON.stringify(result).includes('PRIVATE_POLICY_OBJECT_AND_FIELDS'));
  }
  assert.equal(securityErrorResponse(new SecurityError('INSUFFICIENT_ACCESS')).authorization.stage, 'access');
  assert.equal(securityErrorResponse(new SecurityError('POLICY_CHANGED')).authorization.nextAction, 'reread_current_context');
});

test('Python PA accepts SDK error advice but rejects credential-bearing URLs and authority claims', () => {
  const response=securityErrorResponse(new SecurityError('INSUFFICIENT_ACCESS','PRIVATE_POLICY','personal_context'),'https://current.example');
  const info=new RequestMalformedError({message:'PRIVATE_UPSTREAM_ERROR',metadata:{eigosCode:response.code,eigosAuthorization:JSON.stringify({...response.authorization,privateExtra:'PRIVATE_TOKEN'})}}).toErrorInfo();
  const stdout=execFileSync('python3',['-c',`
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('pa',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
info=json.load(sys.stdin);error={'code':-32602,'message':'PRIVATE_UPSTREAM_ERROR','data':[info]};base='https://current.example/.well-known/agent-card.json'
good=m.authorization_advice(error,base);bad=[]
for update in [{'reviewUrl':'https://external.example/members/permissions'},{'reviewUrl':'https://current.example/members/permissions?token=PRIVATE_TOKEN'},{'grantsAuthority':True},{'nextAction':'PRIVATE_TOKEN'}]:
 copy=json.loads(json.dumps(error));advice=json.loads(copy['data'][0]['metadata']['eigosAuthorization']);advice.update(update);copy['data'][0]['metadata']['eigosAuthorization']=json.dumps(advice);bad.append(m.authorization_advice(copy,base))
print(json.dumps({'good':good,'bad':bad}))
`,resolve('integrations/grok/eigos-delegate/scripts/eigos_a2a.py')],{input:JSON.stringify(info),encoding:'utf8'});
  const result=JSON.parse(stdout),{message:_,...safe}=response.authorization;
  assert.deepEqual(result.good,{code:response.code,authorization:safe});
  assert.deepEqual(result.bad,[null,null,null,null]);assert(!stdout.includes('PRIVATE_'));
});
