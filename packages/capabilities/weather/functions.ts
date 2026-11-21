import { PermissionDenied } from '../../core/identity.js';
import { weatherResult } from '../../ontology/maps.js';
import { namedWeatherInput, qweatherResult } from '../../ontology/weather.js';
import { Clarification } from '../../runtime/clarification.js';
import type { Database } from '../../runtime/database.js';
import type { FunctionHandler, Functions } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { WeatherLocationUnconfirmed, qweatherFunction, weatherAreaName } from './qweather.js';

export function configuredWeather(db: Database, functions: () => Functions, path?: string, fetcher?: typeof fetch) {
  const compare: FunctionHandler = async (raw, ctx) => {
    const input = namedWeatherInput.parse(raw);
    const mode = input.mode ?? 'forecast';
    const { access, model } = ctx.objects;
    const read = async (provider: 'Amap' | 'QWeather') => {
      const partition = await access.fork();
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(23000)]);
      try {
        const objects = new Objects(db, model, partition);
        const value = provider === 'Amap'
          ? weatherResult.parse(await functions().invoke(model, 'readWeather', { city: input.city, mode }, { ...ctx, objects, signal }))
          : qweatherResult.parse(await functions().invoke(model, 'readQWeather', input, { ...ctx, objects, signal }));
        const names = [value.city, 'district' in value ? value.district : undefined];
        if (!names.some(name => name && weatherAreaName(name) === weatherAreaName(input.city)) ||
            input.province && (!value.province || weatherAreaName(value.province) !== weatherAreaName(input.province)))
          throw new WeatherLocationUnconfirmed('The supplier did not confirm the requested area.');
        return { provider, status: 'available', weather: value, partition } as const;
      } catch (error) {
        ctx.signal.throwIfAborted();
        const status = error instanceof PermissionDenied ? 'authorization_required'
          : error instanceof WeatherLocationUnconfirmed || error instanceof Clarification
            ? 'location_unconfirmed' : 'unavailable';
        return { provider, status } as const;
      }
    };
    const peers = await Promise.all([read('Amap'), read('QWeather')]);
    const sources = [];
    for (const result of peers) {
      if (result.status !== 'available') { sources.push(result); continue; }
      const { partition, ...outcome } = result;
      try {
        await partition.refresh();
        access.adoptReads(partition);
        sources.push(outcome);
      } catch (error) {
        if (!(error instanceof PermissionDenied)) throw error;
        sources.push({ provider: outcome.provider, status: 'authorization_required' });
      }
    }
    const areas = sources.flatMap(source => source.status === 'available' && 'weather' in source && source.weather?.province
      ? [weatherAreaName(source.weather.province)] : []);
    const locationAgreement = areas.length !== 2 ? 'unconfirmed' : areas[0] === areas[1] ? 'same' : 'different';
    return { ...input, mode, sources, locationAgreement };
  };
  return new Map<string, FunctionHandler>([['readComparedWeather', compare], ['readQWeather', qweatherFunction(path, fetcher)]]);
}
