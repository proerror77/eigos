import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Conflict, PermissionDenied, SourceReadFailure, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { namedWeatherInput, qweatherResult } from '../../ontology/weather.js';
import type { FunctionHandler } from '../../runtime/functions.js';

export const weatherAreaName = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/(?:特别行政区|市|省|区|县)$/u, '');
export class WeatherLocationUnconfirmed extends Conflict {}

const binding = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime(),
  host: z.string().max(253).regex(/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+qweatherapi\.com$/),
  keyFile: z.string().min(1), keySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const time = z.iso.datetime({ offset: true });
const label = z.string().trim().min(1).max(120);
const location = z.object({
  name: label, adm1: label.optional().catch(undefined), country: z.enum(['中国', 'China']),
  lat: z.string().regex(/^-?\d{1,3}(\.\d{1,8})?$/), lon: z.string().regex(/^-?\d{1,3}(\.\d{1,8})?$/), tz: label,
});
const temperature = z.object({ unit: z.literal('°C'), value: z.number() });
const condition = z.object({ text: label });
const metadata = z.object({ attributions: z.array(z.string().min(1).max(500)).max(19).optional() });
const current = z.object({
  metadata, validTime: time, condition, temperature, humidity: z.number().min(0).max(1).optional(),
});
const forecast = z.object({
  metadata, days: z.array(z.object({
    daytime: z.object({ forecastStartTime: time, condition }),
    nighttime: z.object({ condition }),
    temperatureMax: temperature, temperatureMin: temperature,
  })).min(1).max(4),
});

async function jsonBody(response: Response) {
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new PermissionDenied('QWeather rejected the API authorization.');
    if (response.status === 404) throw new WeatherLocationUnconfirmed('QWeather returned no matching place.');
    throw new SourceReadFailure('QWeather is unavailable.', { unavailable: true });
  }
  let bytes = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, stream) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) throw new SourceReadFailure('QWeather returned an oversized response.');
      stream.enqueue(chunk);
    },
  }));
  return new Response(limited).json();
}

export function qweatherFunction(path?: string, fetcher: typeof fetch = fetch): FunctionHandler {
  return async (raw, ctx) => {
    const input = namedWeatherInput.parse(raw);
    async function authorize() {
      await ctx.assertCurrent?.();
      await ctx.objects.access.refresh();
      ctx.objects.access.source(ctx.objects.model, 'QWeather');
      try {
        if (!path) throw new Error('Missing binding');
        const config = binding.parse(JSON.parse(await readPrivateSourceFile(path)));
        if (!config.active || config.owner !== ctx.principal.owner || Date.parse(config.expiresAt) <= Date.now())
          throw new Error('Inactive binding');
        const key = (await readPrivateSourceFile(config.keyFile)).trim();
        if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key) || createHash('sha256').update(key).digest('hex') !== config.keySha256)
          throw new Error('Invalid credential');
        return { config, key, fingerprint: digest(config) };
      } catch {
        throw new PermissionDenied('The owner has no active QWeather connection.');
      }
    }
    const selected = await authorize();
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(12000)]);
    async function get(route: string, search: Record<string, string>) {
      signal.throwIfAborted();
      if ((await authorize()).fingerprint !== selected.fingerprint) throw new PermissionDenied('QWeather authorization changed.');
      const url = new URL(route, 'https://' + selected.config.host);
      url.search = new URLSearchParams({ ...search, lang: 'zh' }).toString();
      const reply = await jsonBody(await fetcher(url, {
        method: 'GET', redirect: 'error', signal,
        headers: { 'X-QW-Api-Key': selected.key, Accept: 'application/json' },
      }));
      if (JSON.stringify(reply).includes(selected.key)) throw new SourceReadFailure('QWeather returned an invalid response.');
      return reply;
    }
    const geo = z.object({ code: z.string(), location: z.array(z.unknown()).max(20).optional() }).parse(
      await get('/geo/v2/city/lookup', { location: input.city, range: 'cn', number: '20', ...(input.province ? { adm: input.province } : {}) }));
    if (['401', '403'].includes(geo.code)) throw new PermissionDenied('QWeather rejected the source authorization.');
    if (geo.code !== '200' && geo.code !== '404') throw new SourceReadFailure('QWeather place lookup is unavailable.');
    const matching = (geo.location ?? []).flatMap(row => {
      const parsed = location.safeParse(row);
      if (!parsed.success) return [];
      const place = parsed.data;
      return weatherAreaName(place.name) === weatherAreaName(input.city) &&
        (!input.province || place.adm1 && weatherAreaName(place.adm1) === weatherAreaName(input.province)) ? [place] : [];
    });
    if (matching.length !== 1) throw new WeatherLocationUnconfirmed('QWeather could not identify a single matching place.');
    const [place] = matching;
    const lat = Number(place!.lat), lon = Number(place!.lon);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new WeatherLocationUnconfirmed('QWeather returned invalid place coordinates.');
    const kind = input.mode ?? 'forecast';
    const rawWeather = await get('/weather/v1/' + (kind === 'current' ? 'current' : 'daily') + '/' + lat + '/' + lon,
      kind === 'current' ? {} : { days: '4' });
    if ((await authorize()).fingerprint !== selected.fingerprint) throw new PermissionDenied('QWeather authorization changed.');
    const common = { provider: 'QWeather', city: place!.name, province: place!.adm1, fetchedAt: new Date().toISOString(), kind };
    const attribution = (meta: z.infer<typeof metadata>) => [...new Set(['https://www.qweather.com/', ...(meta.attributions ?? [])])];
    if (kind === 'current') {
      const weather = current.parse(rawWeather);
      const age = Date.now() - Date.parse(weather.validTime);
      if (age < -300000 || age > 7200000) throw new SourceReadFailure('QWeather current conditions are outside the supported freshness window.');
      return qweatherResult.parse({
        ...common, validAt: weather.validTime, condition: weather.condition.text,
        temperatureC: weather.temperature.value, humidityPct: weather.humidity === undefined ? undefined : weather.humidity * 100,
        attributions: attribution(weather.metadata),
      });
    }
    const weather = forecast.parse(rawWeather);
    const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: place!.tz, dateStyle: 'short' });
    const days = weather.days.map(day => ({
      date: formatter.format(new Date(day.daytime.forecastStartTime)), daytime: day.daytime.condition.text,
      nighttime: day.nighttime.condition.text, maxTemperatureC: day.temperatureMax.value, minTemperatureC: day.temperatureMin.value,
    }));
    if (days.some((day, i) => day.date < formatter.format(new Date()) || day.maxTemperatureC < day.minTemperatureC ||
        i > 0 && day.date <= days[i - 1]!.date))
      throw new SourceReadFailure('QWeather returned inconsistent forecast dates or temperatures.');
    return qweatherResult.parse({ ...common, days, attributions: attribution(weather.metadata) });
  };
}
