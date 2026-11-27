import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PermissionDenied } from '../core/identity.js';

const format = 'eigos-component-source-secrets-v1';
const envelope = z.strictObject({
  format: z.literal(format),
  nonce: z.base64(),
  tag: z.base64(),
  ciphertext: z.base64().max(2 * 1024 * 1024),
});
const values = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), z.string().min(1).max(64 * 1024));

function keyBytes(key: Uint8Array) {
  if (key.length !== 32) throw new Error('A 32-byte Source secrets key is required');
  return key;
}

/** Produces a versioned encrypted bundle for local Source credential provisioning. */
export function sealSourceSecrets(raw: unknown, key: Uint8Array) {
  const plaintext = Buffer.from(JSON.stringify(values.parse(raw)));
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyBytes(key), nonce);
    cipher.setAAD(Buffer.from(format));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return envelope.parse({ format, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64') });
  } finally { plaintext.fill(0); }
}

/** Decrypts only for one use. The files and key remain outside the Function host and Ontology definition. */
export class ComponentSourceSecrets {
  constructor(private readonly bundleFile: string, private readonly keyFile: string) {}

  async get(name: string) {
    const key = await readFile(this.keyFile).catch(() => { throw new PermissionDenied('Source credential is unavailable'); });
    let plaintext: Buffer | undefined;
    try {
      const { nonce, tag, ciphertext } = envelope.parse(JSON.parse(await readFile(this.bundleFile, 'utf8')));
      const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(nonce, 'base64'), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(format));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
      const secrets = values.parse(JSON.parse(plaintext.toString()));
      if (!Object.hasOwn(secrets, name)) throw new Error('Secret reference not present');
      return secrets[name]!;
    } catch {
      throw new PermissionDenied('Source credential is unavailable');
    } finally {
      key.fill(0);
      plaintext?.fill(0);
    }
  }
}
