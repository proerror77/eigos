import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import pg from 'pg';

const usage = 'Usage: node scripts/relay-postgres-grant.mjs --apply --source-stopped --schema eigos_relay_live_<id> --role <same-schema-name> --source-digest <reviewed-snapshot-sha256>';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') { console.log(usage); process.exit(0); }
if (args.length !== 8 || args[0] !== '--apply' || args[1] !== '--source-stopped' || args[2] !== '--schema' || args[4] !== '--role' || args[6] !== '--source-digest' || !/^eigos_relay_live_[a-f0-9]{12,32}$/.test(args[3] ?? '') || args[5] !== args[3] || !/^[a-f0-9]{64}$/.test(args[7] ?? '')) { console.error(usage); process.exit(2); }
const source = process.env.EIGOS_RELAY_POSTGRES_URL, caPath = process.env.EIGOS_RELAY_POSTGRES_CA_FILE;
if (!source || !caPath || !isAbsolute(caPath)) { console.error('Set EIGOS_RELAY_POSTGRES_URL and an absolute EIGOS_RELAY_POSTGRES_CA_FILE.'); process.exit(2); }
let url;
try { url = new URL(source); } catch { console.error('Invalid PostgreSQL connection URL.'); process.exit(2); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) || url.search || url.hash) { console.error('Connection URL must contain host, database and credentials without options.'); process.exit(2); }
let client;
try {
  client = new pg.Client({ host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  await client.connect();
  const {grantImportedRelayRuntime} = await import('../dist/packages/relay/postgres-grants.js');
  await grantImportedRelayRuntime(client,args[3],args[5],args[7]);
  console.log(JSON.stringify({status:'granted-not-activated',schema:args[3],sourceFileDigest:args[7]}));
} catch (error) {
  const safe = error && typeof error === 'object' && 'code' in error && /^[A-Z0-9_]{1,32}$/.test(String(error.code)) ? String(error.code) : 'GRANT_FAILED';
  console.error(`Relay grant failed (${safe}). Inspect the target and privileges before retrying; commit status may be unknown.`); process.exitCode = 1;
} finally { if (client) await client.end(); }
