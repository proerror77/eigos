import { createServer } from 'node:http';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { createPAPaymentsApp } from './app.js';

const { values } = parseArgs({ options: { 'token-file': { type: 'string' } } });
const path = values['token-file'];
if (!path || !isAbsolute(path)) throw new Error('Use --token-file with an absolute PA-private token file');
const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
let token: string;
try {
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 65) {
    throw new Error('The PA tools token must be an owner-only regular file');
  }
  token = readFileSync(fd, 'utf8').trim();
} finally { closeSync(fd); }
const server = createServer(createPAPaymentsApp(token));
server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    mode: 'rehearsal_only', realOrdersAllowed: false, realPaymentsAllowed: false }));
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  server.closeAllConnections(); server.close(() => process.exit(0));
});
