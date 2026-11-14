import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { aviationEndpoint } from '../packages/capabilities/flight/variflight.js';
import { readConfig } from '../packages/core/config.js';
import { flightStatusRead, flightWatchRead } from '../packages/ontology/flight.js';
import { ScheduledActions, ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';
import { fixture, principal } from './fixture.js';

test('MCP looks up the supplier flight directly, and the original scheduled Action records only material changes', async () => {
  const f = await fixture(), dir = await mkdtemp(join(tmpdir(), 'eigos-flight-'));
  const key = 'synthetic-variflight-key', keyFile = join(dir, 'key'), config = join(dir, 'connection.json');
  await writeFile(keyFile, key, { mode: 0o600 });
  await writeFile(config, JSON.stringify({
    owner: principal.owner, active: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), keyFile,
    keySha256: createHash('sha256').update(key).digest('hex'),
  }), { mode: 0o600 });
  const date = '2026-11-15', flight = { flightNumber: 'MU5102', departureDate: date, origin: 'PEK', destination: 'SHA' };
  let calls = 0, gate = 'A6', code = 0, estimated = '2026-11-15 08:00:00', malicious = false;
  const provider: typeof fetch = async (target, init) => {
    assert.equal(String(target), aviationEndpoint);
    assert.equal(new Headers(init?.headers).get('X-API-Key'), key);
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    const packet = JSON.parse(String(init?.body));
    const result = (value: unknown) => Response.json({ jsonrpc: '2.0', id: packet.id, result: value });
    if (packet.method === 'initialize') return result({
      protocolVersion: packet.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-aviation', version: '1' },
    });
    if (packet.method === 'notifications/initialized') return new Response(null, { status: 202 });
    calls++;
    assert.equal(packet.method, 'tools/call');
    assert.equal(packet.params.name, 'searchFlightsByNumber');
    assert.deepEqual(packet.params.arguments, { fnum: 'MU5102', date, dep: 'PEK', arr: 'SHA' });
    const stamp = new Date(Date.now()).toISOString();
    const text = malicious ? "Flight details: {'code': 200, 'data': make_untrusted_value()}" :
      "Flight details: {'code': 200, 'data': [{'FlightNo': 'MU5102', 'FlightCompany': \"O'Air\", " +
      "'FlightDepcode': 'PEK', 'FlightArrcode': 'SHA', 'FlightDeptimePlanDate': '2026-11-15 08:00:00', " +
      "'FlightArrtimePlanDate': '2026-11-15 10:15:00', 'FlightDeptimeReadyDate': '" + estimated + "', " +
      "'BoardGate': '" + gate + "', 'FlightHTerminal': 'T2', 'FlightTerminal': 'T2', 'org_timezone': '28800', " +
      "'dst_timezone': '28800', 'FlightStateNum': " + code + ", 'FillFlightInfo': None}], 'timestamp': '" + stamp + "'}";
    return result({ content: [{ type: 'text', text }] });
  };
  const token = 'flight-onto-eigos-test-'.repeat(3);
  const cfg = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token,
    EIGOS_VARIFLIGHT_CONNECTION_FILE: config });
  const gateway = createApp(cfg, f.db, f.source, undefined, {}, { variFlightFetch: provider });
  const capabilities = createCapabilities(f.db, f.source, {}, undefined, undefined, { variFlight: config, variFlightFetch: provider });
  const schedules = new ScheduledActions(f.db);
  const worker = new Worker(f.tasks, f.agent, schedules, new ScheduledActionRunner(f.db, f.metadata, f.tasks, capabilities.actions));
  const server = gateway.app.listen(0, '127.0.0.1');
  const mcp = new Client({ name: 'eigos-flight-test', version: '1' });
  await once(server, 'listening');
  try {
    const addr = server.address();
    assert(addr && typeof addr !== 'string');
    await mcp.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + addr.port + '/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const out = await mcp.callTool({ name, arguments: args });
      const value = (out.content[0] as { text: string }).text;
      if (out.isError) throw new Error(value);
      return JSON.parse(value);
    };
    const evaluate = (name: string, input: Record<string, unknown>) => call('evaluate_ontology', { function: name, input });
    const describe = await call('describe_ontology', {});
    assert(describe.functionTypes.some((fn: { apiName: string }) => fn.apiName === 'readFlightStatus'));
    const direct = flightStatusRead.parse(await evaluate('readFlightStatus', flight));
    assert.equal(direct.flights[0]?.gate, 'A6');
    assert.equal(direct.flights[0]?.carrier, "O'Air");
    assert.equal(direct.flights[0]?.scheduledDeparture, '2026-11-15T08:00:00+08:00');
    assert.equal(direct.flights[0]?.actualArrival, null);
    assert.equal((await worker.runOne()), false);
    malicious = true;
    await assert.rejects(evaluate('readFlightStatus', flight), /可验证的航班数据/);
    malicious = false;

    const apply = (action: string, requestId: string, input: Record<string, unknown>) =>
      call('apply_ontology_action', { action, requestId, input });
    const settings = { ...flight, monitorUntil: new Date(Date.now() + 37 * 60000).toISOString(), maxChecks: 5 };
    const watch = await apply('StartFlightWatch', 'flight-watch-1', settings);
    assert.deepEqual(await apply('StartFlightWatch', 'flight-watch-duplicate', settings), watch);
    const snapshot = async () => flightWatchRead.parse(await evaluate('readFlightWatch', { watch }));
    assert.equal((await snapshot()).state, 'pending');
    assert(await worker.runOne());
    const base = await snapshot();
    assert.equal(base.state, 'monitoring');
    assert.equal(base.alert, null);
    const { rows: [job] } = await f.db.query('SELECT task_id, id FROM ' + f.db.schema + '.scheduled_actions');
    const recheck = async () => {
      const due = await f.db.query("UPDATE " + f.db.schema + ".tasks SET available_at=now()-interval '1 second' WHERE id=$1 AND state='submitted'", [job!.task_id]);
      assert.equal(due.rowCount, 1);
      assert(await worker.runOne());
      return snapshot();
    };
    code = 4;
    gate = 'B12';
    estimated = '2026-11-15 08:30:00';
    const changed = await recheck();
    assert.deepEqual(changed.alert?.changes, ['status', 'departure_time', 'gate']);
    assert.equal(changed.alert?.flight.gate, 'B12');
    assert.deepEqual((await recheck()).alert, changed.alert);
    code = 3;
    const stopped = await recheck();
    assert.equal(stopped.state, 'completed');
    assert.equal(stopped.alert?.flight.status, 'cancelled');
    assert(stopped.alertVersion > changed.alertVersion);
    assert.equal(stopped.nextCheckAt, null);
    assert.equal(await worker.runOne(), false);
    await apply('CancelFlightWatch', 'flight-withdraw', { watch });
    assert.equal((await snapshot()).alert, null);
    assert.equal(calls, 6);
    const inventory = (await f.db.query('SELECT (SELECT count(*)::int FROM ' + f.db.schema + '.scenarios) scenarios, ' +
      '(SELECT count(*)::int FROM ' + f.db.schema + '.external_operations) operations')).rows[0];
    assert.deepEqual(inventory, { scenarios: 0, operations: 0 });
  } finally {
    worker.stop();
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    await f.close();
  }
});
