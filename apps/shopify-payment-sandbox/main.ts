import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createShopifyPASandbox } from '../../packages/capabilities/shopify/pa-checkout-sandbox.js';

const env = z.object({ NODE_ENV: z.literal('development'), EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE: z.string(), EIGOS_SHOPIFY_PAYMENT_SANDBOX_PA_TOKEN_FILE: z.string(),
  EIGOS_SHOPIFY_PAYMENT_SANDBOX_DATABASE: z.string(), EIGOS_SHOPIFY_PAYMENT_SANDBOX_PORT: z.coerce.number().int().min(1024).max(65535).default(3437) }).parse(process.env);
const source = env.EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE, pa = env.EIGOS_SHOPIFY_PAYMENT_SANDBOX_PA_TOKEN_FILE;
if (![source, pa, env.EIGOS_SHOPIFY_PAYMENT_SANDBOX_DATABASE].every(isAbsolute)) throw new Error('Test merchant requires absolute private paths');
for (const file of [source, pa]) { const info = lstatSync(file); if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.()) throw new Error('Test credentials must be owner-only regular files'); }
const provider = await createShopifyPASandbox({ sourceToken: readFileSync(source, 'utf8').trim(), paToken: readFileSync(pa, 'utf8').trim(), databasePath: env.EIGOS_SHOPIFY_PAYMENT_SANDBOX_DATABASE, port: env.EIGOS_SHOPIFY_PAYMENT_SANDBOX_PORT });
console.log(JSON.stringify({ status: 'ready', endpoint: provider.endpoint, providerId: provider.providerId, environment: 'sandbox', evidenceLevel: 'synthetic', realPayment: false }));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (closing) return; closing = true; void provider.close().then(() => process.exit(0)); });
