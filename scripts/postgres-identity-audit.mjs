import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';

const usage = 'Usage: node scripts/postgres-identity-audit.mjs --business-schema eigos_business_NAME --membership-schema eigos_membership_NAME --business-digest <digest> --membership-digest <digest>';
let values;
try { ({ values } = parseArgs({ options: { help: { type: 'boolean' }, 'business-schema': { type: 'string' }, 'membership-schema': { type: 'string' }, 'business-digest': { type: 'string' }, 'membership-digest': { type: 'string' } } })); }
catch { console.error(usage); process.exit(2); }
if (values.help) { console.log(usage); process.exit(0); }
if (!/^eigos_business_[a-z0-9_]{1,40}$/.test(values['business-schema'] ?? '') || !/^eigos_membership_[a-z0-9_]{1,40}$/.test(values['membership-schema'] ?? '') || !/^[a-f0-9]{64}$/.test(values['business-digest'] ?? '') || !/^[a-f0-9]{64}$/.test(values['membership-digest'] ?? '')) { console.error(usage); process.exit(2); }
const source = process.env.EIGOS_BUSINESS_POSTGRES_URL, caPath = process.env.EIGOS_BUSINESS_POSTGRES_CA_FILE;
if (!source || !caPath || !isAbsolute(caPath)) { console.error('Set EIGOS_BUSINESS_POSTGRES_URL and an absolute EIGOS_BUSINESS_POSTGRES_CA_FILE.'); process.exit(2); }
let url;
try { url = new URL(source); } catch { console.error('Invalid PostgreSQL connection URL.'); process.exit(2); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) || url.search || url.hash) { console.error('Connection URL must contain host, database and credentials and must not include options.'); process.exit(2); }
let client;
try {
  const { auditImportedIdentities } = await import('../dist/packages/postgres/identity-audit.js');
  client = new pg.Client({ host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  await client.connect();
  const result = await auditImportedIdentities(client, { businessSchema: values['business-schema'], membershipSchema: values['membership-schema'], businessFileDigest: values['business-digest'], membershipFileDigest: values['membership-digest'], now: Date.now() });
  console.log(JSON.stringify(result, null, 2)); if (result.mismatchedSubjects) process.exitCode = 1;
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error && /^[A-Z0-9_]{1,32}$/.test(String(error.code)) ? String(error.code) : 'IMPORT_FAILED';
  console.error(`Identity audit failed (${code}). No runtime was activated.`); process.exitCode = 1;
} finally { if (client) await client.end(); }
