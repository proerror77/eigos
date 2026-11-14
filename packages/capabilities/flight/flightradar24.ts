import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { flightNumberKey, searchFlight } from '../../ontology/flight.js';
import { flightPositionInput, flightPositionResult, flightPositionSource } from '../../ontology/flight-position.js';
import { time } from '../../ontology/service-contracts.js';
import type { FunctionHandler } from '../../runtime/functions.js';

const tool = 'get_live_flights_positions_full';
const serverVersion = '1.0.2';
const config = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime(),
  keyFile: z.string().min(1), keySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const sourceRow = z.object({
  fr24_id: z.string(), flight: z.string().nullish(), callsign: z.string().nullish(),
  orig_iata: z.string().nullish(), dest_iata: z.string().nullish(), timestamp: time,
  lat: z.number(), lon: z.number(), alt: z.number().nullish(), gspeed: z.number().nullish(),
  eta: z.string().nullish(), source: z.string().nullish(),
});
const asIata = (value: string | null | undefined) => value && /^[A-Z]{3}$/.test(value) ? value : null;

async function serverEntrypoint(path: string | undefined) {
  if (!path || !isAbsolute(path)) throw new Error('Configure the absolute Flightradar24 MCP entrypoint');
  const resolved = await realpath(path);
  const suffix = '/node_modules/@flightradar24/fr24api-mcp/build/index.js';
  if (resolved !== path || !resolved.endsWith(suffix)) throw new Error('Use the installed official MCP entrypoint');
  const directory = dirname(dirname(resolved));
  const info = await lstat(resolved);
  if (!info.isFile() || info.mode & 0o022) throw new Error('Untrusted MCP entrypoint permissions');
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@flightradar24/fr24api-mcp' || pkg.version !== serverVersion)
    throw new Error('The installed Flightradar24 MCP version does not match the release');
  return { resolved, directory };
}

export function flightradar24Functions(path?: string, entrypoint?: string): ReadonlyMap<string, FunctionHandler> {
  return new Map<string, FunctionHandler>([['readLiveFlightPosition', async (raw, ctx) => {
    const { access, model } = ctx.objects;
    const input = flightPositionInput.parse(raw);
    const wantedFlight = flightNumberKey(input.flightNumber);
    const credentials = async () => {
      ctx.signal.throwIfAborted();
      await ctx.assertCurrent?.();
      await access.refresh();
      access.source(model, flightPositionSource);
      try {
        if (!path) throw new Error('Missing connection');
        const binding = config.parse(JSON.parse(await readPrivateSourceFile(path)));
        if (!binding.active || binding.owner !== ctx.principal.owner || Date.parse(binding.expiresAt) <= Date.now())
          throw new Error('Invalid Flightradar24 owner binding');
        const key = (await readPrivateSourceFile(binding.keyFile)).trim();
        if (key.length < 16 || key.length > 4096 || /\s/.test(key) || createHash('sha256').update(key).digest('hex') !== binding.keySha256)
          throw new Error('Changed Flightradar24 key');
        return { key, identity: digest(binding) };
      } catch { throw new Conflict('此账号尚未配置有效的 Flightradar24 连接。'); }
    };
    const { key, identity } = await credentials();
    const client = new Client({ name: 'eigos-fr24', version: '1' });
    // The provider uses stderr for HTTP errors. Do not forward its request logs or secrets.
    client.onerror = () => {};
    let transport: StdioClientTransport | undefined;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(12000)]);
    try {
      const server = await serverEntrypoint(entrypoint);
      transport = new StdioClientTransport({ command: process.execPath, args: [server.resolved], cwd: server.directory,
        env: { FR24_API_KEY: key }, stderr: 'ignore', maxBufferSize: 512 * 1024 });
      await client.connect(transport, { signal, timeout: 5000 });
      if (client.getServerVersion()?.version !== serverVersion) throw new Error('Unexpected Flightradar24 server version');
      if ((await credentials()).identity !== identity) throw new Error('Flightradar24 authorization changed');
      const result = await client.callTool({ name: tool, arguments: { flights: wantedFlight, limit: 8 } }, { signal, timeout: 7000 });
      const [message] = result.content;
      if (result.isError || result.content.length !== 1 || message?.type !== 'text' || message.text.includes(key))
        throw new Error('Unexpected Flightradar24 response');
      const prefix = /^Found \d+ flights \(full details\):\r?\n/;
      if (!prefix.test(message.text)) throw new Error('Invalid Flightradar24 result structure');
      const rows = z.array(sourceRow).max(8).parse(JSON.parse(message.text.replace(prefix, '')));
      const now = Date.now(), positions = [];
      for (const row of rows) {
        const number = searchFlight.shape.flightNumber.safeParse(row.flight);
        const origin = asIata(row.orig_iata), destination = asIata(row.dest_iata);
        const timestamp = Date.parse(row.timestamp);
        if (!number.success || flightNumberKey(number.data) !== wantedFlight ||
            input.origin && origin !== input.origin || input.destination && destination !== input.destination ||
            timestamp < now - 5 * 60000 || timestamp > now + 60000) continue;
        positions.push({
          trackingId: row.fr24_id, flightNumber: number.data, origin, destination,
          callsign: row.callsign || null, observedAt: row.timestamp,
          latitude: row.lat, longitude: row.lon, coordinateSystem: 'wgs84',
          altitudeFeet: row.alt ?? null, groundSpeedKnots: row.gspeed ?? null,
          estimatedArrivalAt: time.safeParse(row.eta).data ?? null, signalSource: row.source || null,
        });
      }
      if ((await credentials()).identity !== identity) throw new Error('Flightradar24 authorization changed');
      return flightPositionResult.parse({ provider: flightPositionSource, fetchedAt: new Date(now).toISOString(), positions });
    } catch {
      ctx.signal.throwIfAborted();
      throw new Conflict('Flightradar24 未返回可验证的位置，请检查官方 MCP、来源授权和订阅。');
    } finally {
      await client.close().catch(() => {});
      await transport?.close().catch(() => {});
    }
  }]]);
}
