import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { searchFliggy, type FlyAIRead } from '../packages/capabilities/fliggy/connector.js';
import { FLIGGY_CLI_GUARD } from '../packages/capabilities/fliggy/cli-guard.js';
import { configuredServices } from '../packages/capabilities/services/sources.js';
import { travelHandoffResult } from '../packages/ontology/travel-handoff.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';
import { serviceProvider } from './service-fixture.js';

const flight = { origin: '上海', destination: '北京', departureDate: '2030-01-02', returnDate: '2030-01-05', directOnly: true, limit: 3 };
const hotel = { place: '北京', checkIn: '2030-01-02', nights: 3, adults: 2, limit: 3 };
const sourcePage = (itemList: unknown[]) => ({ status: 0, message: 'success', systemMessage: '体验模式', data: { itemList } });
const journey = (flightNumber: string, from: string, to: string, date: string) => ({
  journeyType: '直达', totalDuration: '60', segments: [{
    marketingTransportNo: flightNumber, marketingTransportName: 'Fixture carrier', seatClassName: '经济舱',
    depStationCode: from, depDateTime: date + ' 08:00:00', arrStationCode: to, arrDateTime: date + ' 09:00:00',
  }],
});
const flightItem = (flightNumber: string) => ({
  journeys: [journey(flightNumber, 'SHA', 'PEK', flight.departureDate), journey('T0003', 'PEK', 'SHA', flight.returnDate)],
  ticketPrice: '450起', jumpUrl: 'https://router.feizhu.com/search',
});
const hotelItem = (id: string, price: string) => ({
  shId: id, name: 'Fixture ' + id, address: 'Synthetic address', price, detailUrl: 'https://router.feizhu.com/hotel',
});

test('a PA task queries flights and both hotel sources concurrently and retains independent outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-flyai-fixture-'));
  const file = join(directory, 'services.json');
  const binding = {
    owner: principal.owner, provider: 'Fliggy', bindingId: 'fixture-fliggy', mode: 'trial', active: true,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
  const setConnection = (value: Record<string, unknown>) => writeFile(file, JSON.stringify([value]), { mode: 0o600 });
  await setConnection(binding);
  const started = new Set<string>();
  let releaseSuppliers!: () => void;
  const allStarted = new Promise<void>(resolve => { releaseSuppliers = resolve; });
  const waitForOtherSuppliers = async (source: string) => {
    started.add(source);
    if (started.size === 3) releaseSuppliers();
    await Promise.race([
      allStarted,
      delay(5000, undefined, { ref: false }).then(() => { throw new Error('Supplier reads did not overlap'); }),
    ]);
  };
  const transport: FlyAIRead = async (command, criteria, key) => {
    await waitForOtherSuppliers(command);
    assert.equal(key, undefined);
    if (command === 'search-flight') {
      assert.deepEqual(criteria, { origin: '上海', destination: '北京', depDate: flight.departureDate, backDate: flight.returnDate, journeyType: 1 });
      return sourcePage([flightItem('T0001'), flightItem('T0002'), flightItem('T0001')]);
    }
    assert.deepEqual(criteria, { destName: '北京', checkInDate: hotel.checkIn, checkOutDate: '2030-01-05' });
    return sourcePage([hotelItem('hotel-a', '¥2xx'), hotelItem('hotel-b', '¥500起')]);
  };
  const flyai = configuredServices(file, transport), rolling = serviceProvider();
  let rollingFails = false;
  const f = await fixture({
    model: 'recorded-travel-search-decisions',
    async run(prompt, tools) {
      assert.match(prompt, /TravelOfferInquiry.search Interface Action on TravelOfferSearch so the supplier reads run concurrently/);
      await tools.get('complete_with_action')!.invoke({
        action: {
          interface: { type: 'TravelOfferInquiry', implementation: 'TravelOfferSearch', action: 'search' },
          input: { flight, hotel },
        },
        read: { function: 'readTravelOfferSearch', resultParameter: 'search' },
      });
    },
  }, async (owner, provider) => {
    if (provider === 'Fliggy') return flyai(owner, provider);
    const source = await rolling.resolve(owner, provider);
    return {
      ...source,
      async read(input, signal) {
        await waitForOtherSuppliers('rollinggo-hotel');
        if (rollingFails) throw new Error('Private supplier diagnostic');
        return source.read(input, signal);
      },
    };
  });
  try {
    const task = await f.tasks.submit(principal, { requestId: 'travel-search', message: '查上海到北京的往返机票，比较飞猪和 RollingGo 的酒店' });
    await f.worker.runOne();
    const finished = await f.tasks.get(principal, task.id);
    assert.equal(finished.state, 'completed', finished.error ?? '');
    type Page = { search: { ref: ObjectRef; properties: Record<string, unknown> }; items: Array<{ ref:ObjectRef; properties: Record<string, unknown> }>; complete: boolean };
    const { search, outcomes, pages } = finished.result as {
      search: ObjectRef; outcomes: Array<{ source: string; status: string }>; pages: Page[];
    };
    assert.equal(started.size, 3);
    assert.equal(search.type, 'TravelOfferSearch');
    assert.deepEqual(outcomes, [
      { source: 'RollingGoHotels', status: 'searched' },
      { source: 'FliggyHotels', status: 'searched' },
      { source: 'FliggyFlights', status: 'searched' },
    ]);
    const [, hotels, flights] = pages as [Page, Page, Page];
    assert.deepEqual(pages.map(page => page.search.ref.type), ['RollingGoHotelSearch', 'FliggyHotelSearch', 'FliggyFlightSearch']);
    assert.deepEqual(pages.map(page => page.items.length), [1, 2, 2]);
    assert.deepEqual(pages.map(page => page.search.properties.provider), ['RollingGo', 'Fliggy', 'Fliggy']);
    assert.equal(flights.complete, false);
    assert.equal(flights.search.properties.accessMode, 'trial');
    assert.equal(flights.search.properties.evidence, 'provider_mock');
    assert.equal(flights.items[0]!.properties.priceDisplay, '450起');
    assert.equal((flights.items[0]!.properties.journeys as unknown[]).length, 2);
    assert.deepEqual(new Set(hotels.items.map(item => item.properties.priceDisplay)), new Set(['¥2xx', '¥500起']));
    assert(hotels.items.every(item => item.properties.amount === null && item.properties.occupancyVerified === false));
    const prepareHandoff = (offer: ObjectRef, search: ObjectRef, requestId = 'handoff-'+offer.id) =>
      f.capabilities.actions.apply(f.access, f.model, 'PrepareFliggyTravelHandoff', { offer, search }, requestId);
    const readHandoff = async (handoff: ObjectRef) => travelHandoffResult.parse(await f.capabilities.functions.invoke(
      f.model, 'readFliggyTravelHandoff', { handoff }, { principal, objects: new Objects(f.db, f.model, await Access.load(f.db,principal)), signal: AbortSignal.timeout(5000) }));
    const picks = [];
    for(const [kind, page] of [['hotel',hotels],['flight',flights]] as const) {
      const chosen=page.items[1]!;
      const handoff=await prepareHandoff(chosen.ref,page.search.ref);
      assert.deepEqual(await prepareHandoff(chosen.ref,page.search.ref),handoff);
      const result=await readHandoff(handoff);
      assert.equal(result.status,'ready_for_review');assert.equal(result.selection.kind,kind);
      assert.equal(result.accessMode,'trial');assert.equal(result.evidence,'provider_mock');
      assert.equal(result.url,chosen.properties.url);assert.deepEqual(result.offer,chosen.ref);
      assert.deepEqual(result.search,page.search.ref);assert.equal(result.selection.details.name,chosen.properties.name);
      assert.equal(result.selection.details.priceDisplay,chosen.properties.priceDisplay);
      picks.push(handoff);
    }
    await assert.rejects(prepareHandoff(flights.items[0]!.ref,hotels.search.ref,'wrong-kind'),/matching search page/);
    await assert.rejects(prepareHandoff(flights.items[0]!.ref,{...flights.search.ref,id:'different-receipt'},'wrong-page'),/superseded|unavailable/);
    const graph = new Objects(f.db, f.model, f.access);
    assert.equal((await graph.query({ type: 'HotelOffer' })).items.length, 3);
    assert.equal((await graph.query({ type: 'FlightOffer' })).items.length, 2);

    await setGrants(f.db, principal.owner, memberGrants(f.model).filter(grant => grant.resource !== 'Eigos/source/Fliggy'));
    const read = async () => f.capabilities.functions.invoke(f.model, 'readServiceSearchPages', { searches: [flights.search.ref] },
      { principal, objects: new Objects(f.db, f.model, await Access.load(f.db, principal)), signal: AbortSignal.timeout(5000) });
    await assert.rejects(read, /Permission required/);
    const readTravel = async (search: ObjectRef) => f.capabilities.functions.invoke(f.model, 'readTravelOfferSearch', { search },
      { principal, objects: new Objects(f.db, f.model, await Access.load(f.db, principal)), signal: AbortSignal.timeout(5000) });
    await assert.rejects(readTravel(search), /Permission required/);
    await assert.rejects(readHandoff(picks[0]!), /Permission required/);
    const searchHotels = async (id: string) => f.capabilities.actions.apply(
      await Access.load(f.db, principal), f.model, 'SearchTravelOffers', { hotel }, id,
    );
    const rollingOnly = await readTravel(await searchHotels('fliggy-not-authorized')) as { outcomes: unknown; pages: Page[] };
    assert.deepEqual(rollingOnly.outcomes, [
      { source: 'RollingGoHotels', status: 'searched' },
      { source: 'FliggyHotels', status: 'authorization_required' },
    ]);
    assert.deepEqual(rollingOnly.pages.map(page => page.search.ref.type), ['RollingGoHotelSearch']);

    await setGrants(f.db, principal.owner, memberGrants(f.model));
    await setConnection({ ...binding, expiresAt: new Date(Date.now() + 600000).toISOString() });
    await assert.rejects(read, /account changed/);
    await assert.rejects(readHandoff(picks[0]!), /account changed/);
    await assert.rejects(flyai('other-owner', 'Fliggy'), /no owner connection/);

    rollingFails = true;
    const retryTask = await f.tasks.submit(principal, { requestId: 'rollinggo-unavailable', message: '比较两家酒店与飞猪往返机票' });
    await f.worker.runOne();
    const retryResult = await f.tasks.get(principal, retryTask.id);
    assert.equal(retryResult.state, 'completed');
    const fliggyOnly = retryResult.result as { outcomes: unknown; pages: Page[] };
    assert.deepEqual(fliggyOnly.outcomes, [
      { source: 'RollingGoHotels', status: 'unavailable' },
      { source: 'FliggyHotels', status: 'searched' },
      { source: 'FliggyFlights', status: 'searched' },
    ]);
    assert.deepEqual(fliggyOnly.pages.map(page => page.search.ref.type), ['FliggyHotelSearch', 'FliggyFlightSearch']);
    assert(!JSON.stringify(fliggyOnly).includes('Private supplier diagnostic'));
    const calls = await f.db.query(`SELECT state FROM ${f.db.schema}.source_calls WHERE task_id=$1 ORDER BY state`, [retryTask.id]);
    assert.deepEqual(calls.rows.map(row => row.state), ['completed', 'completed', 'failed']);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('FlyAI rejects mismatched dates and malformed empty responses and preserves display fares', async () => {
  const signal = AbortSignal.timeout(10000);
  await assert.rejects(searchFliggy(flight, undefined, signal, async () => sourcePage([{
    ...flightItem('T0001'), journeys: [journey('T0001', 'SHA', 'PEK', '2030-01-03'), flightItem('T0001').journeys[1]],
  }])), /invalid source response/);
  await assert.rejects(searchFliggy(hotel, undefined, signal, async () => ({ status: 0, message: 'success', data: null })), /invalid source response/);
  await assert.rejects(searchFliggy(hotel, undefined, signal, async () => ({ status: 1, message: 'rate limited', data: null })), /invalid source response/);
  assert.deepEqual(await searchFliggy(hotel, undefined, signal, async () => ({ status: 0, message: 'empty', data: null })), { kind: 'hotel', items: [] });
  const page = await searchFliggy(hotel, undefined, signal, async () => sourcePage([{
    ...hotelItem('a', '¥1xx'), detailUrl: 'https://fliggy.com.untrusted.invalid/',
  }]));
  assert.equal(page.items[0]?.url, undefined);
  assert.equal(page.items[0]?.priceDisplay, '¥1xx');
  await assert.rejects(searchFliggy(hotel, 'synthetic-flyai-key', signal, async () => sourcePage([hotelItem('a', '¥1xx')])), /invalid source response/);
});

test('the official CLI guard allows one matching read and blocks other tools, accounts and redirects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-flyai-guard-'));
  const fake = join(directory, 'fake.cjs'), guard = join(directory, 'guard.cjs'), policy = join(directory, 'policy.json'), transport = join(directory, 'transport.cjs');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const source = `
  (async () => {
    let result = 'allowed';
    try {
      const request = {method:'POST',headers:{Authorization:'Bearer '+process.env.SUPPLIED_KEY},body:JSON.stringify({
        method:'tools/call',params:{name:process.env.TOOL,arguments:{destName:'Synthetic',limit:10}}
      })};
      await fetch('https://flyai.open.fliggy.com/mcp',request);
      if (process.env.REPEAT === 'yes') await fetch('https://flyai.open.fliggy.com/mcp',request);
    } catch { result = 'blocked'; }
    console.log(JSON.stringify({ result, calls: global.calls }));
  })();
  `;
  try {
    await writeFile(fake, source);
    await writeFile(guard, FLIGGY_CLI_GUARD);
    await writeFile(transport, "global.calls=0; globalThis.fetch=async()=>{global.calls++;return new Response('{}',{status:Number(process.env.STATUS)});};");
    await writeFile(policy, JSON.stringify({
      cli: fake, cliSha256: hash(source), tool: 'search_hotels', args: { destName: 'Synthetic', limit: 10 }, keySha256: hash('synthetic-key'),
    }));
    const attempt = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ['--require', transport, '--require', guard, fake], {
      env: { EIGOS_FLIGGY_POLICY_FILE: policy, TOOL: 'search_hotels', SUPPLIED_KEY: 'synthetic-key', STATUS: '200', ...env },
      encoding: 'utf8', timeout: 5000,
    }));
    assert.deepEqual(attempt({}), { result: 'allowed', calls: 1 });
    assert.deepEqual(attempt({ TOOL: 'create_order' }), { result: 'blocked', calls: 0 });
    assert.deepEqual(attempt({ SUPPLIED_KEY: 'wrong-account' }), { result: 'blocked', calls: 0 });
    assert.deepEqual(attempt({ STATUS: '302' }), { result: 'blocked', calls: 1 });
    assert.deepEqual(attempt({ REPEAT: 'yes' }), { result: 'blocked', calls: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a FlyAI handoff requires a supplier link, its exact current receipt and unmodified offer facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fliggy-handoff-'));
  const file = join(directory,'trial.json');
  await writeFile(file, JSON.stringify([{owner:principal.owner,provider:'Fliggy',bindingId:'handoff-fixture',mode:'trial',
    active:true,expiresAt:new Date(Date.now()+300000).toISOString()}]),{mode:0o600});
  const service=configuredServices(file,async()=>sourcePage([
    hotelItem('with-link','¥3xx'), {...hotelItem('without-link','¥1xx'),detailUrl:null},
    {...hotelItem('untrusted','¥2xx'),detailUrl:'https://untrusted.example.invalid/hotel'},
  ]));
  const f=await fixture(undefined,service);
  try {
    const act=(name:string,input:Record<string,unknown>,id:string)=>f.capabilities.actions.apply(f.access,f.model,name,input,id);
    const graph=new Objects(f.db,f.model,f.access);
    const first=await act('SearchFliggyHotels',hotel,'first-page');
    const offers=await graph.follow(first,'results');
    assert.equal(offers.length,3);
    for(const offer of offers.filter(item=>item.properties.nativeId!=='with-link'))
      await assert.rejects(act('PrepareFliggyTravelHandoff',{offer:offer.ref,search:first},'bad-'+offer.ref.id),/no supported supplier detail link/);
    const chosen=offers.find(x=>x.properties.nativeId==='with-link')!;
    const handoff=await act('PrepareFliggyTravelHandoff',{offer:chosen.ref,search:first},'chosen');
    const read=()=>f.capabilities.functions.invoke(f.model,'readFliggyTravelHandoff',{handoff},
      {principal,objects:graph,signal:AbortSignal.timeout(5000)});
    assert.equal(travelHandoffResult.parse(await read()).selection.details.priceDisplay,'¥3xx');
    const second=await act('SearchFliggyHotels',hotel,'second-page');
    assert.notDeepEqual(first,second);
    await assert.rejects(read(),/superseded|selection changed/i);
    await graph.edit(chosen.ref,(await graph.read(chosen.ref)).revision,{url:'https://router.feizhu.com/overridden'});
    await assert.rejects(act('PrepareFliggyTravelHandoff',{offer:chosen.ref,search:second},'override'),/locally overridden/);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.external_operations`)).rows[0]!.n,0);
  } finally {
    await f.close();await rm(directory,{recursive:true,force:true});
  }
});
