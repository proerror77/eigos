import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), directory = resolve(process.argv[2] ?? join(root, 'data/shopify-payment-sandbox'));
const marker = join(directory, 'owner.json');
if (existsSync(directory) && !existsSync(marker) && readdirSync(directory).length) throw new Error('Refusing to overwrite an unowned test directory');
if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).sourceRoot !== root) throw new Error('Test directory belongs to another checkout');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const privateWrite = (file, value) => { writeFileSync(file, value, { mode: 0o600 }); chmodSync(file, 0o600); };
const credential = name => {
  const file = join(directory, name), value = existsSync(file) ? readFileSync(file, 'utf8').trim() : randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid existing isolated test credential');
  privateWrite(file, value + '\n'); return { file, value };
};
const source = credential('source-token'), pa = credential('pa-token'), gateway = credential('gateway-token');
if (new Set([source.value, pa.value, gateway.value]).size !== 3) throw new Error('Merchant, PA and Gateway credentials must be separate');
const endpoint = 'http://127.0.0.1:3437', base = 'http://127.0.0.1:3438';
const env = values => Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n';
privateWrite(join(directory, 'provider.env'), env({ NODE_ENV: 'development', EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE: source.file, EIGOS_SHOPIFY_PAYMENT_SANDBOX_PA_TOKEN_FILE: pa.file, EIGOS_SHOPIFY_PAYMENT_SANDBOX_DATABASE: join(directory, 'provider.sqlite'), EIGOS_SHOPIFY_PAYMENT_SANDBOX_PORT: 3437 }));
privateWrite(join(directory, 'gateway.env'), env({ NODE_ENV: 'development', HOST: '127.0.0.1', PORT: 3438, PUBLIC_URL: base, DATABASE_PATH: join(directory, 'tasks.sqlite'), EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: gateway.value, EIGOS_EXECUTOR: 'codex', EIGOS_ACTION_SANDBOX: 'true', EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL: endpoint, EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE: source.file }));
privateWrite(join(directory, 'test-vault.json'), JSON.stringify({ environment: 'sandbox', instrument: { type: 'test_card', number: '4242424242424242', expiry: '12/30', cvc: '123' } }, null, 2) + '\n');
// A2A configure verifies discovery before creating this file. It does not exist
// yet on initial setup, so this profile cannot execute until EIGOS is running.
const profile = join(directory, 'pa-payment.json');
if (!existsSync(profile)) privateWrite(profile, JSON.stringify({ version: 1, environment: 'sandbox', realPayments: false, endpoint, tokenFile: pa.file, vaultFile: join(directory, 'test-vault.json'), accountId: 'pa-test-account', allowedRoutes: ['pa_vault', 'pa_payment_account'], a2aConfig: join(directory, 'pa-a2a.json'), databasePath: join(directory, 'pa-payments.sqlite'), authorization: { kind: 'isolated_test_only', payeeId: 'shopify-sandbox', currency: 'USD', maximumMinor: '100', maximumPayments: 1, expiresAt: new Date(Date.now() + 86400000).toISOString() } }, null, 2) + '\n');
privateWrite(marker, JSON.stringify({ sourceRoot: root, protocol: 'eigos.shopify.pa-checkout.sandbox.v1' }) + '\n');
console.log(JSON.stringify({ status: 'prepared_not_started', directory, providerEnv: join(directory, 'provider.env'), gatewayEnv: join(directory, 'gateway.env'), paPaymentProfile: profile, agentCardUrl: base + '/.well-known/agent-card.json', a2aProfile: join(directory, 'pa-a2a.json'), gatewayTokenFile: gateway.file, environment: 'sandbox', realPayments: false }));
