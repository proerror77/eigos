import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createBookingSandboxProvider } from '../../packages/capabilities/booking/sandbox.js';

const env = z.object({ NODE_ENV: z.literal('development'), EIGOS_BOOKING_SANDBOX_TOKEN_FILE: z.string(), EIGOS_BOOKING_SANDBOX_PA_TOKEN_FILE: z.string(), EIGOS_BOOKING_SANDBOX_DATABASE: z.string(), EIGOS_BOOKING_SANDBOX_PORT: z.coerce.number().int().min(1024).max(65535).default(3433) }).parse(process.env);
if (![env.EIGOS_BOOKING_SANDBOX_TOKEN_FILE, env.EIGOS_BOOKING_SANDBOX_PA_TOKEN_FILE, env.EIGOS_BOOKING_SANDBOX_DATABASE].every(isAbsolute)) throw new Error('Booking simulator requires absolute private paths');
const provider = await createBookingSandboxProvider({ sourceToken: readFileSync(env.EIGOS_BOOKING_SANDBOX_TOKEN_FILE, 'utf8').trim(), paToken: readFileSync(env.EIGOS_BOOKING_SANDBOX_PA_TOKEN_FILE, 'utf8').trim(), databasePath: env.EIGOS_BOOKING_SANDBOX_DATABASE, port: env.EIGOS_BOOKING_SANDBOX_PORT });
console.log(JSON.stringify({ status: 'ready', endpoint: provider.endpoint, providerId: provider.providerId, environment: 'sandbox', realPayment: false }));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (closing) return; closing = true; void provider.close().then(() => process.exit(0)); });
