import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { digest, SourceReadFailure } from '../packages/core/identity.js';
import { quoteFunctionName, quoteObjectType, quoteSourceName, withSparedQuotePilot } from '../packages/ontology/spared-quote.js';
import { appName, normalizeSparedQuote } from '../packages/capabilities/spared-quote/pilot.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { loadExtensions } from '../packages/runtime/extensions.js';
import { document, fixture } from './fixture.js';
import { sparedHost } from './spared-quote-host.js';

const first = { owner: 'synthetic-alpha', quote: { label: ' 城区试点一 ', price: '￥73.05元' }, name: '城区试点一', amount: '7305' };
const second = { owner: 'synthetic-beta', quote: { label: ' 城区试点二 ', price: '94.5' }, name: '城区试点二', amount: '9450' };
const quoteId = 'sample-quote';
const observedAt = '2026-01-01T00:00:00.000Z';
const bin = process.env.EIGOS_TEST_SPARED_BIN, artifact = process.env.EIGOS_TEST_SPARED_WASM;

test('checksummed Wasm normalizes through a published Function and independently reads owner-scoped source evidence', {
  skip: !bin && !artifact ? 'Set EIGOS_TEST_SPARED_BIN and EIGOS_TEST_SPARED_WASM or run the spared pilot setup' : false,
}, async () => {
  assert(bin && artifact, 'Both spared test artifacts are required');
  const host = await sparedHost(bin, artifact), owners = [first, second];
  const names = owners.map(({ owner }) => appName(host.wasmSha256, owner));
  const configDirectory = await mkdtemp(join(tmpdir(), 'eigos-spared-config-'));
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let gateway: ReturnType<ReturnType<typeof createApp>['app']['listen']> | undefined;
  const previousConfig = process.env.EIGOS_SPARED_QUOTE_CONFIG_FILE;
  try {
    await host.start();
    await host.deploy(names[0]!);
    assert.equal((await host.deploy(names[1]!)).component_reused, true);
    await assert.rejects(normalizeSparedQuote(host.port, names[0]!, { label: 'test', price: '100-120元' }, AbortSignal.timeout(2000)));

    const file = join(configDirectory, 'fixtures.json');
    await writeFile(file, JSON.stringify({ port: host.port, wasmSha256: host.wasmSha256,
      owners: owners.map(({ owner, quote }) => ({ owner, quotes: { [quoteId]: { quote, observedAt } } })),
    }), { mode: 0o600 });
    process.env.EIGOS_SPARED_QUOTE_CONFIG_FILE = file;
    const extensions = await loadExtensions(join(import.meta.dirname, '../packages/capabilities/spared-quote/extension.ts'));
    assert.equal(extensions.functions?.[0]?.implementationId, 'spared-quote:sha256:' + host.wasmSha256);
    f = await fixture(undefined, undefined, undefined, withSparedQuotePilot(document), undefined, extensions, { sandbox: true });
    const active = f, grants = businessGrants(active.model, true);
    for (const { owner } of owners) await setGrants(active.db, owner, grants);
    const principal = (owner: string) => ({ owner, scopes: ['ontology:read'] });
    const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development',
      EIGOS_DEV_TOKEN: 'synthetic-spared-pilot-' + '0'.repeat(64), EIGOS_AGENT_SANDBOX_ENABLED: 'true' });
    gateway = createApp(config, active.db, active.source, async owner => {
      if (!owners.some(fixture => fixture.owner === owner)) throw new Error('Unknown synthetic principal');
      return principal(owner);
    }, extensions).app.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    assert(address && typeof address === 'object');
    const post = (owner: string, operation: string, body: object) => fetch('http://127.0.0.1:' + address.port + '/ontology/' + operation, {
      method: 'POST', headers: { Authorization: 'Bearer ' + owner, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const input = { quoteId };
    const call = (owner: string, params: object = input) => post(owner, 'functions', { function: quoteFunctionName, input: params });
    const refresh = async (owner: string) => active.capabilities.sources.refresh(active.model, quoteSourceName, input,
      await Access.load(active.db, principal(owner)), undefined, undefined, AbortSignal.timeout(5000));
    const read = async (owner: string, query: object) => {
      const response = await post(owner, 'query', { query });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).items;
    };
    const [left, right] = await Promise.all(owners.map(async ({ owner, name, amount, quote }) => {
      const response = await call(owner);
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.deepEqual(result.quote, { name, amountMinor: amount, currency: 'CNY' });
      assert.equal(result.evidence, 'synthetic');
      const projected = await refresh(owner);
      assert.equal(projected.receipt.id, result.receipt.id);
      assert.deepEqual(await refresh(owner), projected);
      const quotations = await read(owner, { type: quoteObjectType });
      assert.equal(quotations.length, 1);
      assert.deepEqual(quotations[0].properties, { id: projected.objects[0]!.id, quoteId, name, amountMinor: amount,
        currency: 'CNY', observedAt, evidence: 'synthetic' });
      const receipts = await read(owner, { type: 'SourceReceipt', from: { object: projected.objects[0], link: 'source' } });
      assert.equal(receipts.length, 1);
      assert.deepEqual(receipts[0].ref, projected.receipt);
      assert.equal(receipts[0].properties.contentDigest, digest(quote));
      assert.equal(receipts[0].properties.evidence, 'fixture');
      return projected;
    }));
    assert.notEqual(left!.receipt.id, right!.receipt.id);
    assert.deepEqual(await read(first.owner, { type: quoteObjectType, where: { id: right!.objects[0]!.id } }), []);
    assert.equal((await call(first.owner, { quoteId, owner: second.owner })).status, 400);
    assert.equal((await call(first.owner, { quoteId: 'other-quote' })).status, 404);

    await host.stop();
    const [alphaData, betaData] = await host.databases(names);
    assert(alphaData!.includes(Buffer.from(first.name)) && !alphaData!.includes(Buffer.from(second.name)));
    assert(betaData!.includes(Buffer.from(second.name)) && !betaData!.includes(Buffer.from(first.name)));
    assert.equal((await call(first.owner)).status, 502);
    await assert.rejects(refresh(first.owner), SourceReadFailure);
    assert.equal((await read(first.owner, { type: quoteObjectType })).length, 1);
    await host.start();
    assert.equal((await call(first.owner)).status, 200);

    await setGrants(active.db, first.owner, grants.filter(grant => grant.permission !== 'read_source'));
    assert.equal((await call(first.owner)).status, 403);
    await assert.rejects(refresh(first.owner), /Permission required/);
    assert.equal((await call(second.owner)).status, 200);
  } finally {
    if (previousConfig === undefined) delete process.env.EIGOS_SPARED_QUOTE_CONFIG_FILE;
    else process.env.EIGOS_SPARED_QUOTE_CONFIG_FILE = previousConfig;
    if (gateway) await new Promise<void>(resolve => gateway!.close(() => resolve()));
    try { await f?.close(); } finally {
      await host.close();
      await rm(configDirectory, { recursive: true, force: true });
    }
  }
});
