import type { z } from 'zod';
import { type partnerRideRoute, type uberFareRange } from '../../ontology/partner-rides.js';

export type RideRoute = z.infer<typeof partnerRideRoute>;

export function uberRideLink(route: RideRoute, productId: string) {
  const url = new URL('https://m.uber.com/looking');
  const location = (point: RideRoute['pickup']) => JSON.stringify({
    latitude: point.latitude, longitude: point.longitude, addressLine1: point.address,
  });
  url.searchParams.set('pickup', location(route.pickup));
  url.searchParams.set('drop[0]', location(route.dropoff));
  url.searchParams.set('product_id', productId);
  return url.href;
}

function uniqueParameters(url: URL, allowed: readonly string[]) {
  if (url.username || url.password || url.port || url.hash ||
      [...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1))
    throw new Error('Invalid Grab handoff');
}

export function grabRideLink(value: string, route: RideRoute, serviceId: number) {
  const link = new URL(value);
  uniqueParameters(link, ['af_dp', 'c', 'pid']);
  const nested = link.searchParams.get('af_dp');
  if (link.origin !== 'https://grab.onelink.me' || link.pathname !== '/2695613898' || !nested)
    throw new Error('Invalid Grab handoff');
  const direct = new URL(nested);
  const points = {
    pickUpLatitude: route.pickup.latitude, pickUpLongitude: route.pickup.longitude,
    dropOffLatitude: route.dropoff.latitude, dropOffLongitude: route.dropoff.longitude,
  };
  uniqueParameters(direct, [...Object.keys(points), 'screenType', 'taxiTypeId', 'sourceID', 'pickUpAddress', 'dropOffAddress']);
  if (direct.protocol !== 'grab:' || direct.hostname !== 'open' || direct.pathname ||
      direct.searchParams.get('screenType') !== 'BOOKING' || direct.searchParams.get('taxiTypeId') !== String(serviceId))
    throw new Error('Invalid Grab handoff');
  for (const [key, coordinate] of Object.entries(points)) {
    const parameter = direct.searchParams.get(key);
    if (!parameter || !/^-?\d+(?:\.\d+)?$/.test(parameter) || Number(parameter) !== coordinate)
      throw new Error('Grab handoff route differs');
  }
  for (const [parameter, address] of [['pickUpAddress', route.pickup.address], ['dropOffAddress', route.dropoff.address]] as const) {
    const supplied = direct.searchParams.get(parameter);
    if (supplied !== null && supplied !== address) throw new Error('Grab handoff address differs');
  }
  return link.href;
}

export function validUberFare(fare: { point?: string; range?: z.infer<typeof uberFareRange>; expiresAt?: string }, now = Date.now()) {
  const toScaled = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole! + fraction.padEnd(8, '0'));
  };
  return Boolean(fare.point || fare.range) &&
    (!fare.range || toScaled(fare.range.lower) <= toScaled(fare.range.upper)) &&
    (!fare.expiresAt || Date.parse(fare.expiresAt) > now);
}
