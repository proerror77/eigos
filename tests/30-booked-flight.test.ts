import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest } from '../packages/core/identity.js';
import { Objects } from '../packages/runtime/objects.js';
import { ObservationInterests } from '../packages/runtime/observation-interests.js';
import { bookedFlightWatchConsent } from '../packages/ontology/flight.js';
import { bookedFlightCheckDelay } from '../packages/capabilities/flight/functions.js';
import { fixture, principal } from './fixture.js';

test('authorized two-week booking interest follows the confirmed ticket, samples intermediate operational changes and delivers to the PA once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eigos-booked-flight-'));
  const day = 86_400_000,
    now = Date.now(),
    date = new Date(now + 14 * day).toISOString().slice(0, 10);
  const deadline = new Date(date + 'T21:00:00+08:00').toISOString();
  const write = (name: string, body: unknown) => writeFile(join(dir, name), JSON.stringify(body), { mode: 0o600 });
  const key = 'synthetic-booked-aviation-key',
    secret = join(dir, 'read-key');
  await writeFile(secret, key, { mode: 0o600 });
  const validUntil = new Date(now + 20 * day).toISOString();
  await write('aviation.json', {
    owner: principal.owner,
    active: true,
    expiresAt: validUntil,
    keyFile: secret,
    keySha256: createHash('sha256').update(key).digest('hex'),
  });
  const partnerConfig = {
    owner: principal.owner,
    account: 'test',
    appKey: '12345',
    appSecret: 'synthetic-key',
    session: 'synthetic-session',
    expiresAt: validUntil,
    channelName: 'test',
    flightProfilesFile: join(dir, 'unused-passengers'),
    enabled: true,
  };
  await write('partner.json', partnerConfig);
  await write('pa.json', {
    owner: principal.owner,
    endpoint: 'https://api2.cursor.sh/automations/webhook/12345678-abcd-abcd-abcd-1234567890ab',
    keyFile: secret,
    objectTypes: ['FlightWatch'],
  });
  let reads = 0,
    paid = false,
    issued = false,
    gate = 'A1',
    code = 0,
    stamp = now;
  const partnerCalls: string[] = [];
  const segment = {
    dep_airport: 'PEK',
    arr_airport: 'SHA',
    marketing_flight_no: 'MU5102',
    dep_time: date + ' 10:00:00',
    arr_time: date + ' 12:00:00',
  };
  const partnerCall: typeof fetch = async (_url, init) => {
    const request = new URLSearchParams(init?.body as URLSearchParams),
      method = request.get('method')!;
    const op = method.split('.').at(-1)!;
    partnerCalls.push(op);
    const reply = (body: unknown) => Response.json({ [method.replaceAll('.', '_') + '_response']: body });
    if (op === 'pay') {
      assert.equal(JSON.parse(request.get('pay_request')!).order_id, 234);
      assert.equal(paid, false);
      paid = true;
      return reply({ is_success: true, order_id: '234' });
    }
    assert.equal(op, 'queryorderdetail');
    assert.equal(JSON.parse(request.get('query_order_detail_req')!).out_order_no, '1');
    return reply({
      is_success: true,
      order_id: '234',
      out_order_no: '1',
      order_status: issued ? '出票成功' : paid ? '已支付' : '生单预定成功',
      total_price: 110,
      real_pay_price: paid ? 110 : 0,
      flight_route: {
        trip_type: 1,
        flight_journey_list: {
          flight_journey: [{ flight_segment_list: { flight_segment: [{ ...segment, id: 'original-segment' }] } }],
        },
      },
      ...(paid ? { pay_status: 'PAID', pay_time: date + ' 01:00:00', trade_no: 'synthetic-payment' } : {}),
      ...(issued
        ? {
            flight_book_order_detail_list: {
              flight_book_order_detail: [{ ticket_nos: { string: ['8702222211119'] } }],
            },
          }
        : {}),
    });
  };
  const aviationCall: typeof fetch = async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    const req = JSON.parse(String(init?.body));
    const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id: req.id, result });
    if (req.method === 'initialize')
      return respond({
        protocolVersion: req.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'synthetic', version: '1' },
      });
    if (req.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    assert.equal(req.params.name, 'searchFlightsByNumber');
    assert.deepEqual(req.params.arguments, { fnum: 'MU5102', date, dep: 'PEK', arr: 'SHA' });
    reads++;
    stamp = Math.max(stamp + 1, Date.now());
    return respond({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            code: 200,
            timestamp: new Date(stamp).toISOString(),
            data: [
              {
                FlightNo: 'MU5102',
                FlightCompany: 'Test',
                FlightDepcode: 'PEK',
                FlightArrcode: 'SHA',
                FlightDeptimePlanDate: date + ' 10:00:00',
                FlightArrtimePlanDate: date + ' 12:00:00',
                org_timezone: '28800',
                dst_timezone: '28800',
                BoardGate: gate,
                FlightStateNum: code,
              },
            ],
          }),
        },
      ],
    });
  };
  const deliveries: { version: number; operation: string; flight: { changes: string[]; gate: string } | null }[] = [];
  const f = await fixture(undefined, undefined, undefined, undefined, {
    fliggyFlight: join(dir, 'partner.json'),
    fliggyFlightFetch: partnerCall,
    variFlight: join(dir, 'aviation.json'),
    variFlightFetch: aviationCall,
    travelPA: join(dir, 'pa.json'),
    travelPAFetch: async (_url, init) => {
      deliveries.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    },
  });
  try {
    const graph = new Objects(f.db, f.model, f.access),
      booking = { type: 'FliggyFlightBooking', id: 'booked-segment' };
    const authority = digest([
      principal.owner,
      partnerConfig.appKey,
      partnerConfig.account,
      partnerConfig.channelName,
      partnerConfig.session,
    ]);
    await graph.create(booking, {
      id: booking.id,
      name: 'MU5102',
      authority,
      profileDigest: 'synthetic',
      approvalDigest: 'a'.repeat(64),
      outOrderNo: '1',
      merchantOrderId: '234',
      supplierStatus: '生单预定成功',
      paid: false,
      issued: false,
      closed: false,
      issuanceState: 'unpaid',
      profileId: 'synthetic',
      observedAt: new Date().toISOString(),
      expiresAt: validUntil,
      independentRead: true,
      evidence: 'synthetic',
      search: { origin: 'BJS', destination: 'SHA', departureDate: date },
      quote: {
        itemId: 'test',
        segment,
        cabin: 'Y',
        fareYuan: 100,
        fuelYuan: 5,
        constructionYuan: 5,
        taxYuan: 10,
        amountMinor: 11000,
        currency: 'CNY',
        refundTerms: 'synthetic',
      },
    });
    const context = { principal, objects: graph, signal: AbortSignal.timeout(60_000) };
    const request = { booking, monitorUntil: deadline, maxChecks: 24 };
    const approved = bookedFlightWatchConsent.parse(
      await f.capabilities.functions.invoke(f.model, 'prepareBookedFlightWatch', request, context),
    );
    const start = (args: Record<string, unknown>) =>
      f.capabilities.actions.apply(f.access, f.model, 'StartBookedFlightWatch', args, randomUUID());
    await assert.rejects(start(approved), /confirmed ticket/);
    assert.equal(reads, 0);
    const { booking: _booking, ...parameters } = approved;
    const interests = new ObservationInterests(f.db, f.metadata);
    const setup = {
      requestId: 'ticket-through-arrival',
      object: booking,
      deadline,
      phases: [
        {
          name: 'Confirm ticket',
          process: 'FliggyFlightBookingIssuanceStateLog',
          complete: ['issued'],
          stop: ['closed'],
          action: 'RefreshFliggyFlightBooking',
        },
        {
          name: 'Flight operations',
          process: 'FliggyFlightBookingIssuanceStateLog',
          complete: [],
          stop: ['closed'],
          action: 'StartBookedFlightWatch',
          parameters,
          attach: {
            link: 'itineraryWatches',
            process: 'FlightWatchStateLog',
            complete: ['completed'],
            stop: ['ended', 'cancelled'],
          },
        },
      ],
    };
    await f.capabilities.actions.apply(
      f.access,
      f.model,
      'PayFliggyFlightBooking',
      { booking, approvedDigest: 'a'.repeat(64), amountMinor: 11000 },
      'explicit-approved-payment',
    );
    assert.equal((await graph.read(booking)).properties.issuanceState, 'awaiting_issuance');
    const interest = await interests.start(f.access, f.model, setup);
    assert.equal((await interests.start(f.access, f.model, setup)).id, interest.id);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scheduled_actions`)).rows[0]!.n, 1);
    issued = true;
    const dueSchedules = () =>
      f.db.query(`UPDATE ${f.db.schema}.scheduled_actions SET run_at=clock_timestamp()-interval '1 second'
      WHERE state='scheduled'`);
    await dueSchedules();
    assert(await f.worker.runOne('scheduled'));
    assert.equal((await graph.read(booking)).properties.issuanceState, 'issued');
    await assert.rejects(
      start({ ...approved, bookingDigest: '0'.repeat(64) }),
      /original independently confirmed ticket/,
    );
    await assert.rejects(start({ ...approved, sourceAuthorities: { VariFlight: '0'.repeat(64) } }), /bindings changed/);
    const scan = async () => {
      await f.db.query(`UPDATE ${f.db.schema}.observation_interests SET next_scan=now() WHERE id=$1`, [interest.id]);
      assert(await interests.scanOne());
    };
    await scan();
    await dueSchedules();
    assert(await f.worker.runOne('scheduled'));
    const linked = await graph.follow(booking, 'itineraryWatches');
    assert.equal(linked.length, 1);
    const watch = linked[0]!.ref;
    const sample = async () => {
      await dueSchedules();
      await f.db.query(
        `UPDATE ${f.db.schema}.tasks SET available_at=now() WHERE id=(SELECT task_id FROM ${f.db.schema}.scheduled_actions WHERE id=$1) AND state='submitted'`,
        [linked[0]!.properties.scheduleId],
      );
      assert(await f.worker.runOne('scheduled'));
      return graph.read(watch);
    };
    const first = await sample();
    assert.equal(reads, 1);
    assert.equal(deliveries.length, 0);
    assert(Date.parse(String(first.properties.nextCheckAt)) - Date.now() > day);
    gate = 'B2';
    code = 4;
    await sample();
    assert(await f.capabilities.effects.runOne());
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.flight?.gate, 'B2');
    assert.deepEqual(deliveries[0]!.flight?.changes, ['status', 'gate']);
    await sample();
    assert.equal(await f.capabilities.effects.runOne(), false);
    gate = 'C4';
    await sample();
    // A pending update is not delivered if the original authorization is withdrawn in the meantime.
    await interests.cancel(f.access, f.model, { id: interest.id });
    assert(await f.capabilities.effects.runOne());
    assert.equal(deliveries.length, 1);
    const readsAtCancel = reads;
    assert.equal(await f.worker.runOne('scheduled'), false);
    assert.equal(reads, readsAtCancel);
    const final = (await f.capabilities.functions.invoke(f.model, 'readFlightWatch', { watch }, context)) as {
      alert: unknown;
      state: string;
    };
    assert.equal(final.alert, null);
    assert.equal(final.state, 'ended');
    assert.deepEqual(partnerCalls, ['queryorderdetail', 'pay', 'queryorderdetail', 'queryorderdetail']);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a two-week watch distributes its finite supplier checks across travel stages', () => {
  const minute = 60_000,
    day = 24 * 60 * minute;
  const departure = 14 * day,
    deadline = departure + 4 * 60 * minute,
    budget = 24;
  const checks: number[] = [0];
  while (checks.length < budget) {
    const now = checks.at(-1)!;
    const next = Math.min(
      deadline - minute,
      now + bookedFlightCheckDelay(departure, deadline, budget - checks.length, now),
    );
    if (next <= now + minute) break;
    checks.push(next);
  }
  assert(checks.some((t) => t > 0 && t < departure - 7 * day));
  assert(checks.some((t) => t >= departure - 2 * day && t < departure - day));
  assert(checks.some((t) => t >= departure - 3 * 60 * minute && t < departure));
  assert(checks.some((t) => t >= departure && t < deadline));
  assert(checks.every((t) => t < deadline));
  assert.equal(checks.at(-1), deadline - minute);
  assert(checks.length <= budget);
});
