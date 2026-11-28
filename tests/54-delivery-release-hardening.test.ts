import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { computeImplementationDigest, isRuntimeImplementationPath } from '../packages/runtime/implementation.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

const execFileAsync = promisify(execFile);

const property = (required = true) => ({ description: 'Property', schema: { type: 'string' }, required });
const itemType = (extra: Record<string, ReturnType<typeof property>> = {}) => ({
  apiName: 'Item', displayName: 'Item', description: 'Item', primaryKey: 'id', titleProperty: 'name',
  properties: { id: property(), name: property(), ...extra }, interfaces: {},
});
const groupType = {
  apiName: 'Group', displayName: 'Group', description: 'Group', primaryKey: 'id', titleProperty: 'name',
  properties: { id: property(), name: property() }, interfaces: {},
};
const emptyBindings = { describe: () => ({ functions: {}, sources: {} }) };

async function listen(server: Server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function closeServer(server: Server) {
  if (server.listening) await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}

async function sparePort() {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('Readiness check timed out');
}

test('indexer refuses startup when active release bindings or runtimeId do not match, and compatibilityDigest separates contract compatibility', async () => {
  const f = await fixture();
  try {
    // 1. Contract compatibility helper vs strict checkBindings
    const strictMismatch = f.metadata.compatibilityDigest(f.model, f.capabilities);
    assert.equal(strictMismatch, f.metadata.compatibilityDigest(f.model));
    assert.equal(f.metadata.isContractCompatible(f.model, f.capabilities), true);

    const changedBindings = {
      describe: () => ({ ...f.model.bindings, functions: { ...f.model.bindings.functions, extraFn: 'changed-binding' } }),
    };
    assert.equal(f.metadata.isContractCompatible(f.model, changedBindings), false);
    assert.throws(() => f.metadata.checkBindings(f.model, changedBindings), /does not match this runtime implementation/);
    assert.throws(
      () => f.metadata.checkBindings(f.model, changedBindings, { allowCompatibleRuntime: true }),
      /does not match this runtime implementation/,
    );

    // Simulate a release published by a different runtimeId with the exact same binding manifest
    await f.db.query(`UPDATE ${f.schema}.releases SET runtime_id='stale-runtime-id' WHERE digest=$1`, [f.model.release]);
    const staleMetadata = new Metadata(f.db);
    const staleModel = await staleMetadata.active();
    assert.equal(staleModel.runtimeId, 'stale-runtime-id');
    assert.equal(staleMetadata.isContractCompatible(staleModel, f.capabilities), true);
    assert.throws(() => staleMetadata.checkBindings(staleModel, f.capabilities), /does not match this runtime implementation/);
    assert.doesNotThrow(() => staleMetadata.checkBindings(staleModel, f.capabilities, { allowCompatibleRuntime: true }));

    // 2. Real Indexer process startup refuses to run against the incompatible release
    let failed = false;
    try {
      await execFileAsync(process.execPath, ['--import', 'tsx', 'apps/indexer/main.ts'], {
        env: {
          ...process.env,
          DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL,
          EIGOS_PG_SCHEMA: f.schema,
        },
        timeout: 15000,
      });
    } catch (error) {
      failed = true;
      const err = error as { code?: number; stderr?: string };
      assert.notEqual(err.code, 0);
      assert.match(err.stderr ?? '', /The publication does not match this runtime implementation/);
    }
    assert.equal(failed, true, 'Indexer must exit non-zero on incompatible active release');
  } finally {
    await f.close();
  }
});

test('ontology rollback prepares a fresh candidate projection from a retired release and activates cleanly (API and CLI)', async () => {
  const f = await fixture();
  try {
    // 1. Metadata.rollback() API lifecycle
    const v1Doc = {
      id: 'RollbackTest', version: '1.0.0', objectTypes: [itemType()],
      interfaceTypes: [], linkTypes: [], functionTypes: [], actionTypes: [], dataSources: [],
    };
    const v2Doc = {
      ...v1Doc, version: '2.0.0', objectTypes: [itemType({ note: property(false) })],
    };
    await setGrants(f.db, 'deployment', [
      { resource: 'Eigos', permission: 'manage_definition' },
      { resource: 'RollbackTest', permission: 'manage_definition' },
    ]);
    await f.publisher.refresh();

    const v1 = await f.metadata.publish(v1Doc, emptyBindings, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(v1));
    const accessV1 = await Access.load(f.db, principal);
    await new Objects(f.db, v1, accessV1).create({ type: 'Item', id: 'item-1' }, { id: 'item-1', name: 'First' });

    const v2 = await f.metadata.publish(v2Doc, emptyBindings, f.publisher);
    const accessV2 = await Access.load(f.db, principal);
    await new Objects(f.db, v2, accessV2).create({ type: 'Item', id: 'item-2' }, { id: 'item-2', name: 'Second', note: 'v2-only' });

    // Reject rolling back to active, prepared, or unknown releases
    await assert.rejects(() => f.metadata.rollback(v2.release, emptyBindings, f.publisher), /already active/);
    const preparedOnly = await f.metadata.prepare(v2Doc, emptyBindings, f.publisher);
    await assert.rejects(() => f.metadata.rollback(preparedOnly.release, emptyBindings, f.publisher), /previously active retired release/);
    await assert.rejects(() => f.metadata.rollback('0'.repeat(64), emptyBindings, f.publisher), /unavailable/);

    // Roll back to v1
    const rolled = await f.metadata.rollback(v1.release, emptyBindings, f.publisher);
    assert.notEqual(rolled.release, v1.release, 'Rollback must create a fresh immutable release');
    assert.notEqual(rolled.release, v2.release);
    assert.notEqual(rolled.projection, v1.projection);
    assert.notEqual(rolled.projection, v2.projection);
    assert.equal(rolled.digest, v1.digest, 'Rolled-back release definition must match v1');

    const states = (await f.db.query<{ digest: string; state: string }>(
      `SELECT digest, state FROM ${f.schema}.releases WHERE digest = ANY($1::text[])`,
      [[v1.release, v2.release, rolled.release]],
    )).rows;
    const stateByDigest = Object.fromEntries(states.map(r => [r.digest, r.state]));
    assert.equal(stateByDigest[v1.release], 'retired');
    assert.equal(stateByDigest[v2.release], 'retired');
    assert.equal(stateByDigest[rolled.release], 'active');

    // Live data from both v1 and v2 is preserved, with v2-only property stripped cleanly
    const accessRolled = await Access.load(f.db, principal);
    const graphRolled = new Objects(f.db, rolled, accessRolled);
    const first = await graphRolled.read({ type: 'Item', id: 'item-1' });
    const second = await graphRolled.read({ type: 'Item', id: 'item-2' });
    assert.equal(first.properties.name, 'First');
    assert.equal(second.properties.name, 'Second');
    assert.equal(Object.hasOwn(second.properties, 'note'), false);

    // 2. CLI `scripts/ontology.ts rollback <release>` end-to-end on the default Eigos ontology
    const originalEigos = f.model;
    const nextEigos = await f.metadata.publish(f.model.document, f.capabilities, f.publisher);
    assert.notEqual(nextEigos.release, originalEigos.release);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'scripts/ontology.ts', 'rollback', originalEigos.release],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL,
          EIGOS_PG_SCHEMA: f.schema,
        },
        timeout: 20000,
      },
    );
    const output = JSON.parse(stdout.trim()) as { release: string; definition: string; rolledBackTo: string };
    assert.equal(output.definition, originalEigos.digest);
    assert.equal(output.rolledBackTo, originalEigos.release);
    assert.notEqual(output.release, nextEigos.release);
    const activeAfterCli = await f.metadata.active('Eigos');
    assert.equal(activeAfterCli.release, output.release);
  } finally {
    await f.close();
  }
});

test('implementationDigest stays stable across pure UI/workbench asset edits and changes on runtime edits', async () => {
  assert.equal(isRuntimeImplementationPath('apps/workbench/index.html'), false);
  assert.equal(isRuntimeImplementationPath('apps/workbench/app.js'), false);
  assert.equal(isRuntimeImplementationPath('apps/workbench/workbench.css'), false);
  assert.equal(isRuntimeImplementationPath('apps/gateway/style.css'), false);
  assert.equal(isRuntimeImplementationPath('apps/gateway/page.html'), false);
  assert.equal(isRuntimeImplementationPath('apps/gateway/main.ts'), true);
  assert.equal(isRuntimeImplementationPath('packages/runtime/metadata.ts'), true);

  const dir = await mkdtemp(join(tmpdir(), 'eigos-impl-digest-'));
  try {
    await mkdir(join(dir, 'apps/gateway'), { recursive: true });
    await mkdir(join(dir, 'apps/workbench'), { recursive: true });
    await mkdir(join(dir, 'packages/runtime'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"name":"eigos"}\n');
    await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
    await writeFile(join(dir, 'tsconfig.json'), '{}\n');
    await writeFile(join(dir, 'apps/gateway/main.ts'), 'export const port = 3000;\n');
    await writeFile(join(dir, 'packages/runtime/core.ts'), 'export const v = 1;\n');
    await writeFile(join(dir, 'apps/workbench/index.html'), '<html><body>v1</body></html>\n');
    await writeFile(join(dir, 'apps/workbench/workbench.css'), 'body { color: black; }\n');
    await writeFile(join(dir, 'apps/workbench/app.js'), 'console.log("ui-v1");\n');
    await writeFile(join(dir, 'apps/gateway/theme.css'), '.a { color: red; }\n');
    await writeFile(join(dir, 'apps/gateway/landing.html'), '<h1>v1</h1>\n');

    const baseline = computeImplementationDigest(dir);

    // Mutating UI/CSS/HTML/workbench files must NOT change the runtime implementation digest
    await writeFile(join(dir, 'apps/workbench/index.html'), '<html><body>v2 redesigned</body></html>\n');
    await writeFile(join(dir, 'apps/workbench/workbench.css'), 'body { color: navy; font-size: 16px; }\n');
    await writeFile(join(dir, 'apps/workbench/app.js'), 'console.log("ui-v2-completely-different");\n');
    await writeFile(join(dir, 'apps/workbench/new-widget.ts'), 'export const widget = true;\n');
    await writeFile(join(dir, 'apps/gateway/theme.css'), '.a { color: blue; }\n');
    await writeFile(join(dir, 'apps/gateway/landing.html'), '<h1>v2</h1>\n');

    assert.equal(computeImplementationDigest(dir), baseline, 'UI/static asset edits must not invalidate implementationDigest');

    // Mutating a runtime TypeScript file MUST change the digest
    await writeFile(join(dir, 'packages/runtime/core.ts'), 'export const v = 2;\n');
    assert.notEqual(computeImplementationDigest(dir), baseline, 'Runtime code edits must change implementationDigest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('paginated projection fingerprinting produces identical digests across page sizes and detects mutations', async () => {
  const f = await fixture();
  try {
    const doc = {
      id: 'FingerprintTest', version: '1.0.0', objectTypes: [itemType(), groupType],
      interfaceTypes: [],
      linkTypes: [{
        apiName: 'Membership', description: 'Group membership',
        from: { type: 'Item', name: 'group', cardinality: 'one' },
        to: { type: 'Group', name: 'items', cardinality: 'many' },
      }],
      functionTypes: [], actionTypes: [], dataSources: [],
    };
    await setGrants(f.db, 'deployment', [
      { resource: 'Eigos', permission: 'manage_definition' },
      { resource: 'FingerprintTest', permission: 'manage_definition' },
    ]);
    await f.publisher.refresh();
    const published = await f.metadata.publish(doc, emptyBindings, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(published));
    const access = await Access.load(f.db, principal);
    const graph = new Objects(f.db, published, access);

    for (let i = 0; i < 3; i++) {
      await graph.create({ type: 'Group', id: `g-${i}` }, { id: `g-${i}`, name: `Group ${i}` });
    }
    for (let i = 0; i < 11; i++) {
      const id = `item-${String(i).padStart(2, '0')}`;
      await graph.create({ type: 'Item', id }, { id, name: `Item ${i}` });
      await graph.link({ type: 'Membership', from: { type: 'Item', id }, to: { type: 'Group', id: `g-${i % 3}` } });
    }
    await f.db.query(
      `INSERT INTO ${f.schema}.edit_policies(ontology,type,policy) VALUES($1,'Item','user_wins')`,
      ['FingerprintTest'],
    );

    const fp1 = await f.metadata.fingerprint(published.projection, f.db.pool, 'FingerprintTest', 1);
    const fp3 = await f.metadata.fingerprint(published.projection, f.db.pool, 'FingerprintTest', 3);
    const fp5 = await f.metadata.fingerprint(published.projection, f.db.pool, 'FingerprintTest', 5);
    const fp1000 = await f.metadata.fingerprint(published.projection, f.db.pool, 'FingerprintTest', 1000);
    assert.equal(fp1, fp3);
    assert.equal(fp3, fp5);
    assert.equal(fp5, fp1000);

    // Without ontology, edit_policies are omitted deterministically
    const fpNoOnt1 = await f.metadata.fingerprint(published.projection, f.db.pool, undefined, 2);
    const fpNoOnt1000 = await f.metadata.fingerprint(published.projection, f.db.pool, undefined, 1000);
    assert.equal(fpNoOnt1, fpNoOnt1000);
    assert.notEqual(fpNoOnt1, fp1000);

    // Mutating an object changes the fingerprint and preserves page-size parity
    await graph.edit({ type: 'Item', id: 'item-07' }, 1, { name: 'Item 7 Updated' });
    const afterEdit2 = await f.metadata.fingerprint(published.projection, f.db.pool, 'FingerprintTest', 2);
    const afterEdit1000 = await f.metadata.fingerprint(published.projection, f.db.pool, 'FingerprintTest', 1000);
    assert.equal(afterEdit2, afterEdit1000);
    assert.notEqual(afterEdit2, fp1000);

    // Mutating edit_policies changes the ontology-scoped fingerprint
    await f.db.query(
      `UPDATE ${f.schema}.edit_policies SET policy='latest_value' WHERE ontology=$1 AND type='Item'`,
      ['FingerprintTest'],
    );
    const afterPolicy = await f.metadata.fingerprint(published.projection, f.db.pool, 'FingerprintTest', 2);
    assert.notEqual(afterPolicy, afterEdit2);
  } finally {
    await f.close();
  }
});

test('deploy/agentgateway/run-cutover.sh handles success, rollback-restored failure, unrecovered failure, and dependency blocks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eigos-cutover-harness-'));
  const binDir = join(dir, 'bin');
  const socketPath = join(dir, 'control.sock');
  const agentConfigPath = join(dir, 'agentgateway.yaml');
  const originStatePath = join(dir, 'origin-commit.txt');
  const depsStatePath = join(dir, 'connector-deps.txt');
  const scriptCopy = join(dir, 'run-cutover.sh');
  const originPort = await sparePort();
  const handoffPort = await sparePort();
  const oldSha = '1'.repeat(40);
  const targetSha = '2'.repeat(40);

  let originServer: Server | undefined;
  let handoffChild: ChildProcess | undefined;

  const control = <T,>(url = '/status', method = 'GET') => new Promise<T>((resolve, reject) => {
    const req = request({ socketPath, path: url, method }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new Error(`Control returned ${response.statusCode}`));
        else resolve(JSON.parse(body) as T);
      });
      response.on('error', reject);
    }).on('error', reject);
    req.end();
  });
  type HandoffState = { holding: boolean; inflight: number; queued: number; expired: number; overflow: number; forwarded: number };

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(originStatePath, oldSha);
    await writeFile(depsStatePath, '');
    await writeFile(agentConfigPath, `      - host: 127.0.0.1:${handoffPort}\n`);

    // Mock origin server reading its current state from originStatePath ('DOWN' => 503)
    originServer = createServer(async (req, res) => {
      const state = (await readFile(originStatePath, 'utf8')).trim();
      if (req.url === '/health' && state !== 'DOWN') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', sourceCommit: state }));
        return;
      }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'down' }));
    });
    await listen(originServer, originPort);

    // Start real origin-handoff.mjs forwarding handoffPort -> originPort
    handoffChild = spawn(process.execPath, [
      'deploy/agentgateway/origin-handoff.mjs', socketPath, String(handoffPort), String(originPort),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    await eventually(() => control<HandoffState>());

    // Create portable mock binaries for systemd/runuser/flock so run-cutover.sh runs without root/systemd
    const mockSystemctl = join(binDir, 'systemctl');
    await writeFile(mockSystemctl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--user" ]]; then shift; fi
case "\${1:-}" in
  is-active) exit 0 ;;
  show)
    prop=""
    for ((i=1; i<=$#; i++)); do
      if [[ "\${!i}" == "-p" ]]; then
        next=$((i+1))
        prop="\${!next}"
      fi
    done
    if [[ "$prop" == "InvocationID" ]]; then
      echo "0123456789abcdef0123456789abcdef"
    elif [[ "$prop" == "Requires" ]]; then
      cat "${depsStatePath}"
    else
      echo ""
    fi
    ;;
  *) exit 0 ;;
esac
`);
    await chmod(mockSystemctl, 0o755);

    const mockRunuser = join(binDir, 'runuser');
    await writeFile(mockRunuser, `#!/usr/bin/env bash
set -euo pipefail
# Strip: -u <user> -- env XDG_RUNTIME_DIR=... <cmd...>
while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done
shift
exec "$@"
`);
    await chmod(mockRunuser, 0o755);

    const mockFlock = join(binDir, 'flock');
    await writeFile(mockFlock, `#!/usr/bin/env bash
exit 0
`);
    await chmod(mockFlock, 0o755);

    // Adapt only the hardcoded host paths and ports in a temp copy of run-cutover.sh
    const originalScript = await readFile('deploy/agentgateway/run-cutover.sh', 'utf8');
    const adaptedScript = originalScript
      .replace('base=/Users/proerror/.local/share/eigos/primary', `base=${dir}`)
      .replace('socket=/run/eigos-origin-handoff/control.sock', `socket=${socketPath}`)
      .replace('      - host: 127.0.0.1:13213', `      - host: 127.0.0.1:${handoffPort}`)
      .replace('/etc/eigos-agentgateway/config.yaml', agentConfigPath)
      .replaceAll('health 3212', `health ${originPort}`)
      .replaceAll('health 13212', `health ${handoffPort}`);
    await writeFile(scriptCopy, adaptedScript);
    await chmod(scriptCopy, 0o755);

    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
    const runCutover = (hookArgs: string[]) => execFileAsync('bash', [scriptCopy, oldSha, targetSha, '--', ...hookArgs], {
      env,
      timeout: 15000,
    });

    // Case 1: Blocked by forbidden systemd unit dependency on frontend connector
    await writeFile(depsStatePath, 'com.eigos.primary.service\n');
    await assert.rejects(
      () => runCutover(['true']),
      (err: { stderr?: string }) => /Cutover blocked:.*Requires=com\.eigos\.primary\.service/.test(err.stderr ?? ''),
    );
    assert.equal((await control<HandoffState>()).holding, false);
    await writeFile(depsStatePath, '');

    // Case 2: Hook fails but leaves old origin healthy -> recover_ingress resumes handoff (/serve)
    await assert.rejects(
      () => runCutover(['bash', '-c', 'exit 1']),
      (err: { code?: number }) => err.code === 1,
    );
    assert.equal((await control<HandoffState>()).holding, false, 'Handoff must resume when old origin is still healthy');

    // Case 3: Hook fails AND leaves origin broken -> recover_ingress keeps handoff holding and warns operator
    await assert.rejects(
      () => runCutover(['bash', '-c', `echo DOWN > "${originStatePath}"; exit 1`]),
      (err: { code?: number; stderr?: string }) =>
        err.code === 1 && /The old origin was not restored/.test(err.stderr ?? ''),
    );
    assert.equal((await control<HandoffState>()).holding, true, 'Handoff must remain holding when old origin is down');

    // Restore origin and resume handoff before testing the happy path
    await writeFile(originStatePath, oldSha);
    await control('/serve', 'POST');
    assert.equal((await control<HandoffState>()).holding, false);

    // Case 4: Success path -> hook updates origin to targetSha, cutover succeeds and resumes handoff
    await runCutover(['bash', '-c', `echo "${targetSha}" > "${originStatePath}"`]);
    const finalState = await control<HandoffState>();
    assert.equal(finalState.holding, false);
    assert.equal(finalState.expired, 0);
    assert.equal(finalState.overflow, 0);
  } finally {
    if (handoffChild && handoffChild.exitCode === null && handoffChild.signalCode === null) {
      const exit = once(handoffChild, 'exit');
      handoffChild.kill();
      await exit;
    }
    if (originServer) await closeServer(originServer);
    await rm(dir, { recursive: true, force: true });
  }
});
