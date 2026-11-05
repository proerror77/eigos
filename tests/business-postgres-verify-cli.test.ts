import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('business verification CLI rejects invalid connection settings without exposing credentials',()=>{
  const script=fileURLToPath(new URL('../scripts/business-postgres-verify.mjs',import.meta.url)),secret='synthetic-not-for-output';
  const env={...process.env,EIGOS_BUSINESS_POSTGRES_URL:`postgresql://postgres:${secret}@localhost/postgres?sslmode=disable`,EIGOS_BUSINESS_POSTGRES_CA_FILE:'/tmp/fixture-ca'};
  const args=['--snapshot','/tmp/snapshot.sqlite','--authority','/tmp/authority.json','--policy-digest','a'.repeat(64),'--expected-file-digest','b'.repeat(64),'--schema','eigos_business_test'];
  const invalid=spawnSync(process.execPath,[script,...args],{env,encoding:'utf8'});
  assert.equal(invalid.status,2);assert.match(invalid.stderr,/must not include options/);assert(!invalid.stdout.includes(secret));assert(!invalid.stderr.includes(secret));
  const relative=spawnSync(process.execPath,[script,...args,'--snapshot','relative.sqlite'],{env,encoding:'utf8'});
  assert.equal(relative.status,2);assert(!relative.stdout.includes(secret));assert(!relative.stderr.includes(secret));
});
