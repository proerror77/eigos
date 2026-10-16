import { z } from 'zod';

// Administrators select one exact signed claim key. Never fall back to another claim or request metadata.
export function readTenantClaim(payload: unknown, claimName = 'tenant_id'): string {
  const claims = z.record(z.string(), z.unknown()).parse(payload);
  if (!Object.hasOwn(claims, claimName)) throw new Error('Required signed tenant claim is missing');
  return z.string().min(1).max(256).parse(claims[claimName]);
}
