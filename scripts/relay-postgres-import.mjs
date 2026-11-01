import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import pg from 'pg';

const usage = 'Usage: node scripts/relay-postgres-import.mjs --apply --snapshot /absolute/offline-copy.sqlite --schema eigos_relay_NAME';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') { console.log(usage); process.exit(0); }
if (args.length !== 5 || args[0] !== '--apply' || args[1] !== '--snapshot' || args[3] !== '--schema' || !isAbsolute(args[2])) {
  console.error(usage); process.exit(2);
}
const source = process.env.EIGOS_RELAY_POSTGRES_URL, caPath = process.env.EIGOS_RELAY_POSTGRES_CA_FILE;
if (!source || !caPath || !isAbsolute(caPath)) { console.error('Set EIGOS_RELAY_POSTGRES_URL and an absolute EIGOS_RELAY_POSTGRES_CA_FILE.'); process.exit(2); }
let url;
try { url = new URL(source); } catch { console.error('Invalid PostgreSQL connection URL.'); process.exit(2); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) || url.search || url.hash) {
  console.error('Connection URL must contain host, database and credentials and must not include options.'); process.exit(2);
}
let client;
try {
  // Parse components explicitly: URL SSL parameters must not override CA or
  // hostname verification. Credentials never appear in command arguments.
  client = new pg.Client({ host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  await client.connect();
  const { importRelaySnapshot } = await import('../dist/packages/relay/postgres-import.js');
  const counts = await importRelaySnapshot(client, args[2], args[4]);
  console.log(JSON.stringify({ status: 'imported', schema: args[4], counts }));
} catch (error) {
  // Driver errors may contain connection details; print only a safe code.
  const safe = error && typeof error === 'object' && 'code' in error && /^[A-Z0-9_]{1,32}$/.test(String(error.code)) ? String(error.code) : 'IMPORT_FAILED';
  console.error(`Relay import failed (${safe}). Inspect the destination before retrying; commit status may be unknown.`); process.exitCode = 1;
} finally { if (client) await client.end(); }
