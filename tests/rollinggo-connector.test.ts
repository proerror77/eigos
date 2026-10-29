import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RollingGoSearchConnector } from '../packages/capabilities/rollinggo/connector.js';

const key = 'mcp_synthetic_fixture_key';
const input = {
  originQuery: 'Taipei hotel',
  place: 'Taipei Taiwan',
  placeType: 'city',
  checkInParam: { checkInDate: '2099-01-01', stayNights: 1, adultCount: 2 },
  localeParam: { currency: 'USD', language: 'en' },
  size: 3,
} as const;
test('only sends hotel search and returns bounded source facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollinggo-')),
    path = join(dir, 'key');
  writeFileSync(path, key, { mode: 0o600 });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_target, init = {}) => {
    if (init.method === 'GET') return new Response(null, { status: 405 });
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    const request = JSON.parse(String(init.body));
    calls.push(
      request.method === 'tools/call' ? request.params.name : request.method,
    );
    if (request.method.startsWith('notifications/'))
      return new Response(null, { status: 202 });
    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  hotelInformationList: [
                    {
                      hotelId: 1,
                      name: 'Fixture hotel',
                      price: {
                        hasPrice: true,
                        currency: 'USD',
                        lowestPrice: 80,
                      },
                    },
                  ],
                }),
              },
            ],
          };
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const connector = new RollingGoSearchConnector(
      path,
      createHash('sha256').update(key).digest('hex'),
      fetcher,
    );
    const result = await connector.search(input, new AbortController().signal);
    assert.equal(result.hotels[0]?.name, 'Fixture hotel');
    assert.equal(result.priceKind, 'reference');
    assert.deepEqual(
      calls.filter((x) => x === 'searchHotels'),
      ['searchHotels'],
    );
    await assert.rejects(
      connector.search({ ...input, size: 11 }, new AbortController().signal),
    );
    chmodSync(path, 0o644);
    await assert.rejects(connector.search(input, new AbortController().signal));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
