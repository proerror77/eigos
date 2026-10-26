import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const file = resolve('.env.relay'), directory = resolve('data/relay');
if (existsSync(file)) throw new Error('Existing .env.relay retained; edit that private configuration explicitly.');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const contents = [
  'EIGOS_RELAY_AUTH_MODE=development', 'EIGOS_RELAY_HOST=127.0.0.1', 'EIGOS_RELAY_PORT=8788',
  'EIGOS_RELAY_PUBLIC_URL=http://127.0.0.1:8788', `EIGOS_RELAY_DATABASE_PATH=${JSON.stringify(resolve(directory, 'relay.sqlite'))}`,
  `EIGOS_RELAY_DEV_TOKEN=${randomBytes(32).toString('base64url')}`, '',
].join('\n');
writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
console.log('Private loopback Relay configuration created at .env.relay. Run npm run dev:relay.');
