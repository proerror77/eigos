import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { commerceProviders, type CommerceProvider } from './contracts.js';

const absolute = z.string().min(1).refine(isAbsolute), sha = z.string().regex(/^[a-f0-9]{64}$/);
const common = { version: z.literal(1), credentialFile: absolute, credentialSha256: sha };
const runtime = { mcpScript: absolute, mcpScriptSha256: sha };
export const commerceConnectionSchema = z.discriminatedUnion('provider', [
  z.strictObject({ ...common, ...runtime, provider: z.literal('alipay'), environment: z.enum(['production', 'sandbox']) }),
  z.strictObject({ ...common, ...runtime, provider: z.literal('unionpay'), environment: z.literal('production') }),
  z.strictObject({ ...common, provider: z.literal('wechatpay'), environment: z.literal('production') }),
  z.strictObject({ ...common, provider: z.literal('taobao'), environment: z.literal('production') }),
]);
export type CommerceConnection = z.infer<typeof commerceConnectionSchema>;
export interface CommerceConnectionOptions { connectionFile: string }
export type CommerceConnectionOptionsMap = Partial<Record<CommerceProvider, CommerceConnectionOptions>>;
export function readCommerceFile(path: string, fingerprint?: string, executable = false): Buffer {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || !process.getuid) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > (executable ? 8 * 1024 * 1024 : 262144)
      || stat.mode & (executable ? 0o022 : 0o077)) throw new Error();
    const bytes = readFileSync(fd);
    if (bytes.length > (executable ? 8 * 1024 * 1024 : 262144) || fingerprint && createHash('sha256').update(bytes).digest('hex') !== fingerprint) throw new Error();
    return bytes;
  } catch { throw new Error('Payment/commerce private file is unavailable or its fingerprint changed'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readCommerceConnection(provider: CommerceProvider, path: string): CommerceConnection {
  try {
    const record = commerceConnectionSchema.parse(JSON.parse(readCommerceFile(path).toString('utf8')));
    if (record.provider !== provider) throw new Error();
    return record;
  } catch { throw new Error('Invalid payment/commerce connection metadata'); }
}
const keyText = z.string().min(16).max(32000);
export const alipayCredentialSchema = z.strictObject({ AP_APP_ID: z.string().regex(/^\d{10,32}$/), AP_APP_KEY: keyText, AP_PUB_KEY: keyText });
const base64 = z.string().min(1).max(64000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const unionPayCredentialSchema = z.strictObject({
  UP_MER_ID: z.string().regex(/^\d{8,32}$/), UP_SIGN_CERT_PWD: z.string().min(1).max(500),
  UP_TR_ID: z.string().regex(/^[A-Za-z0-9]{1,64}$/).optional(), UP_TOKEN_TYPE: z.literal('01').optional(),
  signingCertificateBase64: base64,
  validationCertificates: z.array(z.strictObject({ name: z.string().regex(/^[A-Za-z0-9_-]{1,80}\.cer$/), base64 })).min(1).max(8).refine(certs => new Set(certs.map(c => c.name)).size === certs.length),
});
export const wechatPayCredentialSchema = z.strictObject({
  merchantId: z.string().regex(/^\d{6,32}$/), merchantCertificateSerial: z.string().regex(/^[A-Fa-f0-9]{1,64}$/),
  privateKeyPem: keyText, platformPublicKeyId: z.string().regex(/^PUB_KEY_ID_[A-Za-z0-9]{1,100}$/), platformPublicKeyPem: keyText,
});
export const taobaoCredentialSchema = z.strictObject({ appKey: z.string().regex(/^[A-Za-z0-9]{1,64}$/), appSecret: z.string().min(16).max(256), adzoneId: z.string().regex(/^[1-9]\d{0,19}$/) });
export function readCommerceCredential(connection: CommerceConnection) {
  const value: unknown = JSON.parse(readCommerceFile(connection.credentialFile, connection.credentialSha256).toString('utf8'));
  if (connection.provider === 'alipay') return alipayCredentialSchema.parse(value);
  if (connection.provider === 'unionpay') return unionPayCredentialSchema.parse(value);
  if (connection.provider === 'taobao') return taobaoCredentialSchema.parse(value);
  const credential = wechatPayCredentialSchema.parse(value);
  for (const key of [createPrivateKey(credential.privateKeyPem), createPublicKey(credential.platformPublicKeyPem)])
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('WeChat Pay requires RSA keys of at least 2048 bits');
  return credential;
}
export function commerceConnectionsFromConfig(config: Partial<Record<`EIGOS_${Uppercase<CommerceProvider>}_CONNECTION_FILE`, string>>): CommerceConnectionOptionsMap {
  return Object.fromEntries(commerceProviders.flatMap(provider => {
    const file = config[`EIGOS_${provider.toUpperCase()}_CONNECTION_FILE` as keyof typeof config];
    return file ? [[provider, { connectionFile: file }]] : [];
  }));
}
/** Offline configuration is not a source connection or a business receipt. */
export function commerceReadiness(options: CommerceConnectionOptionsMap) {
  return commerceProviders.map(provider => {
    if (!options[provider]) return { provider, status: 'not_configured' as const, liveVerified: false, businessWrites: false };
    try {
      const connection = readCommerceConnection(provider, options[provider]!.connectionFile);
      readCommerceCredential(connection);
      if ('mcpScript' in connection) readCommerceFile(connection.mcpScript, connection.mcpScriptSha256, true);
      return { provider, status: 'configured_unverified' as const, liveVerified: false, businessWrites: false };
    } catch { return { provider, status: 'configuration_invalid' as const, liveVerified: false, businessWrites: false }; }
  });
}
