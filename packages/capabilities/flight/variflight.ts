import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { flightNumberKey, flightSource, flightStatusRead, searchFlight, type flightStatus } from '../../ontology/flight.js';
import type { FunctionContext } from '../../runtime/functions.js';

export const aviationEndpoint = 'https://ai.variflight.com/servers/aviation/mcp';
const toolName = 'searchFlightsByNumber';
const protocol = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping']);
const connection = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime(),
  keyFile: z.string().min(1), keySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const body = z.object({
  code: z.literal(200), data: z.array(z.record(z.string(), z.unknown())).max(32),
  timestamp: z.iso.datetime({ offset: true }),
});
const statusByCode = new Map<number, z.infer<typeof flightStatus>['status']>([
  [0, 'scheduled'], [1, 'airborne'], [2, 'arrived'], [3, 'cancelled'], [4, 'delayed'],
  [5, 'diverted'], [11, 'returned'], [31, 'diverted'], [32, 'diverted'], [33, 'cancelled'],
  [41, 'returned'], [42, 'returned'], [43, 'cancelled'], [73, 'cancelled'],
]);
const statusByLabel = new Map<string, z.infer<typeof flightStatus>['status']>([
  ['计划', 'scheduled'], ['延误', 'delayed'], ['取消', 'cancelled'], ['提前取消', 'cancelled'],
  ['起飞', 'airborne'], ['到达', 'arrived'], ['备降', 'diverted'], ['返航', 'returned'],
]);
const maxBytes = 512 * 1024;
const label = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null;

function parseResultText(text: string) {
  // The official remote tool returns a Python literal prefixed with "Flight details:".
  // Accept literal tokens only and use JSON.parse for nesting and object syntax.
  const prefix = 'Flight details:';
  const input = text.startsWith(prefix) ? text.slice(prefix.length).trim() : text.trim();
  if (!input || input.length > maxBytes) throw new Error('Invalid flight response size');
  if (!text.startsWith(prefix)) return JSON.parse(input) as unknown;
  const token = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|True|False|None|true|false|null|\s+/gsy;
  const literals: Record<string, string> = { True: 'true', False: 'false', None: 'null' };
  const parts: string[] = [];
  while (token.lastIndex < input.length) {
    const next = token.exec(input)?.[0];
    if (!next) throw new Error('Unexpected literal in VariFlight result');
    if (/^['"]/.test(next)) {
      const decoded = next.slice(1, -1).replace(/\\(?:x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|.)/gs, escape => {
        const char = escape[1]!;
        const escapes: Record<string, string> = { "'": "'", '"': '"', '\\': '\\', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (Object.hasOwn(escapes, char)) return escapes[char]!;
        if ('xuU'.includes(char) && escape.length > 2) return String.fromCodePoint(Number.parseInt(escape.slice(2), 16));
        throw new Error('Unsupported string escape in VariFlight result');
      });
      parts.push(JSON.stringify(decoded));
    } else {
      parts.push(literals[next] ?? next);
    }
  }
  return JSON.parse(parts.join('')) as unknown;
}

function localTime(value: unknown, offset: unknown): string | null {
  const raw = label(value);
  if (!raw) return null;
  if (z.iso.datetime({ offset: true }).safeParse(raw).success) return raw;
  const date = raw.replace(' ', 'T');
  const seconds = typeof offset === 'number' || typeof offset === 'string' && /^-?\d+$/.test(offset) ? Number(offset) : NaN;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(date) || !Number.isInteger(seconds) ||
      Math.abs(seconds) > 14 * 3600 || seconds % 60 !== 0) return null;
  const abs = Math.abs(seconds);
  const hours = String(Math.floor(abs / 3600)).padStart(2,'0'), minutes = String(abs % 3600 / 60).padStart(2,'0');
  return z.iso.datetime({ offset: true }).parse(date + (seconds < 0 ? '-' : '+') + hours + ':' + minutes);
}

function flightDetails(raw: unknown, lookup: z.infer<typeof searchFlight>) {
  const rows = body.parse(raw);
  const flights = [];
  const number = (value: unknown) => {
    const parsed = searchFlight.shape.flightNumber.safeParse(value);
    return parsed.success ? flightNumberKey(parsed.data) : null;
  };
  const requestedNumber = flightNumberKey(lookup.flightNumber);
  for (const row of rows.data) {
    const flightNumber = number(row.FlightNo), origin = label(row.FlightDepcode), destination = label(row.FlightArrcode);
    if (!flightNumber || !origin || !destination) throw new Error('Flight response lacks segment identity');
    const codeshare = number(row.ShareFlightNo);
    if ((flightNumber !== requestedNumber && codeshare !== requestedNumber) ||
        lookup.origin && origin !== lookup.origin || lookup.destination && destination !== lookup.destination) continue;
    const scheduledDeparture = localTime(row.FlightDeptimePlanDate, row.org_timezone);
    const departureDate = typeof row.FlightDeptimePlanDate === 'string' ? row.FlightDeptimePlanDate.slice(0, 10) : '';
    if (departureDate !== lookup.departureDate) continue;
    const code = typeof row.FlightStateNum === 'number' || typeof row.FlightStateNum === 'string' && /^\d+$/.test(row.FlightStateNum)
      ? Number(row.FlightStateNum) : NaN;
    const providerStatus = label(row.FlightState);
    flights.push({
      flightNumber, departureDate, origin, destination, carrier: label(row.FlightCompany),
      codeshareFlightNumber: codeshare,
      status: statusByCode.get(code) ?? statusByLabel.get(providerStatus ?? '') ?? 'unknown',
      providerStatus, originName: label(row.FlightDepAirport), destinationName: label(row.FlightArrAirport),
      departureTerminal: label(row.FlightHTerminal), arrivalTerminal: label(row.FlightTerminal), gate: label(row.BoardGate),
      scheduledDeparture, scheduledArrival: localTime(row.FlightArrtimePlanDate, row.dst_timezone),
      estimatedDeparture: localTime(row.FlightDeptimeReadyDate || row.VeryZhunReadyDeptimeDate, row.org_timezone),
      estimatedArrival: localTime(row.FlightArrtimeReadyDate || row.VeryZhunReadyArrtimeDate, row.dst_timezone),
      actualDeparture: localTime(row.FlightDeptimeDate, row.org_timezone),
      actualArrival: localTime(row.FlightArrtimeDate, row.dst_timezone),
    });
  }
  return flightStatusRead.parse({ provider: flightSource, observedAt: rows.timestamp, flights });
}

function limitResponse(response: Response) {
  if (!response.body) return response;
  let bytes = 0;
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error('VariFlight response exceeds the supported size');
      controller.enqueue(chunk);
    },
  }));
  return new Response(stream, { status: response.status, headers: response.headers });
}

export function configuredVariFlight(path?: string, fetcher: typeof fetch = fetch) {
  return async (ctx: FunctionContext) => {
    const { access, model } = ctx.objects;
    const configured = async () => {
      ctx.signal.throwIfAborted();
      await ctx.assertCurrent?.();
      await access.refresh();
      access.source(model, flightSource);
      try {
        if (!path) throw new Error('Missing source');
        const config = connection.parse(JSON.parse(await readPrivateSourceFile(path)));
        if (!config.active || config.owner !== ctx.principal.owner || Date.parse(config.expiresAt) <= Date.now())
          throw new Error('Inactive source');
        const key = (await readPrivateSourceFile(config.keyFile)).trim();
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(key) || createHash('sha256').update(key).digest('hex') !== config.keySha256)
          throw new Error('Changed credential');
        return { key, authorityId: digest(config) };
      } catch {
        throw new Conflict('此账号尚未配置有效的飞常准 Aviation MCP 连接。');
      }
    };
    const { key, authorityId } = await configured();
    return {
      authorityId,
      async read(lookup: z.infer<typeof searchFlight>) {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(32000)]);
        const client = new Client({ name: 'eigos-variflight', version: '1' });
        const guard = async () => {
          signal.throwIfAborted();
          if ((await configured()).authorityId !== authorityId) throw new Conflict('飞常准来源授权已变化。');
        };
        let requested = false;
        const transport = new StreamableHTTPClientTransport(new URL(aviationEndpoint), {
          requestInit: { headers: { 'X-API-Key': key } },
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
          fetch: async (target, init) => {
            signal.throwIfAborted();
            if (String(target) !== aviationEndpoint || !['POST', 'GET', 'DELETE'].includes(init?.method ?? 'GET'))
              throw new Error('Unexpected VariFlight endpoint or HTTP method');
            if (init?.method === 'POST') {
              const packet = JSON.parse(String(init.body));
              if (packet.method === 'tools/call') {
                if (requested || packet.params?.name !== toolName) throw new Error('Unexpected VariFlight operation');
                requested = true;
                await guard();
              } else if (!protocol.has(packet.method)) throw new Error('Unexpected VariFlight MCP request');
            }
            return limitResponse(await fetcher(target, { ...init, signal, redirect: 'error' }));
          },
        });
        try {
          await client.connect(transport, { signal, timeout: 6000 });
          const result = await client.callTool({ name: toolName, arguments: {
            fnum: lookup.flightNumber, date: lookup.departureDate,
            ...(lookup.origin ? { dep: lookup.origin } : {}), ...(lookup.destination ? { arr: lookup.destination } : {}),
          } }, { signal, timeout: 26000 });
          if (result.isError || JSON.stringify(result).includes(key)) throw new Error('Rejected flight query');
          const [message] = result.content;
          if (!result.structuredContent && (result.content.length !== 1 || message?.type !== 'text'))
            throw new Error('Ambiguous VariFlight response');
          const data = result.structuredContent ?? parseResultText((message as { text: string }).text);
          await guard();
          return flightDetails(data, lookup);
        } catch {
          ctx.signal.throwIfAborted();
          throw new Conflict('飞常准未返回可验证的航班数据，请检查来源授权、额度和查询条件。');
        } finally {
          await client.close().catch(() => {});
          await transport.close().catch(() => {});
        }
      },
    };
  };
}
export type FlightSourceResolver = ReturnType<typeof configuredVariFlight>;
