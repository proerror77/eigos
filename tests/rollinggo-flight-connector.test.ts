import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RollingGoFlightConnector } from '../packages/capabilities/rollinggo-flight/connector.js';
import { flightInputSchema, parseFlightResponse, validateFlightDates, type FlightInput } from '../packages/capabilities/rollinggo-flight/contracts.js';
import { flightInput, flightData, airportData } from './fixtures/rollinggo-flight.js';
const key = 'mcp_synthetic_flight_key';

function fixture(raw: unknown, options: { status?: number; location?: string; rotate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flight-source-')), path = join(dir, 'key');
  writeFileSync(path, key, { mode: 0o600 });
  const calls: { name: string; args: unknown }[] = [];
  const fetcher: typeof fetch = async (target, init = {}) => {
    assert.equal(String(target), 'https://mcp.rollinggo.cn/mcp/flight');
    assert.equal(init.redirect, 'manual');
    if (options.status) return new Response(null, { status: options.status, headers: options.location ? { location: options.location } : {} });
    if (init.method === 'GET') return new Response(null, { status: 405 });
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    const rpc = JSON.parse(String(init.body));
    if (rpc.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    if (rpc.method === 'tools/call') {
      calls.push({ name: rpc.params.name, args: rpc.params.arguments });
      if (options.rotate) writeFileSync(path, 'mcp_rotated_fixture_key');
    }
    const result = rpc.method === 'initialize' ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { content: [{ type: 'text', text: JSON.stringify(raw) }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  return { path, calls, connector: new RollingGoFlightConnector(path, createHash('sha256').update(key).digest('hex'), fetcher), close: () => rmSync(dir, { recursive: true, force: true }) };
}
const signal = () => new AbortController().signal;
const flightEnvelope = () => ({ success: true, flightInformationList: flightData.kind === 'flights' ? flightData.flights : [] });

test('sends only the exact read tool and parameters for airports, one way and round trip', async () => {
  const cases: { input: FlightInput; raw: unknown; tool: string }[] = [
    { input: { kind: 'airports', keyword: 'Hangzhou' }, raw: { success: true, airPortInformationList: airportData.kind === 'airports' ? airportData.airports : [] }, tool: 'searchAirports' },
    { input: flightInput, raw: flightEnvelope(), tool: 'searchFlights' },
    { input: { ...flightInput, kind: 'flights', tripType: 'ROUND_TRIP', retDate: '2099-01-05' }, raw: { success: true, flightInformationList: [{ ...(flightData.kind === 'flights' ? flightData.flights[0] : {}), retSegments: [{ flightNumber: 'ZZ102', depAirport: 'PEK', arrAirport: 'PVG', depTime: '2099-01-05T08:00:00', arrTime: '2099-01-05T10:00:00' }] }] }, tool: 'searchFlights' },
  ];
  for (const item of cases) {
    const f = fixture(item.raw);
    try {
      const value = await f.connector.search(item.input, signal());
      assert.equal(value.data.kind, item.input.kind);
      const { kind: _, ...args } = item.input;
      assert.deepEqual(f.calls, [{ name: item.tool, args }]);
      assert.ok(!JSON.stringify(value).includes(key));
    } finally { f.close(); }
  }
});

for (const [name, raw] of [
  ['upstream error', { success: false, flightInformationList: [] }],
  ['missing list', { success: true }],
  ['credential echo', { ...flightEnvelope(), debug: key }],
  ['wrong departure date', { success: true, flightInformationList: [{ fromSegments: [{ flightNumber: 'ZZ1', depAirport: 'PVG', arrAirport: 'PEK', depTime: '2098-01-01T08:00:00', arrTime: '2098-01-01T10:00:00' }] }] }],
] as const) test(`rejects ${name} without converting failure to no results`, async () => {
  const f = fixture(raw); try { await assert.rejects(f.connector.search(flightInput, signal()), /unavailable|rejected/); } finally { f.close(); }
});
for (const status of [401, 404, 302]) test(`fails closed on HTTP ${status}`, async () => {
  const f = fixture({}, { status, location: 'https://example.invalid/steal-key' });
  try { await assert.rejects(f.connector.search(flightInput, signal()), /unavailable/); assert.equal(f.calls.length, 0); } finally { f.close(); }
});
test('valid empty list is success; response excludes unsupported/private fields', () => {
  assert.deepEqual(parseFlightResponse(flightInput, { success: true, flightInformationList: [] }), { kind: 'flights', flights: [] });
  const raw = flightEnvelope();
  const result = parseFlightResponse(flightInput, { ...raw, paymentUrl: 'https://example.invalid', account: 'private' });
  assert.ok(!JSON.stringify(result).includes('paymentUrl'));
});
test('rejects invalid criteria before any source call', async () => {
  const f = fixture(flightEnvelope()); try {
    for (const value of [{ ...flightInput, tripType: 'ROUND_TRIP' }, { ...flightInput, retDate: '2099-01-05' }, { ...flightInput, adultNumber: 0 }, { ...flightInput, fromAirport: 'PVG' }])
      assert.equal(flightInputSchema.safeParse(value).success, false);
    for (const value of [{ ...flightInput, fromDate: '2020-01-01' }, { ...flightInput, adultNumber: 9, childNumber: 1 }, { ...flightInput, toCity: 'SHA' }]) {
      await assert.rejects(f.connector.search(value as FlightInput, signal()));
    }
    const c = new AbortController(); c.abort(); await assert.rejects(f.connector.search(flightInput, c.signal));
    assert.equal(f.calls.length, 0);
    validateFlightDates({ ...flightInput, kind: 'flights', fromDate: '2026-11-03' }, Date.parse('2026-11-02T18:00:00Z'));
    assert.throws(() => validateFlightDates({ ...flightInput, kind: 'flights', fromDate: '2026-11-02' }, Date.parse('2026-11-02T18:00:00Z')));
  } finally { f.close(); }
});
test('private file permissions, symlinks and key rotation invalidate the source', async () => {
  const f = fixture(flightEnvelope(), { rotate: true }); try {
    await assert.rejects(f.connector.search(flightInput, signal()));
    writeFileSync(f.path, key); chmodSync(f.path, 0o644); await assert.rejects(f.connector.search(flightInput, signal()));
    chmodSync(f.path, 0o600); symlinkSync(f.path, f.path + '.link');
    await assert.rejects(new RollingGoFlightConnector(f.path + '.link', createHash('sha256').update(key).digest('hex')).search(flightInput, signal()));
  } finally { f.close(); }
});
