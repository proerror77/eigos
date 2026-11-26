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
export interface Principal { owner: string; scopes: readonly string[]; clientId?: string; issuedAt?: number; memberAudience?: true; memberAccess?: true }
export type ExecutionActor = {
  kind: 'client' | 'agent' | 'workflow' | 'scheduled' | 'indexer' | 'system';
  id: string;
};
export function requireScope(principal: Principal, scope: string): void {
  if (!principal.owner || !principal.scopes.includes(scope)) throw new PermissionDenied(`Permission required: ${scope}`);
}

export class InvalidInput extends Error {}
export class PermissionDenied extends Error {}
export class Conflict extends Error {}
export class NotFound extends Error {}
/** A local runtime dependency is temporarily saturated. The same request can be retried later. */
export class ServiceUnavailable extends Error {}
/** A component Function stopped at one of its published limits. */
export class ResourceExhausted extends Error {
  constructor(message: string, readonly limit: 'fuel' | 'memory' | 'deadline' | 'output', options?: ErrorOptions) { super(message, options); }
}
/**
 * A component Function failed: with its own failure and the code it chose, with a trap (code `trap`), or with an output
 * outside its contract (code `contract`).
 */
export class FunctionFailed extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) { super(message, options); }
}
export class SourceReadFailure extends Error {
  readonly unavailable: boolean;
  constructor(message: string, options?: ErrorOptions & { unavailable?: boolean }) {
    super(message, options);
    this.unavailable = options?.unavailable ?? false;
  }
}
