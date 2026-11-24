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
/** An owner-bound supplier connection is missing, expired, or unauthorized. */
export class ProviderAuthorizationRequired extends Conflict {
  constructor(readonly provider: string, message: string) { super(message); }
}
export class NotFound extends Error {}
/** A local runtime dependency is temporarily saturated. The same request can be retried later. */
export class ServiceUnavailable extends Error {}
export class SourceReadFailure extends Error {
  readonly unavailable: boolean;
  constructor(message: string, options?: ErrorOptions & { unavailable?: boolean }) {
    super(message, options);
    this.unavailable = options?.unavailable ?? false;
  }
}

/** Preserve the source-unavailable contract while identifying an authorization requirement. */
export class ProviderReadAuthorizationRequired extends SourceReadFailure {
  constructor(readonly provider: string, message: string) { super(message, { unavailable: true }); }
}
