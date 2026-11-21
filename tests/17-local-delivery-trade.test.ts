import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type LocalDeliveryProvider } from '../packages/ontology/local-delivery.js';
import { deliveryTradeServices } from '../packages/ontology/local-delivery-trade.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { fixture, principal } from './fixture.js';

test('buyer transactions require separate PA approvals, preserve unknown attempts and reconcile the original orders', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-delivery-trade-'));
  const paths = { TaobaoInstantDelivery: join(directory, 'taobao.json'), Hema: join(directory, 'hema.json') };
  const tokens = { taobao: randomBytes(32).toString('base64url'), hema: randomBytes(32).toString('base64url') };
  const refs = { taobao: randomUUID(), hema: randomUUID() };
  const variants = { meal: 'b'.repeat(64), hema: '821' }, addressRef = 'c'.repeat(64), shopId = 'store1';
  const cartVersion = { taobao: 'd'.repeat(64), hema: 'e'.repeat(64) };
  const quoteRef = { taobao: randomUUID(), hema: randomUUID() }, deliveryRef = randomUUID(), paymentRef = randomUUID();
  const orderIds = { taobao: '90071992547400001', hema: '90071992547400002' };
  const original = { taobao: false, hema: false };
  const mutations: string[] = [];
  let readbackUnavailable = false, delivered = false, independentlyPaid = false, cartChanged = false, hemaCartChanged = false, retailCartChanged = false, windowSelected = false;
  let retailVersion = 'f'.repeat(64);
  const hemaProduct = randomUUID(), retailProduct = randomUUID();
  for (const provider of ['TaobaoInstantDelivery', 'Hema'] as const) {
    const platform = provider === 'Hema' ? 'hema' : 'taobao';
    const tokenFile = join(directory, platform + '.token'), token = tokens[platform], port = platform === 'hema' ? 43816 : 43815;
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(paths[provider], JSON.stringify([{
      owner: principal.owner, provider, active: true, allowOrders: true, allowPayment: provider === 'TaobaoInstantDelivery',
      tokenFile, tokenSha256: createHash('sha256').update(token).digest('hex'), port,
      accountRef: refs[platform], expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }]), { mode: 0o600 });
  }

  const milk = { id: '129', name: '测试牛奶', quantity: '1', price: '15.00', selected: true, available: true };
  const hamburger = { ref: '1'.repeat(64), name: '测试汉堡', quantity: 1, priceCents: 1500, selected: true, available: true };
  const bound = (platformId: 'taobao' | 'hema') => ({ platformId, shopId, addressRef, revision: cartVersion[platformId] });
  const cart = (platformId: 'taobao' | 'hema') => ({
    ...bound(platformId), items: platformId === 'hema' ? (hemaCartChanged ? [milk] : []) : cartChanged ? [hamburger] : [],
  });
  const fetcher: typeof fetch = async (url, init) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:4381[56]\/host$/);
    const sourcePlatform = String(url).includes(':43816/') ? 'hema' : 'taobao';
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + tokens[sourcePlatform]);
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'initialize') return reply({
      protocolVersion: request.params.protocolVersion, serverInfo: { name: 'dsh-waimai-test', version: '1' }, capabilities: { tools: {} },
    });
    assert.equal(request.method, 'tools/call');
    const { name, arguments: args } = request.params;
    const platformId = args.platformId as 'taobao' | 'hema';
    assert.equal(name === 'account_cross_search' ? args.accounts[0].platformId : platformId, sourcePlatform);
    if (name !== 'account_cross_search') assert.equal(args.accountRef, refs[platformId]);
    const data = (value: unknown) => reply({ content: [{ type: 'text', text: JSON.stringify({ success: true, data: value }) }] });
    if (name === 'account_cross_search') {
      const owner = args.accounts[0], hema = owner.platformId === 'hema';
      assert.equal(owner.accountRef, refs[hema ? 'hema' : 'taobao']);
      return data({
        keyword: args.keyword, platforms: [{ ...owner, scope: hema ? 'delivery-stores' : 'platform', state: 'ready', groups: [
          { shopId: hema ? shopId : 'platform', shopName: hema ? '盒马测试店' : '', addressRef, state: 'ready', hasMore: false,
            items: [hema
              ? { id: '55', name: milk.name, price: '15.00', availability: 'available', productRef: hemaProduct }
              : { id: 'meal1', name: hamburger.name, price: '15.00', availability: 'available', shopId, shopName: '测试商家', shopIsRetail: false }],
          },
        ] }],
      });
    }
    if (name === 'account_addresses') return data({ platformId, selectedRef: addressRef,
      addresses: [{ address: 'PRIVATE_TEST_ADDRESS', phone: 'PRIVATE_TEST_PHONE' }] });
    if (name === 'account_cart') return data(cart(platformId));
    if (name === 'account_retail_cart')
      return data({ ...bound('taobao'), revision: retailVersion, items: retailCartChanged ? [milk] : [] });
    if (name === 'account_probe_menu') {
      assert.equal(platformId, 'hema');
      assert.equal(args.keyword, '牛奶');
      return data({ ...bound('hema'), categories: [{ items: [{ id: '55', productRef: hemaProduct }] }] });
    }
    if (name === 'account_product_detail') {
      assert.equal(args.productRef, hemaProduct);
      return data({ ...bound('hema'), productRef: hemaProduct, product: { id: '55', name: '测试牛奶', price: '15.00',
        available: true, variants: [{ id: variants.hema, name: '950ml', minimumQuantity: 1, stockQuantity: 5, quantityStep: 1, saleUnit: '瓶' }] } });
    }
    if (name === 'account_retail_resolve_search') {
      assert.equal(args.itemId, '66');
      return data({ ...bound('taobao'), productRef: retailProduct, name: '商超测试牛奶', priceCents: 1500,
        stock: 5, minimumQuantity: 1, available: true, simpleSku: true });
    }
    if (name === 'account_cart_add') {
      assert.equal(args.productRef, hemaProduct);
      assert.equal(args.skuId, variants.hema);
      assert.equal(args.revision, cartVersion.hema);
      assert(!hemaCartChanged);
      hemaCartChanged = true;
      cartVersion.hema = '9'.repeat(64);
      mutations.push(name);
      return data({ ...cart('hema'), mutation: { operationRef: args.operationRef, state: 'verified' } });
    }
    if (name === 'account_retail_add') {
      assert.equal(args.productRef, retailProduct);
      assert.equal(args.revision, retailVersion);
      assert(!retailCartChanged);
      retailCartChanged = true;
      retailVersion = '8'.repeat(64);
      mutations.push(name);
      return data({ ...bound('taobao'), revision: retailVersion, items: [milk], mutation: { operationRef: args.operationRef, state: 'verified' } });
    }
    if (name === 'account_retail_checkout') {
      assert.equal(args.revision, retailVersion);
      assert.equal(args.deliveryPreference, 'earliest');
      return data({ ...bound('taobao'), revision: retailVersion, quoteRef: randomUUID(), totalCents: 1500, merchant: '测试商超',
        maxOrderCents: 2000, expiresAt: Date.now() + 120000, fees: [], items: [milk] });
    }
    if (name === 'account_item_options') return data({
      ...bound(platformId), itemId: 'meal1', selectionRef: randomUUID(), name: '测试汉堡', minimumQuantity: 1,
      variants: [{ ref: variants.meal, name: '正常份', priceCents: 1500, stock: 10, available: true, groups: [] }],
    });
    if (name === 'account_cart_change') {
      assert(!cartChanged);
      assert.equal(args.revision, cartVersion.taobao);
      assert.equal(args.itemId, 'meal1');
      assert.equal(args.variantRef, variants.meal);
      mutations.push(name);
      cartChanged = true;
      cartVersion.taobao = 'a'.repeat(64);
      return data(cart(platformId));
    }
    if (name === 'account_checkout' || name === 'account_select_delivery') {
      if (platformId === 'hema' && name === 'account_checkout') assert.deepEqual(args.lineIds, ['129']);
      if (name === 'account_select_delivery') {
        assert.equal(args.deliveryRef, deliveryRef);
        assert.equal(args.quoteRef, quoteRef.hema);
        windowSelected = true;
        quoteRef.hema = randomUUID();
      }
      return data({ ...bound(platformId), quoteRef: quoteRef[platformId], totalCents: 1500,
        merchant: '测试商家', maxOrderCents: 2000, expiresAt: Date.now() + 120000, fees: [],
        items: [platformId === 'hema' ? milk : hamburger],
        requiresDeliveryChoice: platformId === 'hema' && !windowSelected,
        deliveryOptions: platformId === 'hema' ? [{ ref: deliveryRef, label: '16:00–17:00', feeCents: 0, selected: windowSelected }] : [],
      });
    }
    if (name === 'account_submit') {
      assert.equal(args.quoteRef, quoteRef[platformId]);
      assert.equal(args.confirmed, true);
      assert.equal(args.confirmedCents, 1500);
      assert.equal(args.maxAmountCents, 1900);
      assert(!original[platformId]);
      original[platformId] = true;
      mutations.push(name + ':' + platformId);
      if (platformId === 'hema') throw new TypeError('synthetic response lost');
      return data({ ...bound(platformId), orderRef: quoteRef[platformId], orderIds: [orderIds[platformId]], amountCents: 1500,
        paymentUrl: 'https://private.example.test/session', paymentStatus: 'unconfirmed' });
    }
    if (name === 'get_payment_options') {
      assert.equal(platformId, 'taobao');
      return data({ platformId, orderRef: quoteRef.taobao, paymentRef, amountCents: 1500, state: 'ready', paymentStatus: 'unpaid' });
    }
    if (name === 'pay_order') {
      assert.equal(args.paymentRef, paymentRef);
      assert.equal(args.orderRef, quoteRef.taobao);
      assert.equal(args.confirmedCents, 1500);
      mutations.push(name);
      return data({ attempts: [{ orderRef: quoteRef.taobao, paymentStatus: 'paid' }] });
    }
    assert(['get_order_status', 'request_payment'].includes(name));
    assert(original[platformId]);
    if (readbackUnavailable) throw new TypeError('synthetic readback unavailable');
    const paid = independentlyPaid && platformId === 'taobao';
    return data({ platformId, accountRef: refs[platformId], attempts: [{
      orderRef: quoteRef[platformId], amountCents: 1500, status: 'created', paymentStatus: paid ? 'paid' : 'unconfirmed',
      orderIds: [orderIds[platformId]], officialOrders: [{ id: orderIds[platformId], merchantName: '测试商家', status: paid ? (delivered ? '已送达' : '派送中') : '待支付', amount: '15.00' }],
    }] });
  };

  type Job = { alias: string; input: Record<string, unknown>; target?: ObjectRef; provider?: LocalDeliveryProvider };
  const jobs = new Map<string, Job>();
  const f = await fixture({
    model: 'delivery-trade-fixture',
    async run(prompt, tools) {
      const { userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
      const job = jobs.get(userRequest.message)!;
      const cart = job.alias === 'change', service = deliveryTradeServices[job.provider ?? 'TaobaoInstantDelivery'];
      await tools.get('complete_with_action')!.invoke({
        action: { interface: { type: cart ? service.cartContract : service.orderContract,
          ...(job.target ? { object: job.target } : { implementation: service.cartChangeType }), action: job.alias }, input: job.input },
        read: { function: cart ? service.read.cartChange : service.read.checkout, resultParameter: cart ? 'change' : 'checkout' },
      });
    },
  }, undefined, undefined, undefined, { localDelivery: paths, localDeliveryFetch: fetcher });
  const execute = (action: string, input: Record<string, unknown>) =>
    f.capabilities.actions.apply(f.access, f.model, action, input, randomUUID());
  const checkoutView = async (checkout: ObjectRef) => {
    const service = checkout.type === deliveryTradeServices.Hema.checkoutType ? deliveryTradeServices.Hema : deliveryTradeServices.TaobaoInstantDelivery;
    const result = await f.capabilities.functions.invoke(f.model, service.read.checkout, { checkout }, {
      principal, objects: new Objects(f.db, f.model, f.access), signal: new AbortController().signal,
    }) as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST|private\.example/);
    return result;
  };
  const next = async (id: string) => {
    assert(await f.worker.runOne('interactive'));
    return f.tasks.get(principal, id);
  };
  const interactive = async (job: Job, capability: string, decision: 'approve' | 'decline' = 'approve') => {
    const message = '外卖测试 ' + randomUUID();
    jobs.set(message, job);
    const request = await f.tasks.submit(principal, { requestId: randomUUID(), message });
    const before = [...mutations], task = await next(request.id);
    assert.equal(task.state, 'input-required', task.error ?? JSON.stringify(task.result));
    const pending = task.result as { capability: string; requestId: string; input: { termsDigest: string } };
    assert.equal(pending.capability, capability);
    assert.deepEqual(mutations, before, 'no mutation before the PA answers');
    const answer = { requestId: pending.requestId, response: { decision, termsDigest: pending.input.termsDigest } };
    await new PARequests(f.tasks).respond(principal, task.id, answer);
    await new PARequests(f.tasks).respond(principal, task.id, answer);
    const done = await next(task.id);
    assert.equal(done.state, 'completed', done.error ?? JSON.stringify(done.result));
    return done.result as Record<string, unknown>;
  };
  try {
    const graph = new Objects(f.db, f.model, f.access);
    const scope = { channel: 'taobao_meal', merchantId: shopId };
    const search = await execute('SearchTaobaoInstantDelivery', { query: '汉堡' });
    const cartChange = { ...scope, itemId: 'meal1', variantRef: variants.meal, quantity: 1, cartRevision: cartVersion.taobao, search };
    await assert.rejects(execute('ChangeTaobaoInstantDeliveryCart', cartChange), /interactive PA task/);
    const declined = await interactive({ alias: 'change', input: cartChange }, 'taobao_instant_delivery.cart_approval', 'decline');
    assert.equal(declined.state, 'declined');
    assert.deepEqual(mutations, []);
    const changed = await interactive({ alias: 'change', input: cartChange }, 'taobao_instant_delivery.cart_approval');
    assert.equal(changed.state, 'changed');

    const change = changed.change as ObjectRef;
    assert((await graph.follow(search, 'cartChanges')).some(row => row.ref.id === change.id));
    const order = await execute('PreviewTaobaoInstantDeliveryCheckout', {
      ...scope, cartRevision: cartVersion.taobao, maxAmountMinor: 1900, cartChange: change,
    });
    assert.deepEqual((await graph.follow(order, 'cartChange')).map(row => row.ref), [change]);
    assert.equal((await checkoutView(order)).totalMinor, 1500);
    const submitted = await interactive({ alias: 'submit', target: order, input: { checkout: order } }, 'taobao_instant_delivery.order_approval');
    assert.equal(submitted.state, 'awaiting_payment');
    assert.deepEqual(submitted.orderIds, [orderIds.taobao]);
    const [supplier] = await graph.follow(order, 'orders');
    assert.equal(supplier?.properties.nativeOrderId, orderIds.taobao);
    assert.equal(supplier?.properties.state, 'submitted');
    const job = (await f.db.query(`SELECT id,body FROM ${f.db.schema}.scheduled_actions WHERE body->'arguments'->'checkout'->>'id'=$1`,
      [order.id])).rows[0]!;
    assert.equal(job.body.action, 'RefreshTaobaoInstantDeliveryOrder');
    assert.deepEqual(job.body.arguments, { checkout: order });
    assert.equal(typeof job.body.sourceTaskId, 'string');
    const paidAck = await interactive({ alias: 'pay', target: order, input: { checkout: order } }, 'taobao_instant_delivery.payment_approval');
    assert.equal(paidAck.state, 'payment_unknown', 'the dispatch is not independent settlement evidence');
    readbackUnavailable = true;
    await f.db.query(`UPDATE ${f.db.schema}.scheduled_actions SET run_at=now() WHERE id=$1`, [job.id]);
    assert(await f.worker.runOne('scheduled'));
    assert.equal((await checkoutView(order)).observation, 'watching');
    assert.equal((await checkoutView(order)).supplierObservedAt, null);
    const advance = async () => {
      await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=now() WHERE state='submitted'`);
      assert(await f.worker.runOne('scheduled'));
    };
    readbackUnavailable = false;
    independentlyPaid = true;
    await advance();
    assert.equal((await checkoutView(order)).state, 'paid');
    assert.equal((await checkoutView(order)).observation, 'watching');
    assert.equal((await graph.read(supplier!.ref)).properties.fulfillment, 'in_progress');
    delivered = true;
    await advance();
    assert.equal((await checkoutView(order)).observation, 'finished');
    assert.equal((await graph.read(supplier!.ref)).properties.fulfillment, 'completed');
    assert((await graph.follow(order, 'stateLogs')).some(log => log.properties.newState === 'paid'));
    assert((await graph.follow(supplier!.ref, 'fulfillmentLogs')).some(log => log.properties.newState === 'completed'));
    assert.equal(await f.worker.runOne('scheduled'), false);

    const retail = { channel: 'taobao_retail', merchantId: shopId };
    const retailAdded = await interactive({ alias: 'change', input: { ...retail, itemId: '66', query: '牛奶',
      quantity: 1, cartRevision: retailVersion } }, 'taobao_instant_delivery.cart_approval');
    assert.equal(retailAdded.state, 'changed');
    const retailCheckout = await execute('PreviewTaobaoInstantDeliveryCheckout', { ...retail, cartRevision: retailVersion,
      retailDelivery: 'earliest', maxAmountMinor: 1900 });
    assert.equal((await checkoutView(retailCheckout)).totalMinor, 1500);

    const hemaSearch = await execute('SearchHemaProducts', { query: '牛奶' });
    const hemaAdded = await interactive({ provider: 'Hema', alias: 'change', input: { merchantId: shopId, itemId: '55',
      variantRef: variants.hema, query: '牛奶', quantity: 1, cartRevision: cartVersion.hema, search: hemaSearch } }, 'hema.cart_approval');
    assert.equal(hemaAdded.state, 'changed');
    assert.deepEqual((await graph.follow(hemaSearch, 'cartChanges')).map(row => row.ref), [hemaAdded.change]);
    const hema = await execute('PreviewHemaCheckout', { cartRevision: cartVersion.hema, maxAmountMinor: 1900, lineIds: ['129'] });
    assert.equal(hema.type, 'HemaCheckout');
    assert.equal(order.type, 'TaobaoInstantDeliveryCheckout');
    assert(!f.model.actions.has('PreviewLocalDeliveryCheckout'));
    assert(!f.model.actions.has('PayHemaOrder'));
    assert.equal((await graph.follow(hema, 'stateLogs'))[0]?.ref.type, 'HemaCheckoutStateLog');
    assert.equal((await graph.follow(order, 'stateLogs'))[0]?.ref.type, 'TaobaoInstantDeliveryCheckoutStateLog');
    await assert.rejects(f.capabilities.functions.invoke(f.model, 'readHemaCheckout', { checkout: order }, {
      principal, objects: graph, signal: new AbortController().signal,
    }), /Reference the original delivery checkout/);
    await assert.rejects(execute('RefreshTaobaoInstantDeliveryOrder', { checkout: hema }), /type does not satisfy/);
    await assert.rejects(execute('RefreshHemaOrder', { checkout: order }), /type does not satisfy/);
    await assert.rejects(execute('PayTaobaoInstantDeliveryOrder', { checkout: hema }), /type does not satisfy/);
    assert.equal((await checkoutView(hema)).requiresDeliveryChoice, true);
    await execute('SelectHemaDeliveryWindow', { checkout: hema, optionIndex: 0 });
    assert.equal((await checkoutView(hema)).requiresDeliveryChoice, false);
    const unknown = await interactive({ provider: 'Hema', alias: 'submit', target: hema, input: { checkout: hema } }, 'hema.order_approval');
    assert.equal(unknown.state, 'order_unknown');
    await execute('RefreshHemaOrder', { checkout: hema });
    assert.deepEqual((await checkoutView(hema)).orderIds, [orderIds.hema]);
    await execute('PrepareHemaPayment', { checkout: hema });
    assert.equal((await checkoutView(hema)).paymentEntry, 'hema_official_app');
    await execute('StopHemaOrderObservation', { checkout: hema });
    assert.equal((await checkoutView(hema)).observation, 'stopped');
    assert.deepEqual((await graph.follow(hema, 'orders')).map(row => row.ref.type), ['HemaOrder']);
    const jobsByProvider = (await f.db.query(`SELECT body->>'action' AS action FROM ${f.db.schema}.scheduled_actions ORDER BY action`)).rows;
    assert.deepEqual(jobsByProvider.map(row => row.action), ['RefreshHemaOrder', 'RefreshTaobaoInstantDeliveryOrder']);
    assert.equal(await f.worker.runOne('scheduled'), false);
    assert.deepEqual(mutations, [
      'account_cart_change', 'account_submit:taobao', 'pay_order', 'account_retail_add', 'account_cart_add', 'account_submit:hema',
    ]);
    const pending = await f.db.query(`SELECT split_part(operation_key, ':', 1) as kind, state FROM ${f.db.schema}.external_operations`);
    assert.deepEqual(pending.rows.filter(record => record.state !== 'confirmed'), []);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
