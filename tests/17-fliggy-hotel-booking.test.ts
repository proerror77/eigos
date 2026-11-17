import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { fixture, principal } from './fixture.js';

test('the hotel distribution Actions verify rated terms, approve exact orders and reconcile supplier results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fliggy-hotel-booking-'));
  const connection = join(directory, 'connection.json');
  const profile = join(directory, 'guests.json');
  const payments = join(directory, 'payments.json');
  const secret = 'synthetic-distribution-key';
  const providerId = '3035909269095214604';
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const config = { owner: principal.owner, account: 'test-account', appKey: '12345', appSecret: secret,
    distributor: 'fixture', expiresAt, enabled: true, hotelProfilesFile: profile, hotelPaymentsFile: payments };
  const write = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await Promise.all([
    write(connection, config),
    write(profile, [{ id: 'private-guests', expiresAt, contact: { name: 'Synthetic contact', phone: '1234567890' }, rooms: [['Synthetic guest']] }]),
    write(payments, []),
  ]);
  const selection = {
    standardHotelId: '123456789123456789', itemId: '4567', ratePlanId: '469', checkIn: '2030-01-02', checkOut: '2030-01-03',
    arrivalTime: '15:00', checkOutTime: '12:00', rooms: 1, adultsPerRoom: 1, profileId: 'private-guests',
  };
  let orderStatus = 0, orderNumber = '', amount = 80000, loseCreateReply = true;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://eco.taobao.com/router/rest');
    assert.equal(init?.redirect, 'error');
    const body = new URLSearchParams(init?.body as URLSearchParams), signature = body.get('sign');
    body.delete('sign'); body.sort();
    const expected = createHmac('md5', secret).update([...body].map(([key, value]) => key + value).join('')).digest('hex').toUpperCase();
    assert.equal(signature, expected);
    const method = body.get('method')!;
    const operation = method.split('.').at(-1)!;
    calls.push(operation);
    if (operation === 'price') {
      assert.equal(body.get('shids'), selection.standardHotelId);
      assert.equal(body.get('is_calendar'), 'false');
      assert.equal(body.get('checkin_date'), selection.checkIn);
      assert.equal(body.get('checkout_date'), selection.checkOut);
      return new Response(JSON.stringify({ xhotel_distribution_price_response: { hotel_prices_result: {
        error_code: 0, module: { hotel_prices: { hotel_price: [{ shid: selection.standardHotelId, name: 'Fixture property',
          room_prices: { room_price: [{ name: 'Fixture room', rate_prices: { rate_price: [{ item_id: 4567,
            rateplan_id: 469, currency_code: 'CNY', checkin_checkout_prices: {
              check_in_check_out_price: [{ checkin_date: selection.checkIn, checkout_date: selection.checkOut, price: 80000 }],
            } }] } }] },
        }] } },
      } } }));
    }
    const json = body.get(operation === 'validate' ? 'validate_req' : operation === 'create' ? 'create_req' : 'order_base_req')!;
    const request = JSON.parse(json);
    const response = (result: unknown) => new Response(JSON.stringify({
      [method.replace(/^taobao\./, '').replaceAll('.', '_') + '_response']: { is_success: true, result },
    }).replaceAll('"LARGE_ID"', providerId));
    if (operation === 'validate') {
      assert.equal(request.rate_plan_id, 469);
      assert.equal(request.check_in, '2030-01-02 15:00:00');
      assert.equal(request.check_out, '2030-01-03 12:00:00');
      return response({ hid: selection.standardHotelId, rate_plan_id: 469, create_key: 'private-create-key', rate_plan_info: {
        display_name: 'Fixture rate', total_room_price: amount, after_promotion_price: amount, earliest_check_in_time: '15:00',
        latest_check_out_time: '12:00', max_booking_num: 2, max_occupancy_num: 2, cancel_policy_do: { cancel_policy_type: 1 },
      } });
    }
    if (operation === 'create') {
      assert.equal(request.create_key, 'private-create-key');
      assert.equal(request.hotel_contact.name, 'Synthetic contact');
      assert.equal(request.total_room_price, 80000);
      orderNumber = request.out_order_id;
      orderStatus = 1;
      if (loseCreateReply) { loseCreateReply = false; throw new Error('The original provider accepted the order, then disconnected'); }
      return response({ tid: 'LARGE_ID', out_order_id: orderNumber });
    }
    assert.equal(request.dis_order_id, orderNumber);
    if (operation === 'pay') { orderStatus = 2; return response(true); }
    if (operation === 'cancel') { orderStatus = 8; return response({ cancel_success: true, forfeit_fee: 0 }); }
    return response({ order_base_info: {
      fliggy_order_id: 'LARGE_ID', dis_order_id: orderNumber, order_status: orderStatus, total_room_price: 80000,
      total_actual_price: 80000, settle_currency_code: 'CNY', is_checked_in: false,
    }, hotel_info: { hid: selection.standardHotelId }, order_fulfill_info: {
      check_in: '2030-01-02 15:00:00', check_out: '2030-01-03 12:00:00', room_number: 1,
    } });
  };
  const f = await fixture(undefined, undefined, undefined, undefined, { fliggyHotel: connection, fliggyHotelFetch: fetcher });
  try {
    const actions = f.capabilities.actions;
    const act = async (action: string, input: Record<string, unknown>, key = randomUUID()) =>
      actions.apply(await Access.load(f.db, principal), f.model, action, input, key);
    const view = async (booking: ObjectRef) => {
      const objects = new Objects(f.db, f.model, await Access.load(f.db, principal));
      return await f.capabilities.functions.invoke(f.model, 'readFliggyHotelBooking', { booking },
        { principal, objects, signal: AbortSignal.timeout(5000) }) as Record<string, unknown>;
    };
    const booking = await act('PrepareFliggyHotelBooking', { selection, bookingKey: randomUUID() });
    const preview = await view(booking);
    assert.equal(preview.state, 'previewed');
    assert.equal(preview.evidence, 'synthetic');
    assert.equal(preview.independentRead, false);
    assert(!JSON.stringify(preview).match(/Synthetic contact|Synthetic guest|private-create-key|profileDigest/));
    const approval = { booking, amountMinor: preview.amountMinor, approvedDigest: preview.approvalDigest };
    await assert.rejects(act('CreateFliggyHotelBooking', { ...approval, amountMinor: 79999 }), /explicitly approve/);
    amount = 81000;
    await assert.rejects(act('CreateFliggyHotelBooking', approval), /changed after review/);
    amount = 80000;
    await assert.rejects(act('CreateFliggyHotelBooking', approval), /unresolved result/);
    await assert.rejects(act('CreateFliggyHotelBooking', approval), /reconcile/);
    assert.equal(calls.filter(operation => operation === 'create').length, 1);
    await act('RefreshFliggyHotelBooking', { booking });
    const placed = await view(booking);
    assert.equal(placed.merchantOrderId, providerId);
    assert.equal(placed.state, 'awaiting_payment');
    assert.equal(placed.independentRead, true);
    await assert.rejects(act('ConfirmFliggyHotelPayment', approval), /Verified buyer payment/);
    assert.equal(calls.filter(operation => operation === 'pay').length, 0);
    await write(payments, [{ orderId: providerId, outOrderId: orderNumber, receiptId: 'synthetic-buyer-receipt',
      amountMinor: 80000, currency: 'CNY', receivedAt: new Date().toISOString() }]);
    await act('ConfirmFliggyHotelPayment', approval);
    assert.equal((await view(booking)).state, 'pending_confirmation');
    await act('ConfirmFliggyHotelPayment', approval);
    assert.equal(calls.filter(operation => operation === 'pay').length, 1);
    orderStatus = 3;
    await act('RefreshFliggyHotelBooking', { booking });
    assert.equal((await view(booking)).state, 'confirmed');
    await act('CancelFliggyHotelBooking', approval);
    assert.equal((await view(booking)).state, 'cancelled');
    assert.equal(calls.filter(operation => operation === 'cancel').length, 1);
    await setGrants(f.db, principal.owner, businessGrants(f.model).filter(grant => grant.resource !== 'Eigos/source/FliggyHotelDistribution'));
    await assert.rejects(view(booking), /Permission required/);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
