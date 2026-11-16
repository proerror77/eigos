import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { digest, InvalidInput, SourceReadFailure } from '../../core/identity.js';
import { flightFacts, flightSearchInput, fliggyHotelFacts, hotelSearchInput, shortText } from '../../ontology/service-contracts.js';
import { FLIGGY_CLI_GUARD } from './cli-guard.js';

const cliSha256 = '194a66eb84094f3d8ee20fac0a2d6cae10a405cd59ac100b7e7880ebc97297da'; // @fly-ai/flyai-cli@1.0.16
const require = createRequire(import.meta.url), run = promisify(execFile);
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const commands = { 'search-flight': 'search_flight', 'search-hotel': 'search_hotels' } as const;
export type FlyAIRead = (
  command: keyof typeof commands,
  criteria: Record<string, string | number>,
  key: string | undefined,
  signal: AbortSignal,
) => Promise<unknown>;

/** The official CLI signs the query. The preload confines its single supplier request. */
const readFlyAI: FlyAIRead = async (command, criteria, key, signal) => {
  const cli = join(dirname(require.resolve('@fly-ai/flyai-cli/package.json')), 'dist/flyai-bundle.cjs');
  if (hash(await readFile(cli)) !== cliSha256) throw new Error('Unexpected FlyAI CLI build');
  const directory = await mkdtemp(join(tmpdir(), 'eigos-flyai-'));
  try {
    const guard = join(directory, 'guard.cjs'), policy = join(directory, 'policy.json');
    await writeFile(guard, FLIGGY_CLI_GUARD, { mode: 0o600 });
    await writeFile(policy, JSON.stringify({
      cli, cliSha256, tool: commands[command], args: { ...criteria, limit: 10 },
      ...(key ? { keySha256: hash(key) } : {}),
    }), { mode: 0o600 });
    const args = ['--require', guard, cli, command];
    for (const [name, value] of Object.entries(criteria)) {
      const flag = name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
      args.push('--' + flag + '=' + value);
    }
    const { stdout } = await run(process.execPath, args, {
      env: { LANG: 'C.UTF-8', FLYAI_JSON: '1', EIGOS_FLIGGY_POLICY_FILE: policy, ...(key ? { FLYAI_API_KEY: key } : {}) },
      signal, timeout: 25000, maxBuffer: 1048576, windowsHide: true,
    });
    if (key && stdout.includes(key)) throw new Error('Credential echoed by FlyAI');
    return JSON.parse(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const display = z.union([z.string().trim().max(500), z.number().finite().transform(String)]).nullish();
const providerTime = z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/);
const rawSegment = z.object({
  marketingTransportNo: shortText, marketingTransportName: display, seatClassName: display,
  depStationCode: shortText, depStationName: display, depTerm: display, depDateTime: providerTime,
  arrStationCode: shortText, arrStationName: display, arrTerm: display, arrDateTime: providerTime,
});
const rawFlight = z.object({
  journeys: z.array(z.object({
    journeyType: shortText, totalDuration: display, segments: z.array(rawSegment).min(1).max(10),
  })).min(1).max(2),
  ticketPrice: display, adultPrice: display, jumpUrl: z.string().nullish(),
});
const rawHotel = z.object({
  shId: display, shid: display, name: shortText, address: z.string().max(1500).nullish(),
  price: display, detailUrl: z.string().nullish(),
});
const sourcePage = z.object({
  status: z.literal(0), message: z.string(), systemMessage: z.string().optional(),
  data: z.object({ itemList: z.array(z.unknown()).max(100) }).nullable(),
});

function providerLink(raw: string | null | undefined) {
  if (!raw || raw.length > 2000) return;
  const url = URL.parse(raw);
  if (url?.protocol === 'https:' && !url.username && !url.password
    && ['feizhu.com', 'fliggy.com', 'taobao.com', 'tmall.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
    return url.href.length <= 2000 ? url.href : undefined;
  }
}

function flightOffer(raw: unknown, q: z.infer<typeof flightSearchInput>) {
  const source = rawFlight.parse(raw);
  const expected = q.returnDate ? [q.departureDate, q.returnDate] : [q.departureDate];
  if (source.journeys.length !== expected.length || source.journeys.some((journey, i) =>
    journey.segments[0]!.depDateTime.slice(0, 10) !== expected[i])) {
    throw new Error('FlyAI returned different flight dates');
  }
  if (q.directOnly === true && source.journeys.some(journey => journey.segments.length !== 1))
    throw new Error('FlyAI returned a connecting flight for a nonstop search');
  const journeys = source.journeys.map(journey => ({
    kind: journey.journeyType,
    durationMinutes: /^\d{1,5}$/.test(journey.totalDuration ?? '') ? Number(journey.totalDuration) : undefined,
    segments: journey.segments.map(segment => ({
      flightNumber: segment.marketingTransportNo,
      carrier: segment.marketingTransportName || undefined,
      cabin: segment.seatClassName || undefined,
      departureAirport: segment.depStationCode,
      departureAirportName: segment.depStationName || undefined,
      departureTerminal: segment.depTerm || undefined,
      departureLocal: segment.depDateTime,
      arrivalAirport: segment.arrStationCode,
      arrivalAirportName: segment.arrStationName || undefined,
      arrivalTerminal: segment.arrTerm || undefined,
      arrivalLocal: segment.arrDateTime,
    })),
  }));
  const itinerary = journeys.map(journey => journey.segments.map(
    ({ flightNumber, cabin, departureAirport, departureLocal, arrivalAirport, arrivalLocal }) =>
      [flightNumber, cabin, departureAirport, departureLocal, arrivalAirport, arrivalLocal],
  ));
  return flightFacts.parse({
    nativeId: digest(itinerary),
    name: journeys.map(journey => journey.segments.map(segment => segment.flightNumber).join(' + ')).join(' / '),
    url: providerLink(source.jumpUrl),
    journeys,
    priceDisplay: source.ticketPrice || null,
    adultFareDisplay: source.adultPrice || null,
  });
}

function hotelOffer(raw: unknown, q: z.infer<typeof hotelSearchInput>) {
  const source = rawHotel.parse(raw);
  if (source.shId && source.shid && source.shId !== source.shid) throw new Error('FlyAI hotel identifiers disagree');
  return fliggyHotelFacts.parse({
    nativeId: source.shId || source.shid,
    name: source.name,
    address: source.address ?? '',
    url: providerLink(source.detailUrl),
    checkIn: q.checkIn,
    nights: q.nights,
    adults: q.adults,
    currency: q.currency,
    amount: null,
    priceKind: 'reference',
    priceDisplay: source.price || null,
    occupancyVerified: false,
  });
}

function distinct<T extends { nativeId: string }>(items: T[], limit: number) {
  const byId = new Map<string, T>();
  for (const item of items) if (!byId.has(item.nativeId)) byId.set(item.nativeId, item);
  return [...byId.values()].slice(0, limit);
}

export async function searchFliggy(input: Record<string, unknown>, key: string | undefined, signal: AbortSignal, read: FlyAIRead = readFlyAI) {
  if (key !== undefined && !/^[\x21-\x7E]{16,2048}$/.test(key)) throw new SourceReadFailure('FlyAI API Key configuration is invalid', { unavailable: true });
  const request = async (command: keyof typeof commands, criteria: Record<string, string | number>) => {
    signal.throwIfAborted();
    const page = sourcePage.parse(await read(command, criteria, key, signal));
    signal.throwIfAborted();
    const isTrial = page.systemMessage?.includes('体验模式') === true;
    if ((isTrial && key) || (!isTrial && !key && page.data?.itemList.length)) throw new Error('FlyAI account mode did not match the connection');
    if (page.message === 'empty' ? page.data?.itemList.length : !page.data) throw new Error('FlyAI response had no valid result page');
    return page.data?.itemList ?? [];
  };
  if ('departureDate' in input) {
    const q = flightSearchInput.parse(input);
    const origin = q.origin.trim(), destination = q.destination.trim();
    if (!origin || !destination || origin.toLowerCase() === destination.toLowerCase() || q.returnDate && q.returnDate < q.departureDate)
      throw new InvalidInput('FlyAI requires different origin and destination, with return on or after departure');
    try {
      const raw = await request('search-flight', {
        origin, destination, depDate: q.departureDate, ...(q.returnDate ? { backDate: q.returnDate } : {}),
        ...(q.directOnly ? { journeyType: 1 } : {}),
      });
      return { kind: 'flight' as const, items: distinct(raw.map(item => flightOffer(item, q)), q.limit) };
    } catch {
      signal.throwIfAborted();
      throw new SourceReadFailure('FlyAI flight search failed or returned an invalid source response');
    }
  }
  const q = hotelSearchInput.parse(input);
  const destName = q.place.trim();
  if (!destName || q.currency !== 'CNY') throw new InvalidInput('FlyAI hotel search requires a destination and CNY');
  const end = new Date(q.checkIn + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + q.nights);
  try {
    const raw = await request('search-hotel', { destName, checkInDate: q.checkIn, checkOutDate: end.toISOString().slice(0, 10) });
    return { kind: 'hotel' as const, items: distinct(raw.map(item => hotelOffer(item, q)), q.limit) };
  } catch {
    signal.throwIfAborted();
    throw new SourceReadFailure('FlyAI hotel search failed or returned an invalid source response');
  }
}
