import { createHash } from 'node:crypto';

export function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, value]) => [key, normalize(value)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}

export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export interface Principal { owner: string; scopes: readonly string[] }
export function requireScope(principal: Principal, scope: string): void {
  if (!principal.owner || !principal.scopes.includes(scope)) throw new Error(`Permission required: ${scope}`);
}

export class Conflict extends Error {}
export class NotFound extends Error {}
