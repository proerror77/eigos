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
const grantValue = z.strictObject({
  accessToken: z.string().min(1).max(32768).regex(/^[^\r\n]+$/),
  refreshToken: z.string().min(1).max(64 * 1024),
  validUntil: z.number().int().nonnegative(),
});
export type SourceOAuthGrant = z.infer<typeof grantValue>;
const grantAad = (identity: string) => Buffer.from('eigos-component-source-oauth-grant-v1:' + identity);


function keyBytes(key: Uint8Array) {
  if (key.length !== 32) throw new Error('A 32-byte Source secrets key is required');
  return key;
}

function seal(plaintext: Buffer, key: Uint8Array, aad: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, tag: cipher.getAuthTag(), ciphertext };
}

function open(box: { nonce: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array }, key: Uint8Array, aad: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), box.nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(box.tag);
  return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
}

/** Produces a versioned encrypted bundle for local Source credential provisioning. */
export function sealSourceSecrets(raw: unknown, key: Uint8Array) {
  const plaintext = Buffer.from(JSON.stringify(values.parse(raw)));
  try {
    const { nonce, tag, ciphertext } = seal(plaintext, key, Buffer.from(format));
    return envelope.parse({ format, nonce: nonce.toString('base64'), tag: tag.toString('base64'), ciphertext: ciphertext.toString('base64') });
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
      plaintext = open({ nonce: Buffer.from(nonce, 'base64'), tag: Buffer.from(tag, 'base64'),
        ciphertext: Buffer.from(ciphertext, 'base64') }, key, Buffer.from(format));
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

  async sealGrant(identity: string, grant: SourceOAuthGrant) {
    const plaintext = Buffer.from(JSON.stringify(grantValue.parse(grant)));
    try {
      return await this.withKey(key => {
        const { nonce, tag, ciphertext } = seal(plaintext, key, grantAad(identity));
        return Buffer.concat([nonce, tag, ciphertext]);
      });
    } finally { plaintext.fill(0); }
  }

  async openGrant(identity: string, stored: Buffer) {
    return this.withKey(key => {
      const plaintext = open({ nonce: stored.subarray(0, 12), tag: stored.subarray(12, 28), ciphertext: stored.subarray(28) },
        key, grantAad(identity));
      try { return grantValue.parse(JSON.parse(plaintext.toString())); }
      finally { plaintext.fill(0); }
    });
  }

  private async withKey<T>(operation: (key: Buffer) => T) {
    let key: Buffer | undefined;
    try {
      key = await readFile(this.keyFile);
      return operation(key);
    } catch {
      throw new PermissionDenied('Source OAuth credential is unavailable');
    } finally { key?.fill(0); }
  }
}
