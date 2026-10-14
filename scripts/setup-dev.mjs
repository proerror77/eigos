import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

try {
  writeFileSync('.env', [
    'EIGOS_AUTH_MODE=development',
    `EIGOS_DEV_TOKEN=${randomBytes(32).toString('hex')}`,
    'HOST=127.0.0.1',
    'PORT=3000',
    'PUBLIC_URL=http://127.0.0.1:3000',
    'DATABASE_PATH=./data/eigos.sqlite',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('Created private, ignored .env for loopback development. The token is not printed. Run npm run dev.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env already exists; preserved without changes.');
  else throw error;
}
