import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { restaurantSearchType, restaurantVenueType, restaurantVisitType } from '../packages/ontology/restaurant-services.js';
import { tableCheckRecord, tableCheckReservationType } from '../packages/ontology/tablecheck-reservations.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { fakeAmap, testConnection } from './amap-fixture.js';
import { fixture, principal } from './fixture.js';

const iso = () => new Date().toISOString();
const later = () => new Date(Date.now() + 3600000).toISOString();
const venue = { restaurant: '合成验收餐厅', city: '上海' };
const startsAt = new Date(Date.now() + 2 * 86400000);
startsAt.setUTCHours(11, 0, 0, 0);
const date = startsAt.toISOString().slice(0, 10);
const alternate = new Date(startsAt.getTime() + 30 * 60000).toISOString();
const bookingPage = 'https://www.tablecheck.com/shops/synthetic-venue/reserve';
const management = 'https://tblc.hk/rTEST01';
const shopId = 'a'.repeat(24), heldId = 'b'.repeat(24), bookingId = 'c'.repeat(24);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('restaurant Interface actions link source venues and record TableCheck holds, expiry, reconciliation and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-restaurants-'));
  const keyFile = join(directory, 'tablecheck-availability.key'), distributionKeyFile = join(directory, 'tablecheck-distribution.key');
  const key = 'fixture-availability-key', distributionKey = 'fixture-distribution-key';
  const tableCheck = join(directory, 'tablecheck.json');
  const raw = { id: shopId, name_translations: { 'zh-CN': venue.restaurant }, time_zone: 'Asia/Shanghai',
    tablecheck_booking_url: bookingPage, address: { city: venue.city }, privateExtra: 'must not surface' };
  let order: Record<string, unknown> | undefined, holdCount = 0, createCount = 0, cancelCount = 0;
  let hideOrder = true, wrongOrder = false;
  const lookups: string[] = [];
  const fakeTableCheck: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    assert.equal(url.origin, 'https://api.tablecheck.com');
    assert.equal(new Headers(init?.headers).get('Authorization'),
      url.pathname.includes('/availability/') ? key : distributionKey);
    const endpoint = url.pathname.split('/v1/')[1]!;
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    switch (endpoint) {
      case 'shops':
        assert.equal(url.searchParams.get('address_city'), venue.city);
        return Response.json({ shops: [raw] });
      case 'shops/' + shopId: return Response.json({ shop: raw });
      case 'timetable/' + shopId:
        assert.equal(url.searchParams.get('pax'), '2');
        assert.equal(url.searchParams.get('date_min'), date);
        return Response.json({ timetable: { id: shopId, availability_cached_at: iso(),
          availability: [startsAt.toISOString(), alternate, new Date(startsAt.getTime() + 24 * 3600000).toISOString()] } });
      case 'blockages':
        assert.equal(init?.method, 'POST');
        holdCount++;
        assert([startsAt.toISOString(), alternate].includes(payload.start_at));
        assert.deepEqual(payload, { shop_id: shopId, start_at: payload.start_at, pax: 2, expiry_ttl: 300 });
        return Response.json({ blockage: { ...payload, id: heldId, expires_at: later() } });
      case 'reservations':
        assert.equal(init?.method, 'POST');
        assert.equal(payload.blockage_id, heldId);
        assert.equal(payload.phone, '+8613800000000');
        createCount++;
        order = { id: bookingId, ref: payload.ref, shop_id: shopId, pax: 2, start_at: startsAt.toISOString(), status: 'confirmed', code: 'TEST01', url: management };
        throw new Error('Synthetic lost response');
      case 'reservations/' + bookingId + '/cancel':
        assert.equal(init?.method, 'PUT');
        cancelCount++;
        order = { ...order, status: 'cancelled' };
        return Response.json({ reservation: order });
    }
    assert(endpoint.startsWith('reservations/'));
    assert.equal(init?.method, 'GET');
    lookups.push(endpoint.slice('reservations/'.length));
    return !order || hideOrder ? new Response(null, { status: 404 })
      : Response.json({ reservation: wrongOrder ? { ...order, pax: 3 } : order });
  };

  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await Promise.all([
      writeFile(keyFile, key, { mode: 0o600 }),
      writeFile(distributionKeyFile, distributionKey, { mode: 0o600 }),
      writeFile(tableCheck, JSON.stringify({ owner: principal.owner, active: true, expiresAt: later(), keyFile,
        keySha256: sha256(key), distributionKeyFile, distributionKeySha256: sha256(distributionKey),
        noDepositShopIds: [shopId] }), { mode: 0o600 }),
    ]);
    const amap = await testConnection(directory), amapFetch = fakeAmap([]);
    const d = f = await fixture(undefined, undefined, undefined, undefined, { tableCheck, tableCheckFetch: fakeTableCheck, amap, amapFetch });
    const objects = new Objects(d.db, d.model, d.access);
    const apply = (name: string, input: Record<string, unknown>, requestId: string) =>
      d.capabilities.actions.apply(d.access, d.model, name, input, requestId);
    const read = (name: string, input: Record<string, unknown>) =>
      d.capabilities.functions.invoke(d.model, name, input, { principal, objects, signal: AbortSignal.timeout(10000) }) as Promise<Record<string, unknown>>;
    const input = { query: '粤菜', city: venue.city, providers: ['TableCheck', 'Amap', 'Dianping', 'MeituanDining', 'Resy'] };
    const find = d.capabilities.actions.resolve(d.access, d.model, {
      interface: { type: 'RestaurantDiscovery', action: 'search', implementation: restaurantSearchType }, input,
    });
    const search = await apply(find.action, find.input, 'find');
    const page = await read('readRestaurantSearch', { search });
    const outcomes = page.outcomes as { provider: string; status: string; count: number }[];
    assert.deepEqual(outcomes.map(row => [row.provider, row.status]), [
      ['TableCheck', 'observed'], ['Amap', 'observed'], ['Dianping', 'authorization_required'],
      ['MeituanDining', 'location_required'], ['Resy', 'pa_required'],
    ]);
    const candidates = await objects.follow(search, 'venues');
    const selected = candidates.find(row => row.properties.provider === 'TableCheck')!;
    assert.equal(selected.ref.type, restaurantVenueType);
    assert(page.venues);
    assert(!JSON.stringify(page).includes('must not surface'));
    const review = d.capabilities.actions.resolve(d.access, d.model, { interface: {
      type: 'RestaurantVisitReview', action: 'review', implementation: restaurantVisitType },
      input: { venue: selected.ref, date, partySize: 2 },
    });
    const visit = await apply(review.action, review.input, 'review');
    const availability = await read('readRestaurantVisit', { visit });
    assert.equal(availability.bookingUrl, bookingPage);
    assert.deepEqual(availability.availableTimes, ['19:00', '19:30']);
    assert.deepEqual(availability.availableInstants, [startsAt.toISOString(), alternate]);
    const prepare = d.capabilities.actions.resolve(d.access, d.model, { interface: {
      type: 'RestaurantReservationOffer', action: 'prepare', implementation: tableCheckReservationType },
      input: { visit, startsAt: startsAt.toISOString() },
    });
    const reservation = await apply(prepare.action, prepare.input, 'prepare');
    assert.deepEqual(await apply(prepare.action, prepare.input, 'duplicate-prepare'), reservation);
    const booking = () => objects.read(reservation).then(row => tableCheckRecord.parse(row.properties));
    assert.equal((await booking()).state, 'offered');
    assert.deepEqual((await objects.follow(reservation, 'visit'))[0]!.ref, visit);
    assert.deepEqual((await objects.follow(reservation, 'venue'))[0]!.ref, selected.ref);
    const logs = async () => (await objects.follow(reservation, 'stateLogs'))
      .map(({ properties: { newState, action } }) => [newState, action]);
    const offerDeadline = (await booking()).expiresAt;
    const past = new Date(Date.now() - 1000).toISOString();
    // Advance the fixture's offer deadline and due jobs without changing its business state.
    await d.db.query(`UPDATE ${d.db.schema}.objects
      SET properties=jsonb_set(properties,'{expiresAt}',to_jsonb($2::text)) WHERE type='TableCheckReservation' AND id=$1`,
      [reservation.id, past]);
    await d.db.query(`UPDATE ${d.db.schema}.scheduled_actions SET run_at=$1
      WHERE body->'arguments'->'commitment'->>'id'=$2 AND run_at=$3`, [past, reservation.id, offerDeadline]);
    assert(await d.worker.runOne('scheduled'));
    assert.equal((await booking()).state, 'expired');
    assert.deepEqual(await logs(), [['offered', 'PrepareTableCheckReservation'], ['expired', 'ExpireTableCheckReservation']]);
    assert.deepEqual([holdCount, createCount, cancelCount], [0, 0, 0]);
    assert.deepEqual(await apply(prepare.action, prepare.input, 'prepare-after-expiry'), reservation);
    const resolve = (action: string, fields: Record<string, unknown> = {}) => d.capabilities.actions.resolve(d.access, d.model, {
      interface: { type: 'NetTableReservation', action, object: reservation }, input: { commitment: reservation, ...fields },
    });
    const contact = { name: 'Synthetic Guest', phone: '+8613800000000' };
    const invalid = resolve('confirm', { approval: { termsDigest: '0'.repeat(64), approvedAt: iso() }, contact });
    await assert.rejects(apply(invalid.action, invalid.input, 'not-approved'), /current exact TableCheck terms/);
    assert.equal(holdCount, 0);
    const approvedAt = iso();
    const confirm = resolve('confirm', { approval: { termsDigest: (await booking()).termsDigest, approvedAt }, contact });
    const token = 'tablecheck-codemode-synthetic-test-token';
    const gateway = createApp(readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL,
      EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token }), d.db, d.source).app.listen(0, '127.0.0.1');
    const mcp = new Client({ name: 'synthetic-tablecheck-code-mode', version: '1' });
    try {
      await once(gateway, 'listening');
      const address = gateway.address();
      assert(address && typeof address === 'object');
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),
        { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
      const execute = (requestId: string, code: string) => mcp.callTool({
        name: 'execute_ontology_action', arguments: { requestId, code },
      });
      const body = (result: { isError?: boolean; content?: unknown }) => {
        assert(!result.isError, JSON.stringify(result));
        return JSON.parse((result.content as { text: string }[])[0]!.text);
      };
      const ready = body(await execute('code-mode-tablecheck-prepare', `async ({ query, applyAction }) => {
        const page = await query({ type: ${JSON.stringify(restaurantVisitType)}, where: { id: ${JSON.stringify(visit.id)} }, limit: 1 });
        const original = page.items[0].ref;
        await applyAction({ interface: { type: 'RestaurantReservationOffer', action: 'prepare', implementation: 'TableCheckReservation' },
          input: { visit: original, startsAt: ${JSON.stringify(alternate)} } });
        return original;
      }`));
      assert.deepEqual(ready.value, visit);
      assert(await d.worker.runOne('interactive'));
      const offered = body(await mcp.callTool({ name: 'get_task', arguments: { taskId: ready.task.id } }));
      assert.equal(offered.state, 'completed', JSON.stringify(offered));
      assert.equal((await objects.read(offered.result)).properties.state, 'offered');
      assert.notDeepEqual(offered.result, reservation);

      const stage = `
        const page = await query({ type: 'TableCheckReservation', where: { id: ${JSON.stringify(reservation.id)} }, select: ['termsDigest'] });
        const { ref, properties } = page.items[0];
        await applyAction({ interface: { type: 'NetTableReservation', action: 'confirm', object: ref },
          input: { commitment: ref, approval: { termsDigest: properties.termsDigest, approvedAt: ${JSON.stringify(approvedAt)} },
            contact: ${JSON.stringify(contact)} } });
      `;
      const failed = await execute('code-mode-tablecheck-failed', `async ({ query, applyAction }) => { ${stage} throw new Error('script failed'); }`);
      assert.equal(failed.isError, true);
      assert.equal((await d.db.query(`SELECT 1 FROM ${d.db.schema}.tasks WHERE request_id=$1`, ['code-mode-tablecheck-failed'])).rowCount, 0);
      const requestId = 'code-mode-tablecheck-confirm';
      const code = `async ({ query, applyAction }) => { ${stage} return ref; }`;
      const submitted = body(await execute(requestId, code));
      assert.equal(submitted.task.state, 'submitted');
      assert.deepEqual(submitted.value, reservation);
      assert.equal(body(await execute(requestId, code)).task.id, submitted.task.id);
      assert(await d.worker.runOne('interactive'));
      const pending = body(await mcp.callTool({ name: 'get_task', arguments: { taskId: submitted.task.id } }));
      assert.equal(pending.state, 'input-required');
      assert.equal(pending.result.capability, 'dining.tablecheck.confirm.approval');
      assert.equal(pending.result.taskId, submitted.task.id);
      const replay = body(await execute(requestId, code));
      assert.equal(replay.task.id, submitted.task.id);
      assert.equal(replay.task.state, 'input-required');
      assert.deepEqual([holdCount, createCount, cancelCount], [0, 0, 0]);
      const confirmed = body(await mcp.callTool({ name: 'respond_to_task', arguments: {
        taskId: submitted.task.id, requestId: pending.result.requestId,
        response: { approved: true, termsDigest: pending.result.input.termsDigest },
      } }));
      assert.equal(confirmed.id, submitted.task.id);
      assert(await d.worker.runOne('interactive'));
      const completed = body(await mcp.callTool({ name: 'get_task', arguments: { taskId: submitted.task.id } }));
      assert.equal(completed.state, 'completed', JSON.stringify(completed));
      assert.equal(completed.result.id, reservation.id);
      assert.equal(body(await execute(requestId, code)).task.id, submitted.task.id);
    } finally {
      await mcp.close();
      gateway.closeAllConnections();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
    assert.equal((await booking()).state, 'unknown');
    assert((await booking()).holdExpiresAt);
    await apply('ExpireTableCheckReservation', { commitment: reservation }, 'expiry-after-dispatch');
    assert.equal((await booking()).state, 'unknown');
    assert.equal(holdCount, 1);
    assert.equal(createCount, 1);
    hideOrder = false;
    wrongOrder = true;
    await apply(confirm.action, confirm.input, 'duplicate-confirm');
    assert.equal((await booking()).state, 'unknown');
    wrongOrder = false;
    const reconcile = resolve('reconcile');
    await apply(reconcile.action, reconcile.input, 'reconcile-original');
    assert.equal((await booking()).state, 'confirmed');
    assert.equal((await booking()).bookingId, bookingId);
    assert.equal((await booking()).manageUrl, management);
    assert.equal((await booking()).receipts[0]?.evidence, 'synthetic');
    assert.equal(holdCount, 1);
    assert.equal(createCount, 1);
    assert(lookups.length >= 3 && lookups.every(id => id === reservation.id));
    const cancel = resolve('cancel', { reason: 'fixture guest canceled' });
    await apply(cancel.action, cancel.input, 'cancel-original');
    await apply(cancel.action, cancel.input, 'duplicate-cancel');
    const canceled = await read('readTableCheckReservation', { reservation });
    assert.equal(canceled.state, 'canceled');
    assert.equal(cancelCount, 1);
    assert(!JSON.stringify(canceled).includes(contact.phone));
    assert(!JSON.stringify(canceled).includes(heldId));
    assert.deepEqual(await logs(), [
      ['offered', 'PrepareTableCheckReservation'], ['expired', 'ExpireTableCheckReservation'],
      ['offered', 'PrepareTableCheckReservation'], ['held', 'ConfirmTableCheckReservation'],
      ['unknown', 'ConfirmTableCheckReservation'], ['confirmed', 'ReconcileTableCheckReservation'],
      ['canceled', 'CancelTableCheckReservation'],
    ]);

    // Leave a verified provider hold with no create dispatch. The database trigger simulates
    // an interrupted reservation claim after the hold transaction committed.
    const second = await apply(prepare.action, { visit, startsAt: alternate }, 'prepare-second-slot');
    const secondBooking = () => objects.read(second).then(row => tableCheckRecord.parse(row.properties));
    await d.db.query(`CREATE FUNCTION ${d.db.schema}.interrupt_second_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id='interrupt-confirm'
          AND EXISTS (SELECT 1 FROM ${d.db.schema}.external_operations
            WHERE owner=NEW.owner AND request_id=NEW.request_id)
        THEN RAISE EXCEPTION 'synthetic interruption before create'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER interrupt_second_dispatch BEFORE INSERT ON ${d.db.schema}.external_operations
      FOR EACH ROW EXECUTE FUNCTION ${d.db.schema}.interrupt_second_dispatch()`);
    await assert.rejects(apply(confirm.action, { commitment: second, contact,
      approval: { termsDigest: (await secondBooking()).termsDigest, approvedAt: iso() } }, 'interrupt-confirm'),
    /synthetic interruption before create/);
    const held = await secondBooking();
    assert.equal(held.state, 'held');
    assert(held.holdExpiresAt && held.holdExpiresAt > held.expiresAt);
    assert.deepEqual([holdCount, createCount, cancelCount], [2, 1, 1]);

    await d.db.query(`UPDATE ${d.db.schema}.objects SET properties=jsonb_set(properties,'{holdExpiresAt}',to_jsonb($2::text))
      WHERE type='TableCheckReservation' AND id=$1`, [second.id, past]);
    await d.db.query(`UPDATE ${d.db.schema}.scheduled_actions SET run_at=$1
      WHERE body->'arguments'->'commitment'->>'id'=$2 AND run_at=$3`, [past, second.id, held.holdExpiresAt]);
    assert(await d.worker.runOne('scheduled'));
    assert.equal((await secondBooking()).state, 'expired');
    assert.deepEqual((await objects.follow(second, 'stateLogs')).map(log => log.properties.newState), ['offered', 'held', 'expired']);
    assert.deepEqual([holdCount, createCount, cancelCount], [2, 1, 1]);
  } finally {
    await f?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Meituan Enterprise reads a search and its selected venue without turning a booking flag into availability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-meituan-dining-'));
  const meituan = join(directory, 'connection.json'), aesKey = Buffer.from('sample-16b-key!!');
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const calls: { path: string; parameters: Record<string, unknown> }[] = [];
  try {
    await writeFile(meituan, JSON.stringify({ owner: principal.owner, active: true, expiresAt: later(), environment: 'test',
      entId: 12345, token: 'fixture-key', sign: 'fixture-signature', aesKey: aesKey.toString('base64url'), version: '1.0' }), { mode: 0o600 });
    const supply: typeof fetch = async (target, init) => {
      const url = new URL(String(target)), body = init?.body as URLSearchParams;
      assert.equal(url.origin, 'https://sqt-api.test.meituan.com');
      assert.equal(init?.method, 'POST');
      assert.equal(body.get('token'), 'fixture-key');
      const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
      const parameters = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body.get('content')!, 'base64url')), decipher.final()]).toString());
      calls.push({ path: url.pathname, parameters });
      return Response.json({ status: 0, data: url.pathname.endsWith('/list') ? {
        pageNum: 1, poiList: [{ shopId: '1234', fullshopname: venue.restaurant, hasbooksetting: '1' }],
      } : { shopId: 1234, shopName: venue.restaurant, isSupportReserve: true } });
    };
    const d = f = await fixture(undefined, undefined, undefined, undefined, { meituanDining: meituan, meituanDiningFetch: supply });
    const objects = new Objects(d.db, d.model, d.access);
    const result = await d.capabilities.actions.apply(d.access, d.model, 'FindRestaurants', {
      providers: ['MeituanDining'], query: '粤菜', city: venue.city, center: { latitude: 31.22, longitude: 121.48, coordinateSystem: 'gcj02' },
    }, 'search');
    const [shop] = await objects.follow(result, 'venues');
    assert.equal(shop?.properties.evidence, 'provider_mock');
    const visit = await d.capabilities.actions.apply(d.access, d.model, 'ReviewRestaurantVisit', {
      venue: shop!.ref, date, partySize: 2,
    }, 'review');
    const { properties } = await objects.read(visit);
    assert.equal(properties.supportsBooking, true);
    assert.equal(properties.status, 'unsupported');
    assert.equal(properties.availableTimes, undefined);
    assert.equal(properties.bookingUrl, undefined);
    assert.deepEqual(calls.map(call => call.path), ['/openapi/daocanPoi/list', '/openapi/daocanPoi/detail']);
    assert.equal(calls[0]?.parameters.lng, '121.48');
    assert.equal(calls[0]?.parameters.entId, 12345);
    assert.equal(calls[1]?.parameters.shopId, 1234);
  } finally {
    await f?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Resy discovery continues the same task with the original PA’s authorized connector result', async () => {
  const f = await fixture({ model: 'synthetic-resy-agent', async run(_prompt, tools) {
    await tools.get('complete_with_function')!.invoke({
      function: 'searchResyRestaurants', input: { city: 'New York', query: 'Italian', limit: 1 },
    });
  } });
  try {
    const task = await f.tasks.submit(principal, { requestId: 'resy-search-fixture', message: '在 Resy 找一家纽约意大利餐厅。' });
    await f.worker.runOne();
    const waiting = await f.tasks.get(principal, task.id);
    assert.equal(waiting.state, 'input-required', JSON.stringify(waiting));
    const request = waiting.result as { taskId: string; requestId: string; capability: string };
    assert.equal(request.taskId, task.id);
    assert.equal(request.capability, 'dining.resy.search');
    const resyVenue = { nativeId: 'synthetic-resy-venue', name: 'Synthetic Venue', bookingUrl: 'https://resy.com/cities/new-york-ny/venues/synthetic-venue' };
    const response = { status: 'observed', city: 'New York', observedAt: iso(), venues: [resyVenue] };
    await assert.rejects(new PARequests(f.tasks).respond({ ...principal, owner: 'other' }, task.id, { requestId: request.requestId, response }), /unavailable/);
    await new PARequests(f.tasks).respond(principal, task.id, { requestId: request.requestId, response });
    await f.worker.runOne();
    const finished = await f.tasks.get(principal, task.id);
    assert.equal(finished.state, 'completed', JSON.stringify(finished));
    assert.deepEqual((finished.result as { rows: unknown[] }).rows, [{
      ...resyVenue, city: 'New York', provider: 'Resy', observedAt: response.observedAt, evidence: 'pa_reported',
    }]);
  } finally { await f.close(); }
});
