import assert from 'node:assert/strict';
import { test } from 'node:test';
import { primaryService, type ServiceCommand } from '../packages/deployment/service-manager.js';
import { verifyPrimaryIngresses } from '../packages/deployment/ingress-readiness.js';
import type { RuntimeAuthority } from '../packages/core/runtime-authority.js';

const input = { platform: 'linux' as const, uid: 1000, home: '/home/eigos', runtime: '/home/eigos/.local/share/eigos/primary',
  release: '/home/eigos/.local/share/eigos/primary/releases/current', node: '/usr/local/bin/node', modelBinary: '/opt/harness/bin/dsh' };
function runner(options: { linger?: string; active?: string; systemActive?: boolean; unavailable?: boolean } = {}) {
  const calls: { binary: string; args: string[]; env?: NodeJS.ProcessEnv; timeout?: number }[] = [];
  const run: ServiceCommand = (binary, args, env, timeout) => {
    calls.push({ binary, args, env, timeout });
    if (binary === 'loginctl') return options.linger ?? 'yes';
    if (args.includes('show-environment') && options.unavailable) throw Object.assign(new Error('bus unavailable'), { status: 1 });
    if (args.includes('show')) return args.includes('--user') ? (args.includes('com.eigos.primary.service') ? options.active ?? 'inactive' : 'inactive') : options.systemActive ? 'active' : 'inactive';
    return '';
  };
  return { calls, run };
}

test('Linux primary uses its owner bus, survives logout and retains the full shutdown budget', () => {
  const f = runner({ active: 'active' }), manager = primaryService(input, f.run);
  manager.assertReady(); manager.stop(); manager.start();
  assert.equal(manager.manager, 'systemd-user');
  assert.equal(manager.serviceFile, '/home/eigos/.config/systemd/user/com.eigos.primary.service');
  const stop = f.calls.find(call => call.args.includes('stop'))!;
  assert(stop.args.includes('--user')); assert.equal(stop.timeout, 75000);
  assert.equal(stop.env!.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(stop.env!.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  assert.deepEqual(f.calls.slice(-3).map(call => call.args[1]), ['daemon-reload', 'enable', 'restart']);
  const text = manager.render();
  for (const value of ['Type=exec', 'TimeoutStopSec=60s', 'KillMode=control-group', 'UMask=0077', 'NoNewPrivileges=true', 'WantedBy=default.target', '--built']) assert(text.includes(value));
  assert(!text.includes('User=root')); assert(!text.includes('EIGOS_DEV_TOKEN'));
});

test('Linux primary refuses missing lingering, another system authority and unavailable manager', () => {
  assert.throws(() => primaryService({ ...input, uid: 0 }), /non-root/);
  assert.throws(() => primaryService(input, runner({ linger: 'no' }).run).assertReady(), /lingering/);
  assert.throws(() => primaryService(input, runner({ systemActive: true }).run).assertReady(), /system-level/);
  assert.throws(() => primaryService(input, runner({ unavailable: true }).run).assertReady(), /bus unavailable/);
  const failed: ServiceCommand = () => { throw Object.assign(new Error('unknown state'), { status: 1 }); };
  assert.throws(() => primaryService(input, failed).isLoaded(), /determine/);
});

test('systemd literals cannot expand environment/specifiers or inject another unit directive', () => {
  const manager = primaryService({ ...input, release: '/home/eigos/release %i $ROLE "quoted"' }, runner().run);
  const text = manager.render();
  assert(text.includes('release %%i $$ROLE \\"quoted\\"/scripts/run-local.mjs'));
  assert(manager.ownsConfiguration(text));
  assert.throws(() => primaryService({ ...input, release: '/safe\nExecStart=/evil' }), /control/);
  assert.throws(() => primaryService({ ...input, label: 'other.service' }), /label/);
});

test('macOS retains the launchd label, XML escaping and graceful exit timeout', () => {
  const f = runner(), manager = primaryService({ ...input, platform: 'darwin', home: '/Users/A&B', runtime: '/Users/A&B/.local/share/eigos/primary' }, f.run);
  assert.equal(manager.manager, 'launchd'); assert(manager.render().includes('/Users/A&amp;B/.local/bin'));
  assert(manager.ownsConfiguration(manager.render()));
  assert(!manager.ownsConfiguration(primaryService({ ...input, platform: 'darwin', runtime: '/other/primary' }, f.run).render()));
  assert(manager.render().includes('<key>ExitTimeOut</key><integer>60</integer>'));
  manager.start(); assert.deepEqual(f.calls.slice(-2).map(call => call.args[0]), ['enable', 'bootstrap']);
});

const authority: RuntimeAuthority = { version: 1, id: '69c18116-e948-40fa-8717-1296bc85c648', revision: 1, canonicalOrigin: 'https://primary.example',
  issuer: 'https://issuer.example/', ontologyId: 'eigos.business', databasePath: '/private/tasks.sqlite', membershipDatabasePath: '/private/members.sqlite',
  ingresses: [{ origin: 'https://primary.example', audience: 'https://primary.example/', tenantClaim: 'tenant', agentClientId: 'agent', agentClientIds: ['agent'], nativeClientIds: [], browserRedirect: false, newRegistrations: true }] };
test('public ingress readback validates identity/discovery and both unauthenticated protocols without submitting a task', async () => {
  const urls: string[] = [], methods: string[] = [], expected = { authorityId: authority.id, releaseDigest: 'build' };
  const result = await verifyPrimaryIngresses(authority, expected, async (url, init) => {
    urls.push(url); if (init?.body) methods.push(JSON.parse(String(init.body)).method);
    return { status: url.endsWith('/mcp') || url.endsWith('/a2a') ? 401 : 200,
      body: url.endsWith('/health') ? { status: 'ok', ...expected } : url.endsWith('agent-card.json') ? { supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: authority.canonicalOrigin + '/a2a' }] }
        : { resource: authority.ingresses[0]!.audience, authorization_servers: [authority.issuer] } };
  });
  assert.equal(urls.length, 5); assert.deepEqual(methods.sort(), ['GetTask', 'initialize']);
  assert.equal(result[0]!.unauthenticatedMcp, 401); assert.equal(result[0]!.unauthenticatedA2a, 401);
  await assert.rejects(verifyPrimaryIngresses(authority, expected, async () => ({ status: 200, body: { status: 'ok', authorityId: 'other', releaseDigest: 'build' } })), /did not verify/);
});
