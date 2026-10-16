import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { auth0Plan, ensureAuth0ConnectionClients } from '../dist/packages/members/auth0.js';

const { values } = parseArgs({ options: {
  'public-url': { type: 'string' }, 'agent-callback': { type: 'string' }, tenant: { type: 'string' },
  connection: { type: 'string' },
  output: { type: 'string', default: 'data/auth0-live' }, apply: { type: 'boolean', default: false },
} });
if (!values['public-url']) throw new Error('Usage: npm run setup:auth0 -- --public-url https://gateway-origin [--tenant tenant.auth0.com --apply]');
const plan = auth0Plan(values['public-url'], values['agent-callback']);
const directory = resolve(values.output), localData = resolve('data');
if (!relative(localData, directory) || relative(localData, directory).startsWith('..') || relative(localData, directory).startsWith('/')) throw new Error('Use a dedicated directory under ignored data/ for private Auth0 configuration');
mkdirSync(directory, { recursive: true, mode: 0o700 });
function save(name, value) {
  const path = join(directory, name), temporary = path + '.tmp';
  writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, path);
}
save('plan.json', plan);
if (!values.apply) {
  console.log('Auth0 configuration plan prepared. No cloud resources were changed.');
  console.log('Private plan:', join(directory, 'plan.json'));
} else {
  const tenant = values.tenant;
  if (!tenant || !/^[a-z0-9][a-z0-9.-]*\.auth0\.com$/.test(tenant)) throw new Error('Supply the authenticated Auth0 tenant domain explicitly');
  const statePath = join(directory, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { tenant, resource: plan.resource };
  if (state.tenant !== tenant || state.resource !== plan.resource) throw new Error('The private setup directory belongs to a different tenant/resource');
  state.configurationComplete = false; save('state.json', state);
  let operation = 'read tenant';
  function api(method, path, body) {
    operation = `${method} ${path}`;
    // Capture response bodies, including client secrets, in memory. Never stream them to terminal/model logs.
    const args = ['api', method, path, '--tenant', tenant, '--json', '--no-input'];
    if (body !== undefined) args.push('--data', '@-');
    const output = execFileSync('auth0', args, { input: body === undefined ? undefined : JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 2000000 });
    return output.length ? JSON.parse(output.toString()) : undefined;
  }
  function list(path, field) {
    const found = [];
    for (let page = 0; page < 100; page++) {
      const response = api('get', `${path}?per_page=100&page=${page}${path === 'actions/actions' ? '' : '&include_totals=true'}`);
      const items = Array.isArray(response) ? response : response[field];
      if (!Array.isArray(items)) throw new Error('Unexpected list response');
      found.push(...items);
      if (items.length < 100 || (response.total !== undefined && found.length >= response.total)) return found;
    }
    throw new Error('List exceeded bounded pagination');
  }
  function ownedClient(component, body) {
    const found = list('clients', 'clients').filter(client => client.client_metadata?.eigos_resource === plan.resource && client.client_metadata?.eigos_component === component);
    if (found.length > 1) throw new Error('Multiple owned clients require review');
    const result = found[0] ? api('get', `clients/${encodeURIComponent(found[0].client_id)}`) : api('post', 'clients', body);
    if (found[0]) {
      if (JSON.stringify(result.callbacks) !== JSON.stringify(body.callbacks) || result.token_endpoint_auth_method !== body.token_endpoint_auth_method) throw new Error('An existing client has a different redirect/authentication contract');
      if (result.is_first_party !== body.is_first_party) throw new Error('Existing client ownership differs; inspect the saved client before replacing an unused setup draft');
    }
    return result;
  }
  try {
    api('get', 'tenants/settings');
    const resources = list('resource-servers', 'resource_servers').filter(item => item.identifier === plan.resource);
    if (resources.length > 1) throw new Error('Multiple API resources require review');
    let resource = resources[0];
    if (resource && resource.name !== plan.api.name) throw new Error('An existing API at this identifier is not owned by this setup');
    if (!resource) resource = api('post', 'resource-servers', plan.api);
    else {
      const { identifier, signing_alg, ...settings } = plan.api;
      if (resource.signing_alg !== signing_alg) throw new Error('Existing API signing algorithm does not match');
      api('patch', `resource-servers/${encodeURIComponent(resource.id)}`, settings);
    }
    state.apiId = resource.id; save('state.json', state);
    const portal = ownedClient('member-portal', plan.portal); state.portalId = portal.client_id; save('state.json', state);
    const agent = ownedClient('personal-agent', plan.agent); state.agentId = agent.client_id; save('state.json', state);
    const connector = ownedClient('agent-onboarding', plan.connector); state.connectorId = connector.client_id; save('state.json', state);
    api('patch', `clients/${encodeURIComponent(connector.client_id)}`, { grant_types: plan.connector.grant_types, refresh_token: plan.connector.refresh_token });
    const databases = list('connections', 'connections').filter(connection => connection.strategy === 'auth0');
    let connection = values.connection ? databases.find(connection => connection.name === values.connection)
      : databases.find(connection => connection.name === 'Username-Password-Authentication') ?? (databases.length === 1 ? databases[0] : undefined);
    if (!connection && (values.connection || databases.length)) throw new Error('Choose the intended Auth0 database connection explicitly');
    if (!connection) connection = api('post', 'connections', { name: 'EIGOS-Members-' + plan.resource.replace(/[^a-zA-Z0-9]/g, '-').slice(-30), strategy: 'auth0' });
    state.connectionId = connection.id; state.connectionName = connection.name; save('state.json', state);
    ensureAuth0ConnectionClients(api, connection.id, [portal.client_id, agent.client_id, connector.client_id]);
    if (!portal.client_secret || /redact|\*{3,}/i.test(portal.client_secret)) throw new Error('The CLI did not return a private portal client secret');
    const code = readFileSync(new URL('../integrations/auth0/post-login.cjs', import.meta.url), 'utf8');
    const secrets = [
      { name: 'EIGOS_RESOURCE', value: plan.resource }, { name: 'EIGOS_MEMBER_CLIENT_ID', value: portal.client_id },
      { name: 'EIGOS_TENANT_CLAIM', value: plan.tenantClaim }, { name: 'EIGOS_TENANT_ID', value: 'personal' },
      { name: 'EIGOS_AGENT_CONNECTOR_CLIENT_ID', value: connector.client_id },
    ];
    const matches = list('actions/actions', 'actions').filter(action => action.name === plan.actionName);
    if (matches.length > 1) throw new Error('Multiple matching Actions require review');
    let action = matches[0];
    if (action) {
      const current = api('get', `actions/actions/${encodeURIComponent(action.id)}`);
      if (!current.code?.includes('EIGOS managed member-identity binding')) throw new Error('The existing Action is not owned by this setup');
      action = api('patch', `actions/actions/${encodeURIComponent(action.id)}`, { code, secrets, runtime: 'node22' });
    } else action = api('post', 'actions/actions', { name: plan.actionName, supported_triggers: [{ id: 'post-login', version: 'v3' }], runtime: 'node22', code, secrets });
    state.actionId = action.id; save('state.json', state);
    const deadline = Date.now() + 60000;
    while (true) {
      const current = api('get', `actions/actions/${encodeURIComponent(action.id)}`);
      if (current.status === 'built') break;
      if (current.status === 'failed' || Date.now() >= deadline) throw new Error('Action build failed or exceeded its deadline; inspect this Action before retrying');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    api('post', `actions/actions/${encodeURIComponent(action.id)}/deploy`, {});
    const bindings = api('get', 'actions/triggers/post-login/bindings').bindings;
    if (!Array.isArray(bindings)) throw new Error('Unexpected trigger bindings');
    if (!bindings.some(binding => binding.action?.id === action.id)) {
      const next = bindings.map(binding => ({ ref: { type: 'action_id', value: binding.action.id }, display_name: binding.display_name }));
      next.push({ ref: { type: 'action_id', value: action.id }, display_name: plan.actionName });
      api('patch', 'actions/triggers/post-login/bindings', { bindings: next });
    }
    const apiReadback = api('get', `resource-servers/${encodeURIComponent(resource.id)}`);
    if (apiReadback.identifier !== plan.resource || apiReadback.signing_alg !== 'RS256' || apiReadback.token_dialect !== 'rfc9068_profile' || apiReadback.token_lifetime !== 900 || apiReadback.allow_offline_access !== true || apiReadback.skip_consent_for_verifiable_first_party_clients !== false) throw new Error('API readback did not confirm the required token/consent contract');
    for (const [client, expected] of [[portal, plan.portal], [agent, plan.agent], [connector, plan.connector]]) {
      const actual = api('get', `clients/${encodeURIComponent(client.client_id)}`);
      if (JSON.stringify(actual.callbacks) !== JSON.stringify(expected.callbacks) || actual.token_endpoint_auth_method !== expected.token_endpoint_auth_method || actual.is_first_party !== expected.is_first_party) throw new Error('OAuth client readback did not confirm the callback/authentication/ownership contract');
    }
    const connectorReadback = api('get', `clients/${encodeURIComponent(connector.client_id)}`);
    if (!plan.connector.grant_types.every(grant => connectorReadback.grant_types?.includes(grant)) || connectorReadback.refresh_token?.rotation_type !== 'rotating' || connectorReadback.refresh_token?.expiration_type !== 'expiring') throw new Error('Agent device/refresh grant readback failed');
    const bindingReadback = api('get', 'actions/triggers/post-login/bindings');
    if (!bindingReadback.bindings?.some(binding => binding.action?.id === action.id)) throw new Error('Action binding readback did not confirm deployment');
    const issuer = `https://${tenant}/`;
    const common = [
      `PUBLIC_URL=${plan.resource}`, `OAUTH_ISSUER=${issuer}`, `OAUTH_JWKS_URL=${issuer}.well-known/jwks.json`,
      `OAUTH_AUDIENCE=${plan.resource}`, `OAUTH_TENANT_CLAIM=${plan.tenantClaim}`, `OIDC_AGENT_CLIENT_ID=${connector.client_id}`,
    ];
    save('gateway.env', [...common, 'EIGOS_AUTH_MODE=jwt', 'HOST=127.0.0.1', 'PORT=3210', `DATABASE_PATH=${directory}/tasks.sqlite`, `MEMBERSHIP_DATABASE_PATH=${directory}/members.sqlite`, `OIDC_CLIENT_ID=${portal.client_id}`, `OIDC_CLIENT_SECRET=${portal.client_secret}`, 'EIGOS_MEMBERSHIP_APPROVAL=self-service', 'EIGOS_EXECUTOR=codex', 'EIGOS_COORDINATOR=disabled', 'EIGOS_PAOTUI_ORDERS_ENABLED=false', 'EIGOS_CSV_PILOT=false', `EIGOS_AUDIT_PATH=${directory}/http-audit.jsonl`, ''].join('\n'));
    save('agent.env', [...common, `DATABASE_PATH=${directory}/tasks.sqlite`, `MEMBERSHIP_DATABASE_PATH=${directory}/members.sqlite`, `EIGOS_AGENT_CLIENT_ID=${agent.client_id}`, `EIGOS_AGENT_CALLBACK_URL=${plan.agentCallback}`, `EIGOS_OAUTH_HANDOFF_PATH=${directory}/agent-login.json`, `EIGOS_OAUTH_EVIDENCE_DIR=${directory}/agent-evidence`, ''].join('\n'));
    save('connector.env', [...common, `DATABASE_PATH=${directory}/tasks.sqlite`, `MEMBERSHIP_DATABASE_PATH=${directory}/members.sqlite`, `EIGOS_AGENT_CREDENTIAL_PATH=${directory}/connector/credentials.json`, `EIGOS_ONBOARDING_HANDOFF_PATH=${directory}/connector-login.json`, `EIGOS_ONBOARDING_EVIDENCE_DIR=${directory}/connector-evidence`, ''].join('\n'));
    state.configurationComplete = true; state.configuredAt = new Date().toISOString(); delete state.stoppedAtOperation; save('state.json', state);
    console.log('Auth0 API, portal/reference/Agent connector clients, rotating refresh grants and scoped identity Action configured. Private environment files saved; no credentials printed.');
  } catch (error) {
    state.configurationComplete = false; state.stoppedAtOperation = operation; save('state.json', state);
    // Provider diagnostics can contain private fields; keep them only in the
    // ignored 0600 file, including when a POST outcome needs investigation.
    save('setup-error.json', { operation, at: new Date().toISOString(), message: error.message,
      status: error.status, stdout: error.stdout?.toString(), stderr: error.stderr?.toString() });
    console.error(`Auth0 setup stopped at ${operation}. Inspect the saved private state and provider response locally before retrying; no automatic recreation was attempted.`);
    process.exitCode = 1;
  }
}
