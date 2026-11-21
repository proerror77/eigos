import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';

const salt = 'eigos-sealed-cookie', ivLength = 12, tagLength = 16, maxLength = 4096;
const envelope = z.object({ v: z.unknown(), exp: z.number() });
// One key per purpose. The purpose is also bound as additional authenticated data.
const derive = (secret: string, purpose: string) => Buffer.from(hkdfSync('sha256', secret, salt, purpose, 32));

/**
 * Encrypts and authenticates `value` for one `purpose`. It expires `ttlMs` after `now`.
 * The result is cookie-safe base64url: IV, ciphertext, then the GCM tag.
 */
export function seal(secret: string, purpose: string, value: unknown, ttlMs: number, now = Date.now()): string {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv('aes-256-gcm', derive(secret, purpose), iv, { authTagLength: tagLength });
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify({ v: value, exp: now + ttlMs }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/**
 * Returns the sealed value, or undefined for anything that is not an intact, unexpired cookie of this purpose
 * whose value matches `schema`. Never throws.
 */
export function unseal<T>(secret: string, purpose: string, sealed: string, schema: z.ZodType<T>, now = Date.now()): T | undefined {
  try {
    if (sealed.length > maxLength) return undefined;
    // Node's decoder skips junk and spare bits, so insist that the input is the canonical spelling of its bytes.
    const bytes = Buffer.from(sealed, 'base64url');
    if (bytes.length < ivLength + tagLength || bytes.toString('base64url') !== sealed) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', derive(secret, purpose), bytes.subarray(0, ivLength), { authTagLength: tagLength });
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(bytes.subarray(-tagLength));
    const plain = Buffer.concat([decipher.update(bytes.subarray(ivLength, -tagLength)), decipher.final()]);
    const opened = envelope.safeParse(JSON.parse(plain.toString('utf8')));
    if (!opened.success || opened.data.exp <= now) return undefined;
    const value = schema.safeParse(opened.data.v);
    return value.success ? value.data : undefined;
  } catch { return undefined; }
}
