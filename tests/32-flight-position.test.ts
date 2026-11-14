import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { aviationEndpoint } from '../packages/capabilities/flight/variflight.js';
import { readConfig } from '../packages/core/config.js';
import { flightPositionResult } from '../packages/ontology/flight-position.js';
import { flightWatchRead } from '../packages/ontology/flight.js';
import { memberGrants, setGrants } from '../packages/runtime/access.js';
import { ScheduledActions, ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';
import { fixture, principal } from './fixture.js';

test('Ontology MCP queries FR24 and schedules flight watches with either or both authorized sources', async () => {
  const f = await fixture(), dir = await realpath(await mkdtemp(join(tmpdir(), 'eigos-fr24-')));
  const keyFile = join(dir, 'key'), connection = join(dir, 'connection.json');
  const packageDir = join(dir, 'node_modules', '@flightradar24', 'fr24api-mcp');
  const entrypoint = join(packageDir, 'build', 'index.js');
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@flightradar24/fr24api-mcp', version: '1.0.2', type: 'module',
  }));
  const bind = async (path: string, keyPath: string, key: string) => {
    await writeFile(keyPath, key, { mode: 0o600 });
    await writeFile(path, JSON.stringify({
      owner: principal.owner, active: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      keyFile: keyPath, keySha256: createHash('sha256').update(key).digest('hex'),
    }), { mode: 0o600 });
  };
  const key = 'synthetic-fr24-api-key', variKey = 'synthetic-variflight-key';
  const variConnection = join(dir, 'vari-connection.json');
  await bind(connection, keyFile, key);
  await bind(variConnection, join(dir, 'vari-key'), variKey);
  const modeFile = join(dir, 'mode'), callFile = join(dir, 'calls');
  await writeFile(modeFile, 'tracked');
  await writeFile(entrypoint, String.raw`
    import { createInterface } from 'node:readline';
    import { appendFileSync, readFileSync } from 'node:fs';
    const modeFile = ${JSON.stringify(modeFile)}, callFile = ${JSON.stringify(callFile)};
    if (process.env.FR24_API_KEY !== 'synthetic-fr24-api-key' || process.env.DATABASE_URL) process.exit(2);
    for await (const line of createInterface({ input: process.stdin })) {
      const req = JSON.parse(line);
      if (req.id === undefined) continue;
      if (req.method === 'initialize') {
        console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {
          protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Flightradar24 Gateway', version: '1.0.2' },
        }}));
        continue;
      }
      if (req.method !== 'tools/call' || req.params.name !== 'get_live_flights_positions_full' ||
          JSON.stringify(req.params.arguments) !== '{"flights":"MU5102","limit":8}') process.exit(3);
      appendFileSync(callFile, '1');
      const mode = readFileSync(modeFile, 'utf8');
      const match = { fr24_id: 'f001a001', flight: 'MU5102', orig_iata: 'PEK', dest_iata: 'SHA',
        callsign: 'CES5102', lat: 34.2, lon: 120.2, alt: 30000, gspeed: 420, eta: null,
        timestamp: new Date().toISOString(), source: 'ADSB' };
      const flights = [ { ...match, fr24_id: 'f001a002', orig_iata: 'PKX' },
        { ...match, fr24_id: 'f001a003', timestamp: new Date(Date.now() - 3600000).toISOString() },
        { ...match, fr24_id: 'f001a004', flight: 'MU5103' } ];
      if (mode === 'tracked' || mode === 'ambiguous') flights.push(match);
      if (mode === 'ambiguous') flights.push({ ...match, fr24_id: 'f001a005' });
      console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {
        isError: mode === 'unavailable',
        content: [{ type: 'text', text: 'Found ' + flights.length + ' flights (full details):' + String.fromCharCode(10) + JSON.stringify(flights) }],
      }}));
    }
  `);
  const flight = { flightNumber: 'MU5102', origin: 'PEK', destination: 'SHA', departureDate: '2026-11-15' };
  let variCalls = 0, available = true;
  const variFlightFetch: typeof fetch = async (target, init) => {
    assert.equal(String(target), aviationEndpoint);
    assert.equal(new Headers(init?.headers).get('X-API-Key'), variKey);
    if (init?.method !== 'POST') return new Response(null, { status: init?.method === 'GET' ? 405 : 200 });
    const packet = JSON.parse(String(init.body));
    const result = (value: unknown) => Response.json({ jsonrpc: '2.0', id: packet.id, result: value });
    if (packet.method === 'initialize') return result({
      protocolVersion: packet.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-aviation', version: '1' },
    });
    if (packet.method === 'notifications/initialized') return new Response(null, { status: 202 });
    variCalls++;
    assert.equal(packet.params.name, 'searchFlightsByNumber');
    assert.deepEqual(packet.params.arguments, { fnum: flight.flightNumber, date: flight.departureDate, dep: flight.origin, arr: flight.destination });
    return result({ isError: !available, structuredContent: {
      code: 200, timestamp: new Date().toISOString(), data: [{
        FlightNo: flight.flightNumber, FlightDepcode: flight.origin, FlightArrcode: flight.destination,
        FlightDeptimePlanDate: flight.departureDate + ' 08:00:00', org_timezone: '28800', FlightStateNum: 4,
      }],
    } });
  };
  const token = 'fr24-ontology-test-'.repeat(4);
  const cfg = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token,
    EIGOS_FR24_CONNECTION_FILE: connection, EIGOS_FR24_MCP_ENTRYPOINT: entrypoint, EIGOS_VARIFLIGHT_CONNECTION_FILE: variConnection });
  const capabilities = createCapabilities(f.db, f.source, {}, undefined, undefined, {
    fr24: connection, fr24Entrypoint: entrypoint, variFlight: variConnection, variFlightFetch,
  });
  const worker = new Worker(f.tasks, f.agent, new ScheduledActions(f.db),
    new ScheduledActionRunner(f.db, f.metadata, f.tasks, capabilities.actions));
  const server = createApp(cfg, f.db, f.source, undefined, {}, { variFlightFetch }).app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'eigos-fr24-test', version: '1' });
  try {
    const addr = server.address();
    assert(addr && typeof addr !== 'string');
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + addr.port + '/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const tool = (input: Record<string, unknown>) => client.callTool({
      name: 'evaluate_ontology', arguments: { function: 'readLiveFlightPosition', input },
    });
    const result = await tool({ flightNumber: 'MU5102', origin: 'PEK', destination: 'SHA' });
    assert(!result.isError, JSON.stringify(result.content));
    const parsed = flightPositionResult.parse(JSON.parse((result.content[0] as {text: string}).text));
    assert.equal(parsed.positions.length, 1);
    assert.equal(parsed.positions[0]?.coordinateSystem, 'wgs84');
    assert.equal(parsed.positions[0]?.trackingId, 'f001a001');
    assert.equal(parsed.positions[0]?.estimatedArrivalAt, null);
    assert(!JSON.stringify(result).includes(key));
    assert.equal((await tool({ flightNumber: '' })).isError, true);
    const count = async () => (await f.db.query('SELECT count(*)::int n FROM ' + f.db.schema + '.tasks')).rows[0]?.n;
    assert.equal(await count(), 0);

    const call = async (name: string, args: Record<string, unknown>) => {
      const out = await client.callTool({ name, arguments: args });
      const value = (out.content[0] as { text: string }).text;
      if (out.isError) throw new Error(value);
      return JSON.parse(value);
    };
    const apply = (action: string, requestId: string, input: Record<string, unknown>) =>
      call('apply_ontology_action', { action, requestId, input });
    const grants = memberGrants(f.model);
    const revokeSource = async (provider: string) => setGrants(f.db, principal.owner,
      grants.filter(grant => grant.resource !== 'Eigos/source/' + provider));
    const settings = { ...flight, monitorUntil: new Date(Date.now() + 60 * 60000).toISOString(), maxChecks: 3 };
    const sample = (watch: unknown) => call('evaluate_ontology', { function: 'readFlightWatch', input: { watch } }).then(data => flightWatchRead.parse(data));
    const runNext = async (watch: unknown) => {
      await f.db.query("UPDATE " + f.db.schema + ".tasks SET available_at=now()-interval '1 second' WHERE state='submitted'");
      assert(await worker.runOne());
      return sample(watch);
    };
    const fr24Calls = async () => (await readFile(callFile, 'utf8')).length;

    await revokeSource('VariFlight');
    await assert.rejects(apply('StartFlightWatch', 'both-denied', { ...settings, sources: ['VariFlight', 'Flightradar24'] }), /read_source/);
    assert.equal(await count(), 0);
    const positionWatch = await apply('StartFlightWatch', 'fr24-only', { ...settings, sources: ['Flightradar24'] });
    await assert.rejects(apply('RefreshFlightWatch', 'manual-refresh', { watch: positionWatch }), /original scheduled/);
    assert.equal((await sample(positionWatch)).liveTracking?.state, 'pending');
    const position = await runNext(positionWatch);
    assert.equal(position.state, 'monitoring');
    assert.equal(position.liveTracking?.state, 'tracked');
    assert.equal(position.status, null);
    assert.equal(position.alert, null);
    assert.equal(variCalls, 0);
    await writeFile(modeFile, 'no_match');
    const missing = await runNext(positionWatch);
    assert.equal(missing.state, 'unavailable');
    assert.equal(missing.liveTracking?.state, 'no_match');
    assert(missing.nextCheckAt);
    await writeFile(modeFile, 'ambiguous');
    const exhausted = await runNext(positionWatch);
    assert.equal(exhausted.liveTracking?.state, 'ambiguous');
    assert.equal(exhausted.reason, 'check_limit');
    assert.equal(exhausted.state, 'ended');
    assert.equal(exhausted.checks, 3);
    assert.equal(exhausted.nextCheckAt, null);
    assert.equal(await fr24Calls(), 4);
    assert.equal(await worker.runOne(), false);

    await setGrants(f.db, principal.owner, grants);
    await writeFile(modeFile, 'tracked');
    const bothSettings = { ...settings, maxChecks: 5, sources: ['Flightradar24', 'VariFlight'] };
    const both = await apply('StartFlightWatch', 'both', bothSettings);
    assert.deepEqual(await apply('StartFlightWatch', 'both-reversed', { ...bothSettings, sources: bothSettings.sources.toReversed() }), both);
    const started = await runNext(both);
    assert.deepEqual(started.sources, ['VariFlight', 'Flightradar24']);
    assert.equal(started.liveTracking?.state, 'tracked');
    assert.equal(started.status?.status, 'delayed');
    assert.equal(started.alert?.flight.status, 'delayed');
    assert.equal(await fr24Calls(), 5);
    assert.equal(variCalls, 1);
    const saved = (await f.db.query('SELECT properties FROM ' + f.db.schema + '.objects WHERE id=$1', [both.id])).rows[0]?.properties;
    assert.deepEqual(Object.keys(saved.liveTracking).sort(), ['authorityId', 'checkedAt', 'provider', 'state']);

    await writeFile(modeFile, 'unavailable');
    const airDataUnavailable = await runNext(both);
    assert.equal(airDataUnavailable.state, 'monitoring');
    assert.equal(airDataUnavailable.liveTracking?.state, 'source_unavailable');
    assert.equal(airDataUnavailable.status?.status, 'delayed');

    available = false;
    await writeFile(modeFile, 'tracked');
    const statusUnavailable = await runNext(both);
    assert.equal(statusUnavailable.state, 'monitoring');
    assert.equal(statusUnavailable.liveTracking?.state, 'tracked');
    assert.equal(statusUnavailable.observedAt, airDataUnavailable.observedAt);
    await revokeSource('VariFlight');
    assert.equal((await sample(both)).status, null);
    const airOnly = await runNext(both);
    assert.equal(airOnly.liveTracking?.state, 'tracked');
    assert.equal(airOnly.status, null);
    assert.equal(airOnly.alert, null);
    assert.equal(variCalls, 3);
    assert.equal(await fr24Calls(), 8);
    assert(airOnly.nextCheckAt);
    await apply('CancelFlightWatch', 'cancel-both', { watch: both });
    assert.equal((await sample(both)).state, 'cancelled');
    assert.equal(await worker.runOne(), false);

    await rm(connection);
    const blocked = await tool({ flightNumber: 'MU5102' });
    assert(blocked.isError);
    assert.match(JSON.stringify(blocked.content), /尚未配置有效的 Flightradar24/);
  } finally {
    worker.stop();
    await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    await f.close();
  }
});
