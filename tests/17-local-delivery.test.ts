import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { localDeliveryServices, type LocalDeliveryProvider } from '../packages/ontology/local-delivery.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { fixture, principal } from './fixture.js';

test('local delivery Actions retain only owner-bound search results and report listing and inventory evidence separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-local-delivery-'));
  const path = join(directory, 'bindings.json'), tokenFile = join(directory, 'host.token');
  const token = randomBytes(32).toString('base64url'), bearer = 'delivery-local-fixture-token-at-least-32';
  const port = 43815, addressRef = 'f'.repeat(64);
  const accounts = { taobao: '4ee50433-6d87-4adb-9775-9cda669c00d1', hema: 'e4da3d57-9284-4737-99e5-92299854ab37' };
  const productRef = '56f48383-6a87-4adb-9775-9cda669c00d1';
  const bindings = (['TaobaoInstantDelivery', 'Hema'] as const).map(provider => ({
    owner: principal.owner, provider, active: true, accountRef: accounts[localDeliveryServices[provider].platformId],
    port, tokenFile, tokenSha256: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }));
  await writeFile(tokenFile, token, { mode: 0o600 });
  const save = () => writeFile(path, JSON.stringify(bindings), { mode: 0o600 });
  await save();

  let hemaBlocked = false;
  const calls: string[] = [];
  const listed = { id: 'sku1', name: '鲜牛奶 950ml', price: '7.90', availability: 'unknown' };
  const provider = async (url: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(String(url), 'http://127.0.0.1:43815/host');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + token);
    const request = JSON.parse(String(init?.body));
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') return reply({
      protocolVersion: request.params.protocolVersion, serverInfo: { name: 'waimai-test', version: '1' }, capabilities: { tools: {} },
    });
    assert.equal(request.method, 'tools/call');
    const { name, arguments: args } = request.params;
    calls.push(name);
    const data = (value: unknown) => reply({ content: [{ type: 'text', text: JSON.stringify({ success: true, data: value }) }] });
    if (name === 'account_cross_search') {
      const { keyword, accounts: [owner] } = args;
      const hema = owner.platformId === 'hema';
      assert.deepEqual(args.accounts, [{ platformId: hema ? 'hema' : 'taobao', accountRef: accounts[hema ? 'hema' : 'taobao'] }]);
      if (hema && hemaBlocked) return data({ keyword, platforms: [{ ...owner, scope: 'unavailable', state: 'error', groups: [],
        error: { code: 'login-failed', message: '盒马要求人工验证，请在官方客户端完成后重试' } }] });
      return data({ keyword, platforms: [{ ...owner, scope: hema ? 'delivery-stores' : 'platform', state: hema ? 'ready' : 'partial', groups: [
        { shopId: hema ? 'store1' : 'platform', shopName: hema ? '盒马测试店' : '', addressRef, state: 'ready', hasMore: !hema,
          items: [hema ? { ...listed, priceUnit: '瓶', productRef, availability: 'available' }
            : { ...listed, shopId: 'store1', shopName: '闪购测试店', shopIsRetail: true }],
        },
      ] }] });
    }
    if (name === 'account_retail_resolve_search') {
      assert.deepEqual(args, { platformId: 'taobao', accountRef: accounts.taobao, addressRef, shopId: 'store1', itemId: 'sku1', keyword: '牛奶' });
      return reply({ isError: true, content: [{ type: 'text', text: '{"success":false,"code":"verification-required"}' }] });
    }
    if (name === 'account_product_detail') {
      assert.deepEqual(args, { platformId: 'hema', accountRef: accounts.hema, addressRef, productRef });
      return data({ platformId: 'hema', shopId: 'store1', addressRef, productRef, product: {
        id: 'sku1', available: true, variants: [{ name: '950ml', stockQuantity: 4, saleUnit: '瓶' }],
      } });
    }
    if (name === 'account_nearby_shops') {
      assert.deepEqual(args, { platformId: 'taobao', accountRef: accounts.taobao });
      return data({ platformId: 'taobao', scope: 'nearby-recommendations', nextCursor: null, shops: [{ id: 'store1', name: '闪购测试店' }] });
    }
    assert.equal(name, 'account_probe_menu');
    assert.deepEqual(args, { platformId: 'taobao', accountRef: accounts.taobao, shopId: 'store1' });
    return data({ platformId: 'taobao', shopId: 'store1', categories: [{ items: [listed] }] });
  };

  const f = await fixture();
  const config = readConfig({
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development',
    EIGOS_DEV_TOKEN: bearer, EIGOS_DSH_WAIMAI_CONNECTION_FILE: path,
  });
  const gateway = createApp(config, f.db, f.source, undefined, {}, { localDeliveryFetch: provider });
  const server = gateway.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const invoke = async (name: string, args: unknown) => {
      const response = await fetch('http://127.0.0.1:' + address.port + '/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const complete = async (providerName: LocalDeliveryProvider, input: unknown, id: string) => {
      const service = localDeliveryServices[providerName];
      const result = await invoke('complete_with_action', {
        requestId: id, action: { interface: { type: service.inquiry, implementation: service.object, action: 'search' }, input },
        read: { function: service.read, resultParameter: 'search' },
      });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const value = result.structuredContent ?? JSON.parse(result.content[0].text);
      const serialized = JSON.stringify(value);
      for (const secret of [token, addressRef, productRef, accounts.hema, accounts.taobao])
        assert.equal(serialized.includes(secret), false);
      return value;
    };
    const instant = await complete('TaobaoInstantDelivery', { query: '牛奶' }, 'instant');
    assert.deepEqual(instant.items[0], {
      merchantId: 'store1', merchantName: '闪购测试店', listedPriceMinor: 790, priceUnit: null, name: listed.name,
      stockQuantity: null, stockEvidence: 'verification_required', variants: [], availability: 'unknown',
    });
    assert.equal(instant.evidence, 'provider_mock');
    assert.equal(instant.complete, false);
    assert.deepEqual(await complete('TaobaoInstantDelivery', { query: '牛奶' }, 'instant'), instant);
    assert.deepEqual(calls, ['account_cross_search', 'account_retail_resolve_search']);

    const hema = await complete('Hema', { query: '牛奶' }, 'hema');
    assert.equal(hema.items[0].stockQuantity, 4);
    assert.equal(hema.items[0].stockEvidence, 'verified');
    assert.deepEqual(hema.items[0].variants, [{ name: '950ml', quantity: 4, saleUnit: '瓶' }]);
    hemaBlocked = true;
    const blocked = await complete('Hema', { query: '鸡蛋' }, 'hema-blocked');
    assert.equal(blocked.status, 'verification_required');
    assert.equal(blocked.complete, false);
    assert.deepEqual(blocked.items, []);

    const stores = await complete('TaobaoInstantDelivery', { mode: 'stores' }, 'stores');
    assert.deepEqual(stores.stores, [{ merchantId: 'store1', name: '闪购测试店' }]);
    const menu = await complete('TaobaoInstantDelivery', { mode: 'menu', merchantId: 'store1' }, 'menu');
    assert.equal(menu.items[0].listedPriceMinor, 790);
    assert.equal(menu.items[0].stockQuantity, null);

    const action = instant.search as ObjectRef;
    bindings[0]!.active = false;
    await save();
    const revoked = await invoke('evaluate_ontology', { function: 'readTaobaoInstantDeliverySearch', input: { search: action } });
    assert.equal(revoked.isError, true);
    assert.match(revoked.content[0].text, /active owner-bound/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
