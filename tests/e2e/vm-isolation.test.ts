import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import pg from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Accounts, emailDigest } from '../../packages/runtime/accounts.js';
import { Database } from '../../packages/runtime/database.js';
import { businessGrants, setGrants } from '../../packages/runtime/access.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { didiPAAccountResources } from '../../packages/ontology/didi-pa-access.js';
import { didiPAReadTool } from '../../packages/capabilities/didi/pa-read.js';
import { digest } from '../../packages/core/identity.js';
import { provider, route } from '../fixture.js';

const run = promisify(execFile);
async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const addr = socket.address();
  assert(addr && typeof addr !== 'string');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return addr.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'),
    force = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM');
  try {
    await done;
  } finally {
    clearTimeout(force);
  }
}
const owner = digest('same-personal-agent-user');
const message = (id: string, action: string, input: unknown, read?: unknown) => ({
  message: {
    messageId: id,
    contextId: 'original-chat',
    role: 'ROLE_USER',
    parts: [{ data: { action: { action, input }, read } }],
  },
});
test('two separately installed EIGOS environments isolate saved homes, trip estimates and original PA consent', async (t) => {
  const server = new URL(process.env.EIGOS_TEST_DATABASE_URL!);
  assert.equal(server.hostname, '127.0.0.1');
  assert.equal(server.password, 'synthetic-only');
  const admin = new pg.Client({ connectionString: server.href });
  await admin.connect();
  const root = await mkdtemp(join(tmpdir(), 'eigos-vm-')),
    pkg = process.env.EIGOS_TEST_VM_BUNDLE ?? join(root, 'bundle');
  const children: ChildProcess[] = [],
    databases: Database[] = [],
    resources: { name: string; roles: string[] }[] = [],
    clients: Client[] = [];
  const supplier = await provider();
  supplier.flags.related = false;
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(children.map(stop));
    await Promise.all(databases.map((db) => db.close()));
    for (const { name, roles } of resources) {
      await admin.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
      for (const role of roles) await admin.query('DROP ROLE IF EXISTS ' + role);
    }
    await admin.end();
    await supplier.close();
    await rm(root, { recursive: true, force: true });
  });
  if (!process.env.EIGOS_TEST_VM_BUNDLE) await run(process.execPath, ['scripts/package-vm.mjs', pkg]);
  const release = JSON.parse(await readFile(join(pkg, 'release.json'), 'utf8'));
  const installFiles = async (bundle: string, dir: string) => {
    await run(process.execPath, [join(bundle, 'install.mjs'), dir]);
    await run('npm', ['ci', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: dir });
  };
  const consumer = join(root,'outside-pa');
  await mkdir(consumer);
  await writeFile(join(consumer,'package.json'), JSON.stringify({private:true,type:'module'}));
  const {stdout: packed} = await run(process.execPath,['scripts/package-sdk.mjs',consumer]);
  const {client: clientFile,bindings} = JSON.parse(packed.trim());
  await run('npm',['install','--ignore-scripts','--prefer-offline','--no-audit','--no-fund','./'+clientFile,'./'+bindings],{cwd:consumer});
  await writeFile(join(consumer,'main.ts'),await readFile('tests/sdk-consumer/main.ts.example'));
  await run(resolve('node_modules/.bin/tsc'),['--ignoreConfig','--strict','--skipLibCheck','--module','NodeNext','--target','ES2023','main.ts'],{cwd:consumer});
  const external = await import(join(consumer,'main.js'));
  async function environment(label: string) {
    const name = 'vm_' + randomUUID().replaceAll('-', ''),
      role = name + '_app',
      reader = name + '_read',
      roles = [role, reader];
    resources.push({ name, roles });
    const password = randomUUID(),
      readPassword = randomUUID();
    await admin.query('CREATE DATABASE ' + name);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}';
      CREATE ROLE ${reader} LOGIN BYPASSRLS PASSWORD '${readPassword}';
      REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC; GRANT CONNECT ON DATABASE ${name} TO ${role},${reader}`);
    const url = new URL(server);
    url.pathname = '/' + name;
    const runtimeURL = new URL(url);
    runtimeURL.username = role;
    runtimeURL.password = password;
    const readerURL = new URL(url);
    readerURL.username = reader;
    readerURL.password = readPassword;
    const db = new Database(url.href);
    databases.push(db);
    let dir = join(root, label);
    await installFiles(pkg, dir);
    const port = await freePort(),
      base = 'http://127.0.0.1:' + port;
    const env = {
      PATH: process.env.PATH,
      EIGOS_MODEL_MODE: 'actions-only',
      EIGOS_SIGNUP: 'closed',
      EIGOS_INSTALLATION_ID: randomUUID(),
      EIGOS_STATE_DIR: join(root, label + '-state'),
      EIGOS_RUNTIME_ROLE: role,
      EIGOS_KERNEL_ROLE: reader,
      EIGOS_KERNEL_DATABASE_URL: readerURL.href,
      EIGOS_ENFORCE_OWNER_RLS: 'true',
      EIGOS_DIDI_PA_READS_ENABLED: 'true',
      OAUTH_ISSUER: 'https://' + label + '.invalid/',
      OAUTH_AUDIENCE: label,
      OAUTH_JWKS_URL: 'https://' + label + '.invalid/jwks',
      OAUTH_MEMBER_CLIENT_ID: 'portal',
      OAUTH_MEMBER_CLIENT_SECRET: randomUUID(),
      OAUTH_MEMBER_MCP_CLIENT_ID: 'pa',
      OAUTH_EXISTING_CLIENT_IDS: 'operator',
      EIGOS_PORTAL_SECRET: randomUUID(),
      EIGOS_ACCOUNT_LINK_SECRET: randomUUID(),
      PUBLIC_URL: 'https://127.0.0.1:' + port,
      HOST: '127.0.0.1',
      PORT: String(port),
      EIGOS_WORKER_SLOTS: '2',
    };
    const cli = async (cmd: string, database = url.href) =>
      JSON.parse(
        (
          await run(process.execPath, ['apps/eigos-vm.js', cmd], {
            cwd: dir,
            env: { ...env, DATABASE_URL: database },
          })
        ).stdout.trim(),
      );
    const receipt = await cli('install');
    assert.equal(receipt.solutionVersion, JSON.parse(await readFile('package.json', 'utf8')).version);
    assert.deepEqual(receipt.foundry, JSON.parse(await readFile('vendor/mdn-foundry/manifest.json', 'utf8')));
    assert.deepEqual(await cli('install'), receipt);
    assert.deepEqual(await cli('verify', runtimeURL.href), receipt);
    const accounts = new Accounts(db, 'invite');
    const email = 'user@example.test',
      session = { owner, email_hash: emailDigest(email) };
    assert(await accounts.apply(session, email, 'Synthetic read-only isolation test'));
    assert(await accounts.approveApplication(owner, email));
    const token = await accounts.issueAgentToken(owner);
    assert(token);
    const model = await new Metadata(db).active();
    await setGrants(
      db,
      'account-actions:' + owner,
      businessGrants(model).filter((g) => didiPAAccountResources.has(g.resource)),
    );
    let log = '';
    const start = (cmd: string) => {
      const child = spawn(process.execPath, ['apps/eigos-vm.js', cmd], {
        cwd: dir,
        env: { ...env, DATABASE_URL: runtimeURL.href },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr.on('data', (bytes) => {
        log = (log + bytes).slice(-1200);
      });
      child.stdout.resume();
      children.push(child);
      return child;
    };
    const gateway = start('gateway'),
      indexer = start('indexer');
    let worker: ChildProcess | undefined;
    const health = async () => {
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        if (gateway.exitCode !== null || indexer.exitCode !== null) throw new Error(log);
        const data = await fetch(base + '/health')
          .then((r) => r.json())
          .catch(() => undefined);
        if (data?.ontologyRelease === receipt.release) return data;
        await delay(100);
      }
      throw new Error('Gateway readiness timeout: ' + log);
    };
    assert.equal((await health()).implementationDigest, receipt.runtime);
    const mcp = new Client({ name: 'pa-isolation', version: '1' });
    clients.push(mcp);
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + token } },
      }),
    );
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp.callTool({ name, arguments: args });
      assert(!result.isError, JSON.stringify(result.content));
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    };
    const rpc = async (method: string, params: unknown, credential = token) => {
      const r = await fetch(base + '/a2a', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + credential,
          'A2A-Version': '1.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: r.status, body: await r.json() };
    };
    const send = async (params: unknown) => {
      const r = await rpc('SendMessage', params);
      assert.equal(r.status, 200);
      assert(!r.body.error, JSON.stringify(r.body));
      return r.body.result.task;
    };
    const answer = (taskId: string, requestId: string, response: unknown) => ({
      message: {
        taskId,
        contextId: 'original-chat',
        messageId: randomUUID(),
        role: 'ROLE_USER',
        parts: [{ data: { paResponse: { requestId, response } } }],
      },
    });
    const poll = async (id: string, state: string, capability?: string, previous?: string) => {
      const until = Date.now() + 30000;
      do {
        const task = await tool('get_task', { taskId: id });
        if (
          task.state === state &&
          (!capability || task.result?.capability === capability) &&
          (!previous || task.result?.requestId !== previous)
        )
          return task;
        assert(!['failed', 'completed', 'canceled'].includes(task.state), JSON.stringify(task) + ' ' + log);
        assert(!worker || worker.exitCode === null, log);
        await delay(100);
      } while (Date.now() < until);
      throw new Error('Original task did not reach ' + state + ': ' + log);
    };
    return {
      receipt,
      token,
      db,
      accounts,
      cli,
      runtimeURL,
      pa: external.connect(base,token).pa,
      rpc,
      tool,
      send,
      answer,
      poll,
      startWorker() {
        worker = start('worker');
      },
      async shutdown() {
        await Promise.all([gateway, indexer, ...(worker ? [worker] : [])].map(stop));
      },
      async upgrade(bundle: string) {
        dir = join(root, label + '-next');
        await installFiles(bundle, dir);
        return cli('upgrade');
      },
    };
  }
  const a = await environment('alpha'),
    b = await environment('beta');
  for (const key of ['engine', 'solution', 'runtime']) assert.equal(a.receipt[key], b.receipt[key]);
  assert.deepEqual(a.receipt.ontology, b.receipt.ontology);
  assert.deepEqual(a.receipt.native, b.receipt.native);
  for (const key of ['instance', 'storage', 'release', 'projection'])
    assert.notEqual(a.receipt[key], b.receipt[key]);
  await assert.rejects(a.cli('verify', b.runtimeURL.href), /Database does not match/);
  const wrong = new URL(a.runtimeURL);
  wrong.pathname = b.runtimeURL.pathname;
  const blocked = new pg.Client({ connectionString: wrong.href });
  await assert.rejects(blocked.connect(), /permission denied/);
  await blocked.end();
  await assert.rejects(a.cli('install', b.runtimeURL.href), /Database does not match/);
  const hA = await external.saveHome(a.pa,'甲环境合成住宅'),
    hB = await external.saveHome(b.pa,'乙环境合成住宅');
  assert.notEqual(hA.id, hB.id);
  assert.equal(hA.contextId, hB.contextId);
  a.startWorker();
  await a.poll(hA.id, 'completed');
  assert.equal((await b.tool('get_task', { taskId: hB.id })).state, 'submitted');
  b.startWorker();
  await b.poll(hB.id, 'completed');
  const homes = async (x: typeof a) =>
    (await x.pa.query('PersonalPlaceVersion')).items;
  const rowsA = await homes(a),
    rowsB = await homes(b);
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  const [ha] = rowsA,
    [hb] = rowsB;
  assert.deepEqual(ha.ref, hb.ref);
  assert.equal(ha.properties.address, '甲环境合成住宅');
  assert.equal(hb.properties.address, '乙环境合成住宅');
  const quote = message('trip', 'EstimateRide', route, {
    function: 'readRideEstimates',
    resultParameter: 'request',
  });
  const qa = await a.send(quote),
    qb = await b.send(quote);
  assert.notEqual(qa.id, qb.id);
  assert.equal((await a.send(quote)).id, qa.id);
  for (const [here, other, id] of [
    [a, b, qb.id],
    [b, a, qa.id],
  ] as const) {
    assert.equal((await here.rpc('GetTask', { id }, other.token)).status, 401);
    for (const method of ['GetTask', 'CancelTask']) assert((await here.rpc(method, { id })).body.error);
  }
  const observe = async (
    x: typeof a,
    id: string,
    result: {
      requestId: string;
      input: { tool: string; arguments: Record<string, unknown>; connectionRef?: string };
    },
  ) => {
    const { data, receipt } = await supplier.source.connector.invoke(
      { requestId: result.requestId, requestRevision: 1 },
      didiPAReadTool.parse(result.input.tool),
      result.input.arguments,
      AbortSignal.timeout(10000),
    );
    const { bindingId: _, environment: __, ...proof } = receipt;
    await x.send(
      x.answer(id, result.requestId, {
        status: 'observed',
        data,
        receipt: proof,
        ...(result.input.connectionRef ? { connectionRef: result.input.connectionRef } : {}),
      }),
    );
  };
  const authorize = async (x: typeof a, id: string) => {
    let previous: string | undefined;
    for (let i = 0; i < 2; i++) {
      const { result } = await x.poll(id, 'input-required', 'didi.read', previous);
      assert.equal(result.input.tool, 'maps_textsearch');
      await observe(x, id, result);
      previous = result.requestId;
    }
    const read = await x.poll(id, 'input-required', 'didi.read', previous);
    assert.equal(read.result.input.tool, 'taxi_estimate');
    await x.send(x.answer(id, read.result.requestId, { status: 'authorization_required' }));
    return (await x.poll(id, 'input-required', 'didi.authorize', read.result.requestId)).result;
  };
  const aa = await authorize(a, qa.id),
    ab = await authorize(b, qb.id);
  assert.notEqual(aa.requestId, ab.requestId);
  assert.equal(ab.input.purpose, 'read');
  const reference = digest('beta synthetic PA connection'),
    connected = { status: 'connected', connectionRef: reference };
  assert((await b.rpc('SendMessage', b.answer(qb.id, aa.requestId, connected))).body.error);
  assert((await a.rpc('SendMessage', a.answer(qa.id, ab.requestId, connected))).body.error);
  await b.pa.respond(qb,randomUUID(),ab.requestId,connected);
  assert.equal((await a.poll(qa.id, 'input-required', 'didi.authorize')).result.requestId, aa.requestId);
  await a.send(a.answer(qa.id, aa.requestId, { status: 'declined' }));
  await a.poll(qa.id, 'failed');
  const authorizedRead = await b.poll(qb.id, 'input-required', 'didi.read', ab.requestId);
  assert.equal(authorizedRead.result.input.connectionRef, reference);
  await observe(b, qb.id, authorizedRead.result);
  const completed = await b.poll(qb.id, 'completed');
  assert.equal((await b.pa.get(qb.id)).id,qb.id);
  assert.equal(completed.result.accepted, false);
  assert.equal(completed.result.estimates.length, 2);
  assert.deepEqual(completed.result.evidence, ['pa_reported']);
  assert.equal(supplier.flags.orderCreates, 0);
  await a.accounts.revoke(owner);
  assert.equal((await a.rpc('GetTask', { id: qa.id })).status, 401);
  assert(!(await b.rpc('GetTask', { id: qb.id })).body.error);
  await a.shutdown();
  const next = join(root, 'next-definition.json'),
    bundle = join(root, 'next-bundle');
  await writeFile(
    next,
    JSON.stringify({
      ...JSON.parse(await readFile(join(pkg, 'solution/ontology.json'), 'utf8')),
      version: 'vm-isolation-review',
    }),
  );
  await run(process.execPath, ['scripts/package-vm.mjs', bundle, next]);
  const upgraded = await a.upgrade(bundle);
  assert.equal(upgraded.storage, a.receipt.storage);
  assert.equal(upgraded.engine, b.receipt.engine);
  assert.notEqual(upgraded.release, a.receipt.release);
  assert.notEqual(upgraded.ontology.digest, b.receipt.ontology.digest);
  assert.deepEqual(await b.cli('verify', b.runtimeURL.href), b.receipt);
  assert.equal((await homes(b))[0].properties.address, '乙环境合成住宅');
  t.diagnostic(
    JSON.stringify({
      engine: release.engine,
      ontology: release.ontology,
      storage: [a.receipt.storage, b.receipt.storage],
      tasks: [qa.id, qb.id],
      pa: ['declined', 'synthetic quote completed'],
      realSupplierWrites: 0,
      projections: [a.receipt.projection, b.receipt.projection],
      upgradedOnlyFirst: upgraded.ontology.version,
      native: release.native,
    }),
  );
});
