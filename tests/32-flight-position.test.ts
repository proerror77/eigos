import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { flightPositionResult } from '../packages/ontology/flight-position.js';
import { fixture, principal } from './fixture.js';

test('Ontology MCP performs a bounded FR24 flight position query and validates matching current observations', async () => {
  const f = await fixture(), dir = await realpath(await mkdtemp(join(tmpdir(), 'eigos-fr24-')));
  const keyFile = join(dir, 'key'), connection = join(dir, 'connection.json');
  const packageDir = join(dir, 'node_modules', '@flightradar24', 'fr24api-mcp');
  const entrypoint = join(packageDir, 'build', 'index.js');
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@flightradar24/fr24api-mcp', version: '1.0.2', type: 'module',
  }));
  const key = 'synthetic-fr24-api-key';
  await writeFile(keyFile, key, { mode: 0o600 });
  await writeFile(connection, JSON.stringify({
    owner: principal.owner, active: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), keyFile,
    keySha256: createHash('sha256').update(key).digest('hex'),
  }), { mode: 0o600 });
  await writeFile(entrypoint, String.raw`
    import { createInterface } from 'node:readline';
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
      const match = { fr24_id: 'f001a001', flight: 'MU5102', orig_iata: 'PEK', dest_iata: 'SHA',
        callsign: 'CES5102', lat: 34.2, lon: 120.2, alt: 30000, gspeed: 420, eta: null,
        timestamp: new Date().toISOString(), source: 'ADSB' };
      const flights = [ match, { ...match, fr24_id: 'f001a002', orig_iata: 'PKX' },
        { ...match, fr24_id: 'f001a003', timestamp: new Date(Date.now() - 3600000).toISOString() },
        { ...match, fr24_id: 'f001a004', flight: 'MU5103' } ];
      console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {
        content: [{ type: 'text', text: 'Found 4 flights (full details):' + String.fromCharCode(10) + JSON.stringify(flights) }],
      }}));
    }
  `);
  const token = 'fr24-ontology-test-'.repeat(4);
  const cfg = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token,
    EIGOS_FR24_CONNECTION_FILE: connection, EIGOS_FR24_MCP_ENTRYPOINT: entrypoint });
  const server = createApp(cfg, f.db, f.source).app.listen(0, '127.0.0.1');
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
    await rm(connection);
    const blocked = await tool({ flightNumber: 'MU5102' });
    assert(blocked.isError);
    assert.match(JSON.stringify(blocked.content), /尚未配置有效的 Flightradar24/);
    const count = await f.db.query('SELECT count(*)::int n FROM ' + f.db.schema + '.tasks');
    assert.equal(count.rows[0]?.n, 0);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    await f.close();
  }
});
