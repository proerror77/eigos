import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { configuredServices } from '../packages/capabilities/services/sources.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

test('Taobao and JD search and buyer handoff Actions work on the published Gateway MCP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-marketplace-'));
  const connectionFile = join(directory, 'bindings.json');
  const appSecret = 'synthetic-app-secret';
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const bindings = await Promise.all((['Taobao', 'JD'] as const).map(async provider => {
    const credential = JSON.stringify({ appKey: '12345', appSecret, ...(provider === 'Taobao' ? { adzoneId: '123456' } : {}) });
    const credentialFile = join(directory, provider);
    await writeFile(credentialFile, credential, { mode: 0o600 });
    return {
      provider, owner: principal.owner, bindingId: 'synthetic-' + provider, active: true, expiresAt,
      credentialFile, credentialSha256: createHash('sha256').update(credential).digest('hex'),
    };
  }));
  await writeFile(connectionFile, JSON.stringify(bindings), { mode: 0o600 });

  const calls: string[] = [];
  let taobaoPrice = '32.50', taobaoLink = '//item.taobao.com/item.htm?id=556633720749';
  let jdError = false;
  const transport: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.body instanceof URLSearchParams);
    const params = new URLSearchParams(init.body);
    const sign = params.get('sign');
    params.delete('sign');
    params.sort();
    assert.equal(sign, createHash('md5').update(appSecret + [...params].map(([k, v]) => k + v).join('') + appSecret)
      .digest('hex').toUpperCase());
    assert.equal(params.get('app_key'), '12345');
    assert.match(params.get('timestamp')!, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    if (String(url) === 'https://eco.taobao.com/router/rest') {
      assert.equal(params.get('method'), 'taobao.tbk.dg.material.optional.upgrade');
      assert.equal(params.get('q'), '折叠雨伞');
      assert.equal(params.get('adzone_id'), '123456');
      assert.equal(params.get('biz_scene_id'), '2');
      assert.equal(params.get('page_size'), '5');
      return Response.json({ tbk_dg_material_optional_upgrade_response: { total_results: 1, result_list: { map_data: [{
        item_id: 'opaque-item-example', item_basic_info: { title: '淘宝测试雨伞', shop_title: '测试店' },
        price_promotion_info: { zk_final_price: taobaoPrice, final_promotion_price: '1.00' },
        publish_info: { click_url: taobaoLink },
      }] } } });
    }
    assert.equal(String(url), 'https://api.jd.com/routerjson');
    assert.equal(params.get('method'), 'jd.union.open.goods.query');
    assert.deepEqual(JSON.parse(params.get('360buy_param_json')!), {
      goodsReqDTO: { keyword: '折叠雨伞', pageIndex: 1, pageSize: 5 },
    });
    const queryResult = jdError ? '{"code":403,"message":"not authorized"}'
      : '{"code":200,"data":[{"skuId":90071992547409931,"skuName":"京东测试雨伞",'
      + '"priceInfo":{"price":42.2,"lowestCouponPrice":1},'
      + '"materialUrl":"item.jd.com/90071992547409931.html"}]}';
    return Response.json({ jd_union_open_goods_query_responce: { code: '0', queryResult } });
  };

  const services = configuredServices(connectionFile, undefined, transport);
  const f = await fixture(undefined, services);
  const token = 'marketplace-local-fixture-token-at-least-32';
  const config = readConfig({
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development',
    EIGOS_DEV_TOKEN: token, EIGOS_SERVICE_CONNECTION_FILE: connectionFile,
  });
  const gateway = createApp(config, f.db, f.source, undefined, {}, { marketplaceFetch: transport });
  const server = gateway.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const invoke = async <T>(name: string, args: unknown): Promise<T> => {
      const response = await fetch('http://127.0.0.1:' + address.port + '/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      assert.equal(response.status, 200);
      const { result } = await response.json();
      assert.notEqual(result?.isError, true, result?.content?.[0]?.text);
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    const apply = (action: string, input: unknown, requestId: string) =>
      invoke<ObjectRef>('apply_ontology_action', { requestId, action, input });
    const graph = new Objects(f.db, f.model, f.access);
    const query = { query: '折叠雨伞', country: 'CN' };
    await assert.rejects(services('other-owner', 'Taobao'), /no owner connection/);
    const grants = memberGrants(f.model);
    await setGrants(f.db, principal.owner, grants.filter(g => g.resource !== 'Eigos/source/JD'));
    const limited = await Access.load(f.db, principal);
    await assert.rejects(f.capabilities.actions.apply(limited, f.model, 'SearchJdProducts', query, 'no-source'), /Permission/);
    assert.deepEqual(calls, []);
    await setGrants(f.db, principal.owner, grants);
    const taobaoPage = await apply('SearchTaobaoProducts', query, 'taobao');
    const jdPage = await apply('SearchJdProducts', query, 'jd');
    assert.equal((await graph.read(taobaoPage)).properties.evidence, 'provider_mock');
    assert.equal((await graph.read(jdPage)).properties.complete, false);
    const items = (await graph.query({ type: 'MarketplaceProductOffer' })).items;
    const taobao = items.find(item => item.ref.type === 'TaobaoProductOffer')!;
    const jd = items.find(item => item.ref.type === 'JdProductOffer')!;
    assert.equal(taobao.properties.amountMinor, 3250);
    assert.equal(taobao.properties.priceKind, 'reference');
    assert.equal(taobao.properties.available, null);
    assert.equal(taobao.properties.variantId, undefined);
    assert.equal(jd.properties.amountMinor, 4220);
    assert.equal(jd.properties.variantId, '90071992547409931');

    const selected = { offer: taobao.ref };
    const handoff = await apply('PrepareTaobaoPurchase', selected, 'buyer');
    assert.deepEqual(await apply('PrepareTaobaoPurchase', selected, 'buyer'), handoff);
    const jdbuy = await apply('PrepareJdPurchase', { offer: jd.ref }, 'jd-buyer');
    const context = { principal, objects: graph, signal: AbortSignal.timeout(5000) };
    const read = (ref: typeof handoff) => f.capabilities.functions.invoke(f.model, 'readMarketplacePurchaseHandoff',
      { handoff: ref }, context) as Promise<Record<string, unknown>>;
    const returned = await invoke<{ url: string; status: string }>('evaluate_ontology',
      { function: 'readMarketplacePurchaseHandoff', input: { handoff } });
    assert.equal(returned.url, 'https://item.taobao.com/item.htm?id=556633720749');
    assert.equal(returned.status, 'awaiting_buyer');
    assert.equal((await read(jdbuy)).url, 'https://item.jd.com/90071992547409931.html');
    assert.equal(calls.length, 2);

    jdError = true;
    await assert.rejects(f.capabilities.actions.apply(f.access, f.model, 'SearchJdProducts', query, 'jd-denied'), /JD rejected/);
    assert.equal((await graph.query({ type: 'JdProductSearch' })).items.length, 1);
    taobaoPrice = '34.00';
    taobaoLink = 'https://item.taobao.com.attacker.invalid/item.htm?id=556633720749';
    await f.capabilities.actions.apply(f.access, f.model, 'SearchTaobaoProducts', query, 'taobao-refresh');
    await assert.rejects(read(handoff), /changed|verified product link/);
    await assert.rejects(f.capabilities.actions.apply(f.access, f.model, 'PrepareTaobaoPurchase', selected, 'no-link'),
      /verified product link/);
    assert.equal((await graph.read(taobao.ref)).properties.url, undefined);
    await writeFile(connectionFile, JSON.stringify(bindings.map(x => ({ ...x, active: false }))));
    await assert.rejects(read(jdbuy), /expired or was revoked/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
