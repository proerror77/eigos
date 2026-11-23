import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Worker } from '../apps/worker/worker.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { didiPAReadCapability, didiPAReadTool, withDidiPAReads } from '../packages/capabilities/didi/pa-read.js';
import { didiPAAccountResources } from '../packages/ontology/didi-pa-access.js';
import { businessGrants, setGrants, syncAccountGrants } from '../packages/runtime/access.js';
import { accountActionsGroup } from '../packages/runtime/accounts.js';
import { OntologyAgent } from '../packages/runtime/agent.js';
import { PARequests } from '../packages/runtime/pa.js';
import { accountGateway } from './account-harness.js';
import { fixture, route } from './fixture.js';

test('the original invited PA directly reads DiDi and completes the same Action task', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'invite' });
  const client = new Client({ name: 'invited-pa', version: '1' });
  const source = withDidiPAReads(async () => { throw new Error('EIGOS has no individual provider binding'); });
  const worker = new Worker(f.tasks, new OntologyAgent(f.db, f.metadata, f.tasks, createCapabilities(f.db, source, {}), {
    model: 'selected-action',
    async run() { throw new Error('The selected Action should not need model selection'); },
  }));
  async function call(name: string, args = {}) {
    const value = await client.callTool({ name, arguments: args });
    assert(!value.isError, JSON.stringify(value.content));
    return JSON.parse((value.content[0] as { text: string }).text);
  }
  try {
    f.provider.flags.related = false;
    await syncAccountGrants(f.db, f.model);
    await setGrants(f.db, 'group:' + accountActionsGroup, businessGrants(f.model).filter(grant => didiPAAccountResources.has(grant.resource)));
    await syncAccountGrants(f.db, f.model);
    const email = 'pa-ride@example.test', owner = g.owner('pa-ride');
    const { cookie } = await g.login('pa-ride', email);
    await g.form('apply', cookie, new URLSearchParams({ email, purpose: 'Direct DiDi PA read pilot' }));
    assert.equal((await g.form('activate', cookie, new URLSearchParams({ code: await g.accounts.invite(email, 1) }))).headers.get('location'), '/account');
    await g.form('approve', cookie);
    const token = await g.token('pa-ride', { issuedAt: Math.ceil(Date.now() / 1000) });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', g.url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const catalogue = await call('describe_ontology');
    assert(!catalogue.actionTypes.some((x: { apiName: string }) => x.apiName === 'BookDidiImmediateRide'));
    const args = { requestId: randomUUID(),
      action: { interface: { type: 'RideInquiry', action: 'estimate', implementation: 'RideRequest' }, input: route },
      read: { function: 'readRideEstimates', resultParameter: 'request' },
    };
    const submitted = await call('complete_with_action', args);
    assert.equal(submitted.state, 'submitted');
    assert.equal((await call('complete_with_action', args)).id, submitted.id);
    const pendingRequests = new Set<string>();
    for (let index = 0; index < 3; index++) {
      assert(await worker.runOne('interactive'));
      const task = await call('get_task', { taskId: submitted.id });
      assert.equal(task.id, submitted.id);
      assert.equal(task.state, 'input-required', JSON.stringify(task));
      assert.equal(task.result.capability, didiPAReadCapability);
      assert.equal(task.result.taskId, submitted.id);
      const requestId = task.result.requestId, input = task.result.input;
      assert(!pendingRequests.has(requestId));
      pendingRequests.add(requestId);
      assert.equal(f.provider.calls.length, index, 'only the original PA called the provider');
      const method = didiPAReadTool.parse(input.tool);
      assert.equal(method, index < 2 ? 'maps_textsearch' : 'taxi_estimate');
      const { data, receipt } = await f.provider.source.connector.invoke(
        { requestId, requestRevision: 1 }, method, input.arguments, AbortSignal.timeout(5_000),
      );
      const { bindingId: _bindingId, environment: _environment, ...proof } = receipt;
      const response = { status: 'observed', data, receipt: proof };
      const handoff = { taskId: submitted.id, requestId, response };
      if (index === 0) {
        await assert.rejects(new PARequests(f.tasks).respond({
          owner, clientId: 'another-pa-client', memberAccess: true, scopes: ['tasks:read', 'tasks:write'],
        }, submitted.id, { requestId, response }), /belongs to the original client/);
        const mismatched = await client.callTool({ name: 'respond_to_task', arguments: {
          ...handoff, response: { ...response, receipt: { ...proof, inputDigest: '0'.repeat(64) } },
        } });
        assert(mismatched.isError);
      }
      await call('respond_to_task', handoff);
      await call('respond_to_task', handoff);
    }
    assert(await worker.runOne('interactive'));
    const complete = await call('get_task', { taskId: submitted.id });
    assert.equal(complete.id, submitted.id);
    assert.equal(complete.state, 'completed', JSON.stringify(complete));
    assert.deepEqual(complete.result.evidence, ['pa_reported']);
    assert.equal(complete.result.accepted, false);
    assert.equal(complete.result.estimates.length, 2);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal((await f.db.query('SELECT 1 FROM ' + f.schema + '.external_operations')).rowCount, 0);
    assert.equal((await f.db.query('SELECT 1 FROM ' + f.schema + '.pa_requests WHERE response IS NOT NULL')).rowCount, 3);
  } finally {
    await client.close();
    await g.close();
    await f.close();
  }
});
