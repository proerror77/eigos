// Synthetic CLI output only. These tests never execute a provider or read credentials.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePaotuiPublicPlaces, paotuiPublicPlaceSchema } from '../packages/capabilities/paotui-public-locations.js';

const publicPlace = () => ({
  name: 'Synthetic public landmark', address: 'Synthetic public square', city: '北京市',
  cityId: 'fixture-city', id: 'fixture-place', poiId: 123,
});

test('CLI integer microdegrees become typed degree coordinates with an explicit unit', () => {
  const result = normalizePaotuiPublicPlaces([{ ...publicPlace(), lat: 39904200, lng: 116407400 }]);
  assert.deepEqual(result, [{ ...publicPlace(), lat: 39.9042, lng: 116.4074, coordinateUnit: 'degree' }]);
  assert.equal(paotuiPublicPlaceSchema.safeParse(result[0]).success, true);
});

test('conversion preserves signed boundaries, zero and exact microdegree semantics', () => {
  const inputs = [
    { ...publicPlace(), lat: 90000000, lng: 180000000 },
    { ...publicPlace(), lat: -90000000, lng: -180000000 },
    { ...publicPlace(), lat: 0, lng: 0 },
    { ...publicPlace(), lat: 39, lng: -116 },
  ];
  const result = normalizePaotuiPublicPlaces(inputs);
  assert.deepEqual(result.map(place => [place.lat, place.lng, place.coordinateUnit]), [
    [90, 180, 'degree'], [-90, -180, 'degree'], [0, 0, 'degree'], [0.000039, -0.000116, 'degree'],
  ]);
  assert(result.every(place => paotuiPublicPlaceSchema.safeParse(place).success));
});

test('absent coordinates remain absent while either provided coordinate carries its unit', () => {
  const result = normalizePaotuiPublicPlaces([
    publicPlace(), { ...publicPlace(), lat: 39904200 }, { ...publicPlace(), lng: 116407400 },
  ]);
  assert.deepEqual(result[0], publicPlace());
  assert.deepEqual(result[1], { ...publicPlace(), lat: 39.9042, coordinateUnit: 'degree' });
  assert.deepEqual(result[2], { ...publicPlace(), lng: 116.4074, coordinateUnit: 'degree' });
});

test('normalization removes private and debug fields without changing public business fields', () => {
  const raw = {
    ...publicPlace(), lat: 39904200, lng: 116407400,
    token: 'PRIVATE_TOKEN_FIXTURE', phone: 'PRIVATE_PHONE_FIXTURE',
    providerDebug: { headers: 'PRIVATE_DEBUG_FIXTURE' }, nested: { coordinates: 'PRIVATE_CONTEXT_FIXTURE' },
    coordinateUnit: 'provider-untrusted-unit',
  };
  const result = normalizePaotuiPublicPlaces([raw]);
  assert.deepEqual(result, [{ ...publicPlace(), lat: 39.9042, lng: 116.4074, coordinateUnit: 'degree' }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(raw.lat, 39904200);
  assert.equal(raw.coordinateUnit, 'provider-untrusted-unit');
});

test('raw coordinates reject decimals, strings, null, nonfinite values and out-of-range integers', () => {
  const commonInvalid: unknown[] = [39.9042, 39904200.5, '39904200', null, NaN, Infinity, -Infinity, true, {}, []];
  for (const coordinate of ['lat', 'lng'] as const) {
    for (const value of commonInvalid) assert.throws(() => normalizePaotuiPublicPlaces([{ ...publicPlace(), [coordinate]: value }]), `${coordinate} must reject ${String(value)}`);
    const limit = coordinate === 'lat' ? 90000000 : 180000000;
    for (const value of [limit + 1, -limit - 1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => normalizePaotuiPublicPlaces([{ ...publicPlace(), [coordinate]: value }]), `${coordinate} must reject ${value}`);
    }
  }
});

test('nested or malformed whitelisted fields cannot pass normalization', () => {
  for (const field of ['name', 'address', 'city', 'cityId', 'id', 'poiId']) {
    assert.throws(() => normalizePaotuiPublicPlaces([{ ...publicPlace(), [field]: { debug: 'PRIVATE_NESTED_FIXTURE' } }]), field);
  }
  for (const value of [{}, { ...publicPlace(), name: '' }, null, ['not-a-place']]) {
    assert.throws(() => normalizePaotuiPublicPlaces([value]));
  }
});

test('normalization bounds the whole response and preserves empty searches', () => {
  assert.deepEqual(normalizePaotuiPublicPlaces([]), []);
  const hundred = Array.from({ length: 100 }, (_, index) => ({ ...publicPlace(), id: `fixture-${index}` }));
  assert.equal(normalizePaotuiPublicPlaces(hundred).length, 100);
  assert.throws(() => normalizePaotuiPublicPlaces([...hundred, publicPlace()]));
  for (const invalid of [undefined, null, {}, 'not-an-array']) assert.throws(() => normalizePaotuiPublicPlaces(invalid));
});

test('normalized result schema requires numeric degrees and the correct coordinate label', () => {
  assert.equal(paotuiPublicPlaceSchema.safeParse(publicPlace()).success, true);
  assert.equal(paotuiPublicPlaceSchema.safeParse({ ...publicPlace(), lat: 39.9042, coordinateUnit: 'degree' }).success, true);
  assert.equal(paotuiPublicPlaceSchema.safeParse({ ...publicPlace(), lng: 116.4074, coordinateUnit: 'degree' }).success, true);
  const invalid = [
    { ...publicPlace(), lat: 39.9042 },
    { ...publicPlace(), lng: 116.4074 },
    { ...publicPlace(), lat: 39.9042, coordinateUnit: 'microdegree' },
    { ...publicPlace(), lat: 39.9042, coordinateUnit: 'radian' },
    { ...publicPlace(), lat: '39.9042', coordinateUnit: 'degree' },
    { ...publicPlace(), lat: 90.000001, coordinateUnit: 'degree' },
    { ...publicPlace(), lat: -90.000001, coordinateUnit: 'degree' },
    { ...publicPlace(), lng: 180.000001, coordinateUnit: 'degree' },
    { ...publicPlace(), lng: -180.000001, coordinateUnit: 'degree' },
    { ...publicPlace(), lat: 39904200, lng: 116407400, coordinateUnit: 'degree' },
    { ...publicPlace(), lat: { value: 39.9042 }, coordinateUnit: 'degree' },
    { ...publicPlace(), lat: null, coordinateUnit: 'degree' },
    { ...publicPlace(), lat: Infinity, coordinateUnit: 'degree' },
    { ...publicPlace(), phone: 'PRIVATE_PHONE_FIXTURE' },
    { ...publicPlace(), providerDebug: { token: 'PRIVATE_DEBUG_FIXTURE' } },
  ];
  for (const value of invalid) assert.equal(paotuiPublicPlaceSchema.safeParse(value).success, false);
});
