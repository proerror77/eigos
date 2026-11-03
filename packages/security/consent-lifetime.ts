import { z } from 'zod';

/** Null is an explicit controller consent that lasts until revoked. */
export const consentExpirySchema = z.iso.datetime({ offset: true }).nullable();
export type ConsentExpiry = z.infer<typeof consentExpirySchema>;

export function consentDeadline(expiresAt: ConsentExpiry): number {
  if (expiresAt === null) return Infinity;
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) throw new Error('Invalid consent expiry');
  return deadline;
}

/** SQLite requires a finite index value. This exceeds every valid JS Date;
 * the JSON consent remains null and is never presented as a future date. */
export function consentExpiryIndex(expiresAt: ConsentExpiry): number {
  return expiresAt === null ? Number.MAX_SAFE_INTEGER : consentDeadline(expiresAt);
}

export function minimumConsentExpiry(...limits: ConsentExpiry[]): ConsentExpiry {
  const deadline = Math.min(...limits.map(consentDeadline));
  return deadline === Infinity ? null : new Date(deadline).toISOString();
}
