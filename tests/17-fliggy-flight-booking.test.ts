import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from '../apps/worker/worker.js';
import { ScheduledActionRunner, ScheduledActions, DeferredExecution } from '../packages/runtime/scheduled-actions.js';
import { Access } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { fixture, principal } from './fixture.js';

test('Jinghang payment schedules original-order checks through restart, independent ticket issuance and timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fliggy-flight-booking-'));
  const connection = join(directory, 'connection.json'), profile = join(directory, 'passenger.json');
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const session = 'synthetic-seller-session', nativeId = '1234567890123456780';
  const search = { origin: 'BJS', destination: 'XMN', departureDate: '2030-03-10' };
  const flight = { dep_airport: 'PKX', arr_airport: 'XMN', marketing_flight_no: 'CZ8957',
    dep_time: '2030-03-10 08:45:00', arr_time: '2030-03-10 11:35:00', id: 'XZ0001' };
  const itinerary = { trip_type: 1, flight_journey_list: { flight_journey: [{ flight_segment_list: { flight_segment: [flight] } }] } };
  const fare = (amount: number) => ({
    item_id: 'approved-fare', refund_change_details: 'Fixture fare terms', search_extra_attribute: { standard_product: true },
    flight_route: itinerary, passenger_price_list: { flight_passenger_item: [
      { passenger_type: 'ADT', flight_price: { sell_price: amount, build_price: 50, oil_price: 20, tax: 70 },
        flight_segment_item_list: { flight_segment_item: [{ cabin: 'N', flight_segment_id: flight.id }] } },
    ] },
  });
  let amount = 460, outOrderNo = '', paid = false, issued = false, closed = false, losePaymentReply = true;
  let detailFailure = false, wrongReceipt = false;
  let beforeDetailReply: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  const person = { name: 'Private passenger', mobile_phone_number: '1234567890', mobile_country_code: '86' };
  await Promise.all([
    writeFile(connection, JSON.stringify({ owner: principal.owner, account: 'fixture', enabled: true,
      appKey: '12345', appSecret: 'synthetic-key', session, expiresAt, channelName: 'fixture-channel', flightProfilesFile: profile }), { mode: 0o600 }),
    writeFile(profile, JSON.stringify([{ id: 'adult-1', expiresAt, contact: person,
      passenger: { ...person, birthday: '1990-01-01', credential_type: 0, credential_no: '111111199001011115' } }]), { mode: 0o600 }),
  ]);
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://eco.taobao.com/router/rest');
    const request = new URLSearchParams(init?.body as URLSearchParams), method = request.get('method')!;
    assert.equal(request.get('session'), session);
    const operation = method.split('.').at(-1)!;
    calls.push(operation);
    const reply = (facts: unknown) => new Response(JSON.stringify({ [method.replaceAll('.', '_') + '_response']: facts })
      .replaceAll('"LARGE_ID"', nativeId));
    if (operation === 'search') {
      const criteria = JSON.parse(request.get('search_flight_info_req')!);
      assert.deepEqual(criteria.search_od_info_list, [{ dep_city_code: 'BJS', arr_city_code: 'XMN', dep_date: '2030-03-10' }]);
      return reply({ search_flight_info_res: { is_success: true, flight_group_item_list: { flight_group_item: [fare(amount)] } } });
    }
    if (operation === 'airbook') {
      const order = JSON.parse(request.get('create_order_request')!);
      assert.equal(order.total_price, 530);
      assert.equal(order.item_id, 'approved-fare');
      assert.equal(order.passenger_list[0].type, 0);
      outOrderNo = order.out_order_no;
      return reply({ is_success: true, order_id: 'LARGE_ID', out_order_no: outOrderNo });
    }
    if (operation === 'pay') {
      assert(request.get('pay_request')!.includes('"order_id":' + nativeId));
      paid = true;
      if (losePaymentReply) { losePaymentReply = false; throw new Error('Payment response was lost'); }
      return reply({ is_success: true, order_id: 'LARGE_ID' });
    }
    if (operation === 'close') {
      assert(request.get('close_order_req')!.includes('"order_id":' + nativeId));
      closed = true;
      return reply({ is_success: true, order_id: 'LARGE_ID' });
    }
    const detail = JSON.parse(request.get('query_order_detail_req')!);
    assert.equal(detail.out_order_no, outOrderNo);
    if (detailFailure) return new Response('Temporarily unavailable', { status: 503 });
    const response = reply({
      is_success: true, order_id: 'LARGE_ID', out_order_no: wrongReceipt ? 'other-order' : outOrderNo, total_price: 530, real_pay_price: paid ? 530 : 0,
      order_status: closed ? 'CLOSED' : issued ? '出票成功' : paid ? '已支付' : '生单预定成功', flight_route: itinerary,
      ...(paid ? { pay_status: 'PAID', pay_time: '2030-03-01 12:00:00', trade_no: 'synthetic-transaction' } : {}),
      ...(issued ? { flight_book_order_detail_list: { flight_book_order_detail: [{ ticket_nos: { string: ['8702222211119'] } }] } } : {}),
    });
    const race = beforeDetailReply;
    beforeDetailReply = undefined;
    await race?.();
    return response;
  };
  const f = await fixture(undefined, undefined, undefined, undefined, { fliggyFlight: connection, fliggyFlightFetch: fetcher });
  try {
    const act = async (action: string, input: Record<string, unknown>) =>
      f.capabilities.actions.apply(await Access.load(f.db, principal), f.model, action, input, randomUUID());
    const view = async (booking: ObjectRef) =>
      await f.capabilities.functions.invoke(f.model, 'readFliggyFlightBooking', { booking },
        { principal, objects: new Objects(f.db, f.model, await Access.load(f.db, principal)),
          signal: AbortSignal.timeout(5000) }) as Record<string, unknown>;
    const booking = await act('PrepareFliggyFlightBooking', { search, itemId: 'approved-fare', profileId: 'adult-1', bookingKey: randomUUID() });
    const preview = await view(booking);
    assert.equal(preview.evidence, 'synthetic');
    assert(!JSON.stringify(preview).match(/Private passenger|credential_no|session/));
    const approval = { booking, approvedDigest: preview.approvalDigest, amountMinor: 53000 };
    amount = 461;
    await assert.rejects(act('CreateFliggyFlightBooking', approval), /changed the fare/);
    amount = 460;
    await act('CreateFliggyFlightBooking', approval);
    const stored = await view(booking);
    assert.equal(stored.merchantOrderId, nativeId);
    assert.equal(stored.paid, false);
    assert.equal(stored.issued, false);
    await assert.rejects(act('PayFliggyFlightBooking', approval), /unresolved result/);
    await assert.rejects(act('PayFliggyFlightBooking', approval), /reconcile/);
    const schedules = new ScheduledActions(f.db, f.metadata);
    const runner = new ScheduledActionRunner(f.db, f.metadata, f.tasks, f.capabilities.actions);
    const worker = new Worker(f.tasks, f.agent, schedules, runner);
    const track = async () => (await new Objects(f.db, f.model, await Access.load(f.db, principal)).read(booking)).properties;
    const recheck = async () => {
      await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=clock_timestamp() WHERE state='submitted'`);
      assert(await worker.runOne('scheduled'));
    };
    const queued = await f.db.query(`SELECT id,body FROM ${f.db.schema}.scheduled_actions`);
    assert.equal(queued.rowCount, 1);
    assert.equal(queued.rows[0]!.body.action, 'RefreshFliggyFlightBooking');
    assert.deepEqual(queued.rows[0]!.body.arguments, { booking });
    await f.db.query(`UPDATE ${f.db.schema}.scheduled_actions SET run_at=clock_timestamp()`);
    assert(await schedules.promoteOne());
    const claimed = (await f.tasks.claim('scheduled'))!;
    detailFailure = true;
    await assert.rejects(runner.run(claimed, AbortSignal.timeout(5000)), DeferredExecution);
    assert.equal((await track()).issuanceState, 'payment_unverified');
    assert.equal((await track()).issuanceObservation, 'watching');
    // Simulate losing the Worker after its Action commit and before Tasks.defer.
    const reads = calls.filter(op => op === 'detail').length;
    await f.db.query(`UPDATE ${f.db.schema}.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [claimed.id]);
    assert(await worker.runOne('scheduled'));
    assert.equal(calls.filter(op => op === 'detail').length, reads);
    detailFailure = false;
    wrongReceipt = true;
    await recheck();
    assert.equal((await track()).paid, false);
    assert.equal((await track()).issuanceState, 'payment_unverified');
    wrongReceipt = false;
    await recheck();
    assert.equal((await view(booking)).paid, true);
    assert.equal((await track()).issuanceState, 'awaiting_issuance');
    assert.equal((await view(booking)).issued, false);
    assert.equal(calls.filter(operation => operation === 'pay').length, 1);
    // Worker receives a paid-but-unissued response after a later manual read already confirmed the ticket.
    beforeDetailReply = async () => {
      issued = true;
      await act('RefreshFliggyFlightBooking', { booking });
    };
    await recheck();
    assert.equal((await track()).issuanceState, 'issued');
    assert.equal((await track()).issuanceObservation, 'finished');
    assert.equal(await worker.runOne('scheduled'), false);
    assert.equal(calls.filter(operation => operation === 'pay').length, 1);
    const graph = new Objects(f.db, f.model, await Access.load(f.db, principal));
    const logs = await graph.follow(booking, 'issuanceStateLogs');
    assert(logs.some(log => log.ref.type === 'FliggyFlightBookingIssuanceStateLog' &&
      log.properties.oldState === 'awaiting_issuance' && log.properties.newState === 'issued'));
    assert(logs.some(log => log.properties.newState === 'awaiting_issuance'));
    const fulfilled = await view(booking);
    assert.equal(fulfilled.issued, true);
    assert.equal(fulfilled.independentRead, true);
    assert(!JSON.stringify(fulfilled).includes('8702222211119'));
    await assert.rejects(act('CloseFliggyFlightBooking', approval), /unpaid/);
    paid = false; issued = false;
    const unpaid = await act('PrepareFliggyFlightBooking', { search, itemId: 'approved-fare', profileId: 'adult-1', bookingKey: randomUUID() });
    const approvedUnpaid = { booking: unpaid, approvedDigest: (await view(unpaid)).approvalDigest, amountMinor: 53000 };
    await act('CreateFliggyFlightBooking', approvedUnpaid);
    await act('CloseFliggyFlightBooking', approvedUnpaid);
    assert.equal((await view(unpaid)).closed, true);
    assert.equal(calls.filter(operation => operation === 'close').length, 1);

    // A settled payment with no ticket evidence reaches the observation deadline honestly.
    paid = false; issued = false; closed = false;
    const late = await act('PrepareFliggyFlightBooking', { search, itemId: 'approved-fare', profileId: 'adult-1', bookingKey: randomUUID() });
    const lateApproval = { booking: late, approvedDigest: (await view(late)).approvalDigest, amountMinor: 53000 };
    await act('CreateFliggyFlightBooking', lateApproval);
    await act('PayFliggyFlightBooking', lateApproval);
    await f.db.query(`UPDATE ${f.db.schema}.scheduled_actions SET run_at=now(),deadline=now()+interval '1 minute' WHERE state='scheduled'`);
    assert(await worker.runOne('scheduled'));
    const stopped = await new Objects(f.db, f.model, await Access.load(f.db, principal)).read(late);
    assert.equal(stopped.properties.issuanceObservation, 'timed_out');
    assert.equal(stopped.properties.issuanceState, 'awaiting_issuance');
    assert.equal(stopped.properties.issued, false);
    assert.equal(await worker.runOne('scheduled'), false);
    assert.equal(calls.filter(operation => operation === 'pay').length, 2);

    // An independent manual confirmation before the scheduled observer starts needs no further supplier read.
    paid = false; issued = false;
    const immediate = await act('PrepareFliggyFlightBooking', { search, itemId: 'approved-fare', profileId: 'adult-1', bookingKey: randomUUID() });
    const immediateApproval = { booking: immediate, approvedDigest: (await view(immediate)).approvalDigest, amountMinor: 53000 };
    await act('CreateFliggyFlightBooking', immediateApproval);
    await act('PayFliggyFlightBooking', immediateApproval);
    issued = true;
    await act('RefreshFliggyFlightBooking', { booking: immediate });
    const beforeStop = calls.length;
    await f.db.query(`UPDATE ${f.db.schema}.scheduled_actions SET run_at=now() WHERE state='scheduled'`);
    assert(await worker.runOne('scheduled'));
    assert.equal(calls.length, beforeStop);
    assert.equal((await new Objects(f.db, f.model, await Access.load(f.db, principal)).read(immediate)).properties.issuanceObservation, 'finished');
    assert.equal(await worker.runOne('scheduled'), false);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
