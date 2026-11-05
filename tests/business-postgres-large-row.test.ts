import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { JobStore } from '../packages/core/store.js';
import { installRuntimeAuthority, runtimeAuthorityDigest, type RuntimeAuthority } from '../packages/core/runtime-authority.js';
import { planBusinessSnapshot } from '../packages/postgres/business-snapshot.js';
import { importBusinessSnapshot } from '../packages/postgres/business-import.js';
import { verifyBusinessSnapshot } from '../packages/postgres/business-verify.js';

const enabled = process.env.EIGOS_TEST_RELAY_POSTGRES === '1' && process.env.EIGOS_TEST_LARGE_ROW === '1';
test('business migration preserves a synthetic 128 MiB task body without retransmitting it for verification', { skip: !enabled }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-large-row-')), path = join(dir, 'business.sqlite');
  const store = new JobStore(path, { securityMode: 'foundation' }); store.close();
  const db = new DatabaseSync(path);
  const authority: RuntimeAuthority = { version: 1, id: randomUUID(), revision: 1, canonicalOrigin: 'https://eigos.example', issuer: 'https://issuer.example', ontologyId: 'eigos.business', databasePath: path, membershipDatabasePath: join(dir,'members.sqlite'),
    ingresses: [{ origin: 'https://eigos.example', audience: 'https://eigos.example', tenantClaim: 'tenant_id', agentClientId: 'agent', agentClientIds: ['agent'], nativeClientIds: [], browserRedirect: false, newRegistrations: true }] };
  installRuntimeAuthority(db, authority);
  const body = JSON.stringify({ service: 'eigos.delegate', payload: 'x'.repeat(128 * 1024 * 1024), delegation: { backendVersion: 'fixture', nextAt: 1, request: { revision: 1 } } });
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('large-task','owner','context','submitted','2026','2026',body);
  const policy = String(db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()!.digest);
  db.exec('PRAGMA journal_mode=DELETE'); db.close();
  const authorityDigest = runtimeAuthorityDigest(authority), plan = planBusinessSnapshot(path, authorityDigest, policy);
  assert(plan.tables.find(table => table.name === 'jobs')!.maxRowBytes > 128 * 1024 * 1024);
  const schema = `eigos_business_large_${randomBytes(6).toString('hex')}`;
  const ca = process.env.EIGOS_TEST_PG_CA_FILE, local = process.env.EIGOS_TEST_PG_LOCAL === '1';
  if (local && process.env.PGHOST !== '127.0.0.1') throw new Error('Local test mode requires 127.0.0.1');
  if (!local && !ca) throw new Error('EIGOS_TEST_PG_CA_FILE is required');
  const client = new pg.Client({ ssl: local ? false : { ca: readFileSync(ca!, 'utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  let connected = false, imported = false;
  try {
    await client.connect(); connected = true;
    let chunks = 0;
    const observed = new Proxy(client, { get(target, property) {
      if (property === 'query') return async (sql: unknown, parameters?: unknown[]) => {
        if (typeof sql === 'string' && sql.startsWith('INSERT INTO pg_temp.eigos_import_chunks')) {
          assert(Buffer.isBuffer(parameters?.[2]) && parameters[2].length <= 1024 * 1024);
          chunks++;
        }
        return (target.query as (...args: any[]) => Promise<any>).call(target, sql, parameters);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const receipt = await importBusinessSnapshot(observed, { snapshot:path, schema, expectedFileDigest:plan.fileDigest, expectedAuthorityDigest:authorityDigest, expectedPolicyDigest:policy, maxDatabaseBytes:1_000_000_000 }); imported = true;
    assert(chunks > 128);
    assert.equal(receipt.status, 'imported-not-activated');
    const verified=await verifyBusinessSnapshot(client,{snapshot:path,schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:authorityDigest,expectedPolicyDigest:policy});
    assert.equal(verified.status,'verified-at-snapshot');assert.deepEqual(verified.tables,receipt.tables);
    const result = await client.query(`SELECT octet_length(body)::bigint AS bytes FROM "${schema}".jobs WHERE id='large-task'`);
    assert.equal(result.rows[0].bytes, String(Buffer.byteLength(body)));
  } finally {
    if (connected && imported) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end(); rmSync(dir, { recursive: true, force: true });
  }
});
