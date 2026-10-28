import { z } from 'zod';
import { digest } from './delegation.js';
import { currentInputs } from './current-inputs.js';
import type { ServiceRequest } from '../ontology/execution.js';

const text = z.string().trim().min(1).max(1500);
export const taskLocationSchema = z.strictObject({
  name: text, address: text.optional(), label: z.string().trim().min(1).max(100).optional(),
  source: z.enum(['saved_address', 'current_location', 'user_provided']), observedAt: z.iso.datetime().optional(),
}).refine(value => value.source !== 'current_location' || !!value.observedAt, 'A current location needs its actual observation time');
export const locationContextSchema = z.strictObject({
  city: z.string().trim().min(1).max(100), origin: taskLocationSchema.nullable().optional(), destination: taskLocationSchema.nullable().optional(),
});
export type LocationContext = z.infer<typeof locationContextSchema>;
export type TaskLocation = z.infer<typeof taskLocationSchema>;
const prefix = 'PA 已取得的任务地址上下文（仅为地址事实，不授予业务操作权限）：';
const idPrefix = (id: string) => `location-context:${id}:`;
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
// Equivalent terminal notation must retain the whole airport name and number.
// Entrances, parking areas and other suffixes remain distinct source places.
const normalizePlaceName = (value: string) => normalize(value).replace(/^(.*机场)(?:t([1-9]\d*)|([1-9]\d*)号)航站楼$/, (_, airport: string, terminal?: string, number?: string) => `${airport}t${terminal ?? number}航站楼`);
export const sameCity = (a: string, b: string) => normalize(a).replace(/市$/, '') === normalize(b).replace(/市$/, '');

/** Keep the original goal untouched. The authenticated PA context is an actual
 * instruction and becomes versioned RequestFact nodes through the normal projection. */
export function addLocationContext(request: ServiceRequest, input: LocationContext, messageId: string, receivedAt: string): void {
  const context = locationContextSchema.parse(input), id = idPrefix(request.id) + digest(messageId).slice(0, 20);
  request.messages.push({ id, text: prefix + JSON.stringify(context), receivedAt });
  prepareLocationContext(request);
}
export function prepareLocationContext(request: ServiceRequest): ServiceRequest {
  const family = currentInputs(request, (text, message) => {
    if (!message.id.startsWith(idPrefix(request.id)) || !text.startsWith(prefix)) return [];
    const context = locationContextSchema.parse(JSON.parse(text.slice(prefix.length)));
    return Object.entries(context).map(([field, value]) => value === null
      ? { field, status: 'cleared' as const, quote: 'null' }
      : { field, status: 'confirmed' as const, value, quote: JSON.stringify(value) });
  });
  if (Object.keys(family.fields).length) request.confirmedInputs = { ...request.confirmedInputs, location: family };
  return request;
}
export function requestLocations(request: ServiceRequest): { city?: string; origin?: TaskLocation; destination?: TaskLocation } {
  const fields = request.confirmedInputs?.location?.fields;
  const location = (role: string) => {
    const field = fields?.[role], parsed = field?.status === 'confirmed' ? taskLocationSchema.safeParse(field.value) : undefined;
    return parsed?.success ? parsed.data : undefined;
  };
  return { city: fields?.city?.status === 'confirmed' && typeof fields.city.value === 'string' ? fields.city.value : undefined,
    origin: location('origin'), destination: location('destination') };
}
/** Owner assertions identify the intended place; provider observations still
 * prove the actual coordinates. A label alone can never prove a source match. */
export function locationMatchesSource(location: TaskLocation, city: string, place: { name: string; address: string; addressAll: string; city: string }): boolean {
  if (!sameCity(city, place.city)) return false;
  const cityPrefixes = [...new Set([city, place.city].flatMap(value => [normalize(value), normalize(value).replace(/市$/, '')]))];
  const matches = (value: string, candidates: string[], normalized = normalize) => candidates.filter(Boolean).flatMap(item => [normalized(item), ...cityPrefixes.map(prefix => prefix + normalized(item))]).includes(normalized(value));
  if (matches(location.name, [place.name, place.addressAll], normalizePlaceName) && (!location.address || matches(location.address, [place.address, place.addressAll]))) return true;
  if (!location.address) return false;
  // A saved address may omit administrative prefixes or repeat the compound
  // after the street. Keep the compound, street and every numbered unit exact.
  const compact = (value: string) => normalize(value).replace(/[·•・‧]/g, '');
  const compound = (value: string) => compact(value).replace(/(?:\d+(?:号|弄))+$/, '');
  const name = compound(location.name);
  if (!name || name !== compound(place.name)) return false;
  const units = (value: string) => [...new Set(compact(value).match(/\d+(?:号|弄)/g) ?? [])].sort();
  const suppliedUnits = units(location.name + location.address);
  if (!suppliedUnits.length || JSON.stringify(suppliedUnits) !== JSON.stringify(units(place.name + place.address))) return false;
  const street = (value: string) => {
    let address = compact(value);
    if (address.startsWith(name)) address = address.slice(name.length);
    if (address.endsWith(name)) address = address.slice(0, -name.length);
    const cityPrefix = cityPrefixes.find(prefix => prefix.endsWith('市') && address.startsWith(prefix));
    if (cityPrefix) address = address.slice(cityPrefix.length);
    return address.replace(/^[,，;；、]+|[,，;；、]+$/g, '');
  };
  const supplied = street(location.address), observed = street(place.address);
  if (!supplied || !observed) return false;
  if (supplied === observed) return true;
  const [shorter, longer] = supplied.length < observed.length ? [supplied, observed] : [observed, supplied];
  if (!longer.endsWith(shorter)) return false;
  const administrativePrefix = longer.slice(0, -shorter.length);
  return /^[\p{Script=Han}]{1,40}(?:区|县|镇|乡|街道)$/u.test(administrativePrefix) && !/[\d路弄号省市]/.test(administrativePrefix);
}
export function locationAliases(location: TaskLocation, city: string): string[] {
  const groups = [['家', '家里', '我家', '我的家', '家中', 'home', 'my home'], ['这里', '我这里', '当前位置', '我现在的位置', '我当前的位置', 'current location']];
  const labels = location.label ? groups.find(group => group.some(value => normalize(value) === normalize(location.label!))) ?? [location.label] : [];
  return [location.name, location.address, ...labels].filter((value): value is string => !!value)
    .flatMap(value => [normalize(value), normalize(city) + normalize(value), normalize(city).replace(/市$/, '') + normalize(value)]);
}
export function normalizedLocation(value: string): string { return normalize(value); }
