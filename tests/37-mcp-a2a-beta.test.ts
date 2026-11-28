import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest } from '../packages/core/identity.js';
import { businessGrants, setGrants, syncAccountGrants } from '../packages/runtime/access.js';
import { accountGateway, type AccountGateway } from './account-harness.js';
import { fakeAmap, testConnection, type Recorded } from './amap-fixture.js';
import { fixture } from './fixture.js';

const parseToolJson = (result: { content?: unknown }) =>
  JSON.parse((result.content as { text: string }[])[0]!.text);

test('Beta MCP consumer tools, A2A AgentCard/PRM, cross-protocol cancel, and /mcp/builder isolation', async () => {
  const departureDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const flightInput = { origin: 'SHA', destination: 'PEK', departureDate, limit: 1 };
  const sourceReaders: string[] = [];
  const amapCalls: Recorded[] = [];
  const folder = await mkdtemp(join(tmpdir(), 'eigos-beta-mcp-a2a-'));
  let g: AccountGateway | undefined;

  const f = await fixture({
    model: 'synthetic-beta-mcp-a2a',
    async run(_prompt, tools) {
      await tools.get('complete_with_function')!.invoke({ function: 'readFliggyFlights', input: flightInput });
    },
  }, async (actor, provider) => {
    assert.equal(provider, 'Fliggy');
    return {
      provider,
      bindingId: 'synthetic-fliggy-beta',
      async assertCurrent() {},
      async read(input) {
        sourceReaders.push(actor);
        const items = [{
          nativeId: 'synthetic-flight-beta',
          name: 'CA1502',
          url: 'https://example.test/synthetic-flight-beta',
          priceDisplay: '620 CNY',
          adultFareDisplay: null,
          journeys: [{
            kind: 'outbound',
            segments: [{
              flightNumber: 'CA1502',
              departureAirport: String(input.origin ?? 'SHA'),
              departureLocal: departureDate + ' 09:00',
              arrivalAirport: String(input.destination ?? 'PEK'),
              arrivalLocal: departureDate + ' 11:15',
            }],
          }],
        }];
        return {
          provider: 'Fliggy',
          accessMode: 'trial',
          bindingId: 'synthetic-fliggy-beta',
          evidence: 'synthetic',
          items,
          complete: false,
          cursor: null,
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 180000).toISOString(),
          inputDigest: digest(input),
          contentDigest: digest({ items, complete: false, cursor: null }),
        };
      },
    };
  });

  const clients: Client[] = [];
  try {
    const connection = await testConnection(folder);
    const betaConnection = join(folder, 'beta-amap.json');
    const { owner: _owner, ...shared } = JSON.parse(await readFile(connection, 'utf8'));
    await writeFile(betaConnection, JSON.stringify(shared), { mode: 0o600 });

    const gateway = g = await accountGateway(f, {
      signup: 'invite',
      env: { EIGOS_BETA_AMAP_CONNECTION_FILE: betaConnection },
      amapFetch: fakeAmap(amapCalls),
    });

    const connect = async (path: string, accessToken: string) => {
      const client = new Client({ name: 'beta-pa-client', version: '1.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url + path), {
        requestInit: { headers: { Authorization: 'Bearer ' + accessToken } },
      }));
      return client;
    };
    const a2a = async (method: string, params: unknown, token: string) => {
      const response = await fetch(gateway.url + '/a2a', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: response.status, body: await response.json() };
    };

    await syncAccountGrants(f.db, f.model);

    // 1. A2A AgentCard exposes dynamic EIGOS skills + Bearer, OAuth2, and OpenID Connect security schemes.
    const cardResponse = await gateway.call('/.well-known/agent-card.json');
    assert.equal(cardResponse.status, 200);
    const card = await cardResponse.json();
    assert.equal(card.name, 'EIGOS');
    assert.equal(card.supportedInterfaces[0].url, `${gateway.config.PUBLIC_URL}/a2a`);
    const skillIds = new Set((card.skills as { id: string }[]).map(s => s.id));
    for (const expectedSkill of ['mapsAndWeather', 'dining', 'travelOffers', 'rideQuote', 'schedulePlanning']) {
      assert(skillIds.has(expectedSkill), `Expected AgentCard skill ${expectedSkill}, got ${[...skillIds].join(', ')}`);
    }
    assert.equal(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme, 'Bearer');
    assert.equal(
      card.securitySchemes.oauth2.oauth2SecurityScheme.flows.authorizationCode.authorizationUrl,
      `${gateway.config.OAUTH_ISSUER}authorize?audience=${encodeURIComponent(gateway.config.PUBLIC_URL + '/a2a')}`,
    );
    assert.equal(
      card.securitySchemes.oauth2.oauth2SecurityScheme.flows.authorizationCode.tokenUrl,
      `${gateway.config.OAUTH_ISSUER}oauth/token`,
    );
    assert.deepEqual(
      Object.keys(card.securitySchemes.oauth2.oauth2SecurityScheme.flows.authorizationCode.scopes).sort(),
      ['tasks:read', 'tasks:write'],
    );
    assert.equal(
      card.securitySchemes.openIdConnect.openIdConnectSecurityScheme.openIdConnectUrl,
      `${gateway.config.OAUTH_ISSUER}.well-known/openid-configuration`,
    );

    // 2. RFC 9728 Protected Resource Metadata for /a2a.
    const a2aPrmResponse = await gateway.call('/.well-known/oauth-protected-resource/a2a');
    assert.equal(a2aPrmResponse.status, 200);
    const a2aPrm = await a2aPrmResponse.json();
    assert.equal(a2aPrm.resource, `${gateway.config.PUBLIC_URL}/a2a`);
    assert.deepEqual(a2aPrm.authorization_servers, [gateway.config.OAUTH_ISSUER]);
    assert.deepEqual(a2aPrm.scopes_supported, ['tasks:read', 'tasks:write']);
    assert.deepEqual(a2aPrm.bearer_methods_supported, ['header']);

    // 3. Provision an invited Beta account and issue a persistent eigos_agent_* token.
    const beta = await gateway.login('beta-user', 'beta@example.test');
    assert.equal((await gateway.form('apply', beta.cookie, new URLSearchParams({ email: 'beta@example.test', purpose: 'Beta MCP/A2A' }))).status, 303);
    const inviteCode = await gateway.accounts.invite('beta@example.test', 24);
    assert.equal((await gateway.form('activate', beta.cookie, new URLSearchParams({ code: inviteCode }))).headers.get('location'), '/account');
    const tokenResponse = await gateway.form('agent-token', beta.cookie);
    assert.equal(tokenResponse.status, 200);
    const tokenHtml = await tokenResponse.text();
    const tokenMatch = tokenHtml.match(/Bearer (eigos_agent_[A-Za-z0-9_-]{43})/);
    assert(tokenMatch?.[1], 'Beta account must receive an eigos_agent_* token');
    const agentToken = tokenMatch[1];

    // 4. Verify /mcp tools/list for Beta account.
    const betaMcp = await connect('/mcp', agentToken);
    const listed = await betaMcp.listTools();
    const toolByName = new Map(listed.tools.map(tool => [tool.name, tool]));
    for (const requiredTool of [
      'cancel_task',
      'describe_ontology',
      'query_ontology',
      'execute_ontology',
      'submit_task',
      'get_task',
      'action_SearchFliggyFlights',
      'action_SearchFliggyHotels',
      'action_FindRestaurants',
      'function_readFliggyFlights',
      'function_readWeather',
      'function_searchMapPlaces',
    ]) {
      assert(toolByName.has(requiredTool), `Missing expected Beta MCP tool: ${requiredTool}`);
    }
    assert.equal(toolByName.get('function_searchMapPlaces')?.annotations?.readOnlyHint, true);
    assert.equal(toolByName.get('action_SearchFliggyFlights')?.annotations?.idempotentHint, true);
    assert.equal(toolByName.get('cancel_task')?.annotations?.destructiveHint, true);

    // Must NEVER expose modeling tools, editing functions, or unauthorized actions.
    for (const tool of listed.tools) {
      assert(!tool.name.startsWith('ontology_'), `Modeling service leaked to Beta MCP: ${tool.name}`);
    }
    for (const forbidden of [
      'action_EstimateRide',
      'action_BookDidiImmediateRide',
      'function_readDidiRideWatch',
      'function_searchFliggyFlights',
      'function_findRestaurants',
    ]) {
      assert(!toolByName.has(forbidden), `Unauthorized or editing tool leaked to Beta MCP: ${forbidden}`);
    }

    // 5. Invoke authorized read-only function_<apiName> directly via MCP (Amap place search).
    const mapRead = await betaMcp.callTool({
      name: 'function_searchMapPlaces',
      arguments: { input: { query: '咖啡店', city: '上海市' } },
    });
    assert(!mapRead.isError, JSON.stringify(mapRead));
    const mapData = parseToolJson(mapRead);
    assert.equal(mapData.provider, 'Amap');
    assert.equal(mapData.places[0].name, '咖啡店');
    assert.deepEqual(amapCalls.map(c => c.name), ['maps_text_search']);

    // 6. Invoke authorized action_<ApiName> via MCP -> governed task pipeline.
    const actionSubmit = await betaMcp.callTool({
      name: 'action_SearchFliggyFlights',
      arguments: { requestId: 'beta-action-flight-1', input: flightInput },
    });
    assert(!actionSubmit.isError, JSON.stringify(actionSubmit));
    const actionTask = parseToolJson(actionSubmit);
    assert.equal(actionTask.state, 'submitted');
    assert.equal(await f.worker.runOne(), true);
    const actionDone = parseToolJson(await betaMcp.callTool({ name: 'get_task', arguments: { taskId: actionTask.id } }));
    assert.equal(actionDone.state, 'completed', JSON.stringify(actionDone));
    assert.deepEqual(sourceReaders, [gateway.owner('beta-user')]);

    // 7. Cross-protocol A2A -> MCP: submit via A2A SendMessage, read via MCP get_task, cancel via MCP cancel_task.
    const a2aSend = await a2a('SendMessage', {
      message: { messageId: 'a2a-to-mcp-cancel', role: 'ROLE_USER', parts: [{ text: '查询明天上海到北京的航班' }] },
    }, agentToken);
    assert.equal(a2aSend.status, 200, JSON.stringify(a2aSend.body));
    const a2aTaskId = a2aSend.body.result.task.id as string;

    const mcpReadA2a = parseToolJson(await betaMcp.callTool({ name: 'get_task', arguments: { taskId: a2aTaskId } }));
    assert.equal(mcpReadA2a.id, a2aTaskId);
    assert.equal(mcpReadA2a.state, 'submitted');

    const mcpCancel = await betaMcp.callTool({ name: 'cancel_task', arguments: { taskId: a2aTaskId } });
    assert(!mcpCancel.isError, JSON.stringify(mcpCancel));
    assert.equal(parseToolJson(mcpCancel).state, 'canceled');

    const a2aAfterCancel = await a2a('GetTask', { id: a2aTaskId }, agentToken);
    assert.equal(a2aAfterCancel.status, 200);
    assert.equal(a2aAfterCancel.body.result.status.state, 'TASK_STATE_CANCELED');

    // 8. Cross-protocol MCP -> A2A: submit via MCP submit_task, read via A2A GetTask, cancel via A2A CancelTask.
    const mcpSubmit = await betaMcp.callTool({
      name: 'submit_task',
      arguments: { requestId: 'mcp-to-a2a-cancel', message: '查询明天北京天气' },
    });
    assert(!mcpSubmit.isError, JSON.stringify(mcpSubmit));
    const mcpTaskId = parseToolJson(mcpSubmit).id as string;

    const a2aReadMcp = await a2a('GetTask', { id: mcpTaskId }, agentToken);
    assert.equal(a2aReadMcp.status, 200);
    assert.equal(a2aReadMcp.body.result.id, mcpTaskId);

    const a2aCancel = await a2a('CancelTask', { id: mcpTaskId }, agentToken);
    assert.equal(a2aCancel.status, 200, JSON.stringify(a2aCancel.body));
    assert.equal(a2aCancel.body.result.status.state, 'TASK_STATE_CANCELED');

    const mcpAfterA2aCancel = parseToolJson(await betaMcp.callTool({ name: 'get_task', arguments: { taskId: mcpTaskId } }));
    assert.equal(mcpAfterA2aCancel.state, 'canceled');

    // 9. /mcp/builder rejects Beta eigos_agent_* and member OAuth tokens with 403, and allows first-party operators.
    const builderPost = (token: string) => fetch(gateway.url + '/mcp/builder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal((await builderPost(agentToken)).status, 403);
    const memberOauthToken = await gateway.token('beta-user', { issuedAt: Math.ceil(Date.now() / 1000) });
    assert.equal((await builderPost(memberOauthToken)).status, 403);

    const operatorOwner = gateway.owner('builder-operator');
    await setGrants(f.db, operatorOwner, [
      ...businessGrants(f.model),
      { resource: 'Eigos', permission: 'edit_definition' },
    ]);
    const operatorToken = await gateway.token('builder-operator', {
      azp: 'existing-client',
      aud: gateway.config.PUBLIC_URL,
      scope: 'ontology:read ontology:write tasks:read tasks:write',
    });
    const builderClient = await connect('/mcp/builder', operatorToken);
    const builderTools = (await builderClient.listTools()).tools.map(t => t.name);
    assert(builderTools.includes('describe_ontology'));
    assert(builderTools.includes('ontology_list_branches'));
    assert(builderTools.includes('ontology_machinery_processes'));
    assert(!builderTools.includes('submit_task'));
    assert(!builderTools.includes('apply_ontology_action'));
    assert(!builderTools.includes('cancel_task'));
    assert(!builderTools.some(name => name.startsWith('action_')));

    const described = await builderClient.callTool({ name: 'describe_ontology', arguments: {} });
    assert(!described.isError, JSON.stringify(described));
    assert.equal(parseToolJson(described).ontology, 'Eigos');
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await g?.close();
    await f.close();
    await rm(folder, { recursive: true, force: true });
  }
});
