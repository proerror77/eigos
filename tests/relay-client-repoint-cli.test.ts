import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(new URL('../scripts/relay-client-repoint.mjs',import.meta.url));
const args=['--apply','--config','/tmp/cutover.json','--credential','/tmp/node.json','--agent-id','agent_'+'a'.repeat(43)];
test('Relay repoint CLI requires an explicit stopped-source assertion',()=>{
  const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stderr,/source-stopped/);
});
test('Relay repoint CLI rejects database TLS overrides without exposing credentials',()=>{
  const secret='synthetic-secret-not-for-output';
  const env={...process.env,EIGOS_RELAY_POSTGRES_URL:`postgresql://postgres:${secret}@localhost/postgres?sslmode=disable`,EIGOS_RELAY_POSTGRES_CA_FILE:'/tmp/ca.pem'};
  const result=spawnSync(process.execPath,[script,...args,'--source-stopped'],{env,encoding:'utf8'});
  assert.equal(result.status,2);assert.match(result.stderr,/must not include options/);assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));
});
