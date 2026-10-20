import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// Prepare test files only. This does not start services, edit the main .env,
// connect a wallet, request payment approval, or deploy a runtime.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.argv[2] ?? join(root, 'data/booking-sandbox'));
const marker = join(directory, 'owner.json');
if (existsSync(directory) && !existsSync(marker) && readdirSync(directory).length) throw new Error('Refusing to overwrite an unowned sandbox directory');
if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).sourceRoot !== root) throw new Error('Booking test directory belongs to another checkout');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const write = (file, value) => { writeFileSync(file, value, { mode: 0o600 }); chmodSync(file, 0o600); };
const credential = name => {
  const file = join(directory, name), value = existsSync(file) ? readFileSync(file, 'utf8').trim() : randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Existing booking test credential is invalid');
  write(file, value + '\n'); return { file, value };
};
const source = credential('source-token'), pa = credential('pa-wallet-token');
if (source.value === pa.value) throw new Error('Provider source and PA wallet credentials must differ');
const endpoint = 'http://127.0.0.1:3433';
const env = pairs => Object.entries(pairs).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n';
write(join(directory, 'provider.env'), env({ NODE_ENV: 'development', EIGOS_BOOKING_SANDBOX_TOKEN_FILE: source.file, EIGOS_BOOKING_SANDBOX_PA_TOKEN_FILE: pa.file, EIGOS_BOOKING_SANDBOX_DATABASE: join(directory, 'provider.sqlite'), EIGOS_BOOKING_SANDBOX_PORT: 3433 }));
write(join(directory, 'gateway-fragment.env'), env({ EIGOS_ACTION_SANDBOX: 'true', EIGOS_BOOKING_SANDBOX_URL: endpoint, EIGOS_BOOKING_SANDBOX_TOKEN_FILE: source.file }));
write(join(directory, 'pa-wallet.json'), JSON.stringify({ endpoint, tokenFile: pa.file, environment: 'sandbox', handler: 'sandbox.pa-wallet', realPayments: false }, null, 2) + '\n');
write(marker, JSON.stringify({ sourceRoot: root }) + '\n');
console.log(JSON.stringify({ status: 'prepared_not_started', directory, providerEnv: join(directory, 'provider.env'), gatewayFragment: join(directory, 'gateway-fragment.env'), paWalletConfig: join(directory, 'pa-wallet.json'), environment: 'sandbox', realPayments: false }));
