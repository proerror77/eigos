import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createCommerceSandboxProvider } from '../../packages/capabilities/commerce-sandbox/provider.js';

const env = z.object({ NODE_ENV: z.string().optional(), EIGOS_COMMERCE_SANDBOX_TOKEN_FILE: z.string(), EIGOS_COMMERCE_SANDBOX_DATABASE: z.string(), EIGOS_COMMERCE_SANDBOX_PORT: z.coerce.number().int().min(1024).max(65535).default(3432) }).parse(process.env);
if (env.NODE_ENV === 'production' || !isAbsolute(env.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE) || !isAbsolute(env.EIGOS_COMMERCE_SANDBOX_DATABASE)) throw new Error('Commerce simulator requires non-production absolute private paths');
const provider = await createCommerceSandboxProvider({ port: env.EIGOS_COMMERCE_SANDBOX_PORT, token: readFileSync(env.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE, 'utf8').trim(), databasePath: env.EIGOS_COMMERCE_SANDBOX_DATABASE });
console.log(JSON.stringify({ status: 'ready', endpoint: provider.endpoint, instanceId: provider.instanceId, environment: 'sandbox', realOperationsAllowed: false }));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (closing) return; closing = true; void provider.close().then(() => process.exit(0)); });
