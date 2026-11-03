import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readHarnessLogin, refreshHarnessLogin } from '../packages/deployment/harness-login.js';

const token = (seconds: number) => 'synthetic.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url') + '.synthetic';
function fixture(mode = 'success', seconds = -30) {
  const root = mkdtempSync(join(tmpdir(), 'eigos-cloud-login-')), home = join(root, 'codex-home'), output = join(root, 'access'), binary = join(root, 'native.cjs'), log = join(root, 'calls.jsonl');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  const authPath = join(home, 'auth.json'), next = token(3600), old = token(seconds), credentialFile = join(output, 'current.json');
  writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: old, refresh_token: 'NEVER_EXPORT_REFRESH', id_token: 'NEVER_EXPORT_ID' } }), { mode: 0o600 });
  writeFileSync(binary, '#!' + process.execPath + '\n' + String.raw`
const fs=require('node:fs'),readline=require('node:readline'),path=require('node:path');
const log=LOG_VALUE,mode=MODE_VALUE;
fs.writeFileSync(log,JSON.stringify({boot:true,env:Object.keys(process.env)})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(!q.id)return;fs.appendFileSync(log,JSON.stringify({method:q.method,params:q.params})+'\n');
 if(mode==='hang')return;
 if(mode==='limit'){process.stdout.write('x'.repeat(270000));return;}
 if(mode==='invalid'){console.log('not-json');return;}
 if(q.method==='account/read'&&mode==='denied'){console.log(JSON.stringify({id:q.id,error:{message:'NEVER_LOG_PROVIDER_SECRET'}}));return;}
 if(q.method==='account/read')fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:NEXT_VALUE,refresh_token:'NEVER_EXPORT_REFRESH',id_token:'NEVER_EXPORT_ID'}}));
 console.log(JSON.stringify({id:q.id,result:q.method==='account/read'?{account:{type:'chatgpt'}}:{}}));
});
`.replace('LOG_VALUE', JSON.stringify(log)).replace('MODE_VALUE', JSON.stringify(mode)).replace('NEXT_VALUE', JSON.stringify(next)), { mode: 0o700 });
  const configPath = join(root, 'login.json'); writeFileSync(configPath, JSON.stringify({ version: 1, codexBin: binary, codexHome: home, credentialFile }), { mode: 0o600 });
  return { root, authPath, home, output, binary, log, next, old, configPath, credentialFile, config: readHarnessLogin(configPath, root), close: () => rmSync(root, { recursive: true, force: true }) };
}

test('cloud login uses native refresh before atomically publishing an access-only snapshot', async t => {
  const f = fixture(); t.after(f.close);
  const result = await refreshHarnessLogin(f.config);
  assert.equal(result.refreshed, true);
  assert.deepEqual(JSON.parse(readFileSync(f.credentialFile, 'utf8')), { auth_mode: 'chatgpt', tokens: { access_token: f.next } });
  assert.equal(statSync(f.credentialFile).mode & 0o777, 0o600);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.slice(1).map(call => call.method), ['initialize', 'account/read']);
  assert.deepEqual(calls[2].params, { refreshToken: true });
  assert(!calls[0].env.includes('EIGOS_DEV_TOKEN')); assert(!calls[0].env.includes('OPENAI_API_KEY'));
  assert(!JSON.stringify(result).includes('NEVER_EXPORT')); assert(!readFileSync(f.credentialFile, 'utf8').includes('NEVER_EXPORT'));
  assert.equal(JSON.parse(readFileSync(f.authPath, 'utf8')).tokens.refresh_token, 'NEVER_EXPORT_REFRESH');
});

test('current cloud access does not rotate its owner unnecessarily, while explicit force verifies renewal', async t => {
  const f = fixture('success', 3600); t.after(f.close);
  const original = readFileSync(f.authPath);
  assert.equal((await refreshHarnessLogin(f.config)).refreshed, false); assert(!existsSync(f.log)); assert(readFileSync(f.authPath).equals(original));
  assert.equal((await refreshHarnessLogin(f.config, { force: true })).refreshed, true);
});

for (const mode of ['denied', 'limit', 'invalid']) test('a ' + mode + ' native refresh cannot replace the last complete snapshot or leak provider errors', async t => {
  const f = fixture(mode); t.after(f.close);
  writeFileSync(f.credentialFile, '{"previous":"complete"}', { mode: 0o600 });
  await assert.rejects(refreshHarnessLogin(f.config), error => error instanceof Error && !error.message.includes('NEVER_LOG_PROVIDER_SECRET'));
  assert.equal(readFileSync(f.credentialFile, 'utf8'), '{"previous":"complete"}');
});

test('cloud login rejects shared/public paths and refresh-owner exposure', async t => {
  const f = fixture(); t.after(f.close);
  const change = (values: object) => writeFileSync(f.configPath, JSON.stringify({ version: 1, codexBin: f.binary, codexHome: f.home, credentialFile: f.credentialFile, ...values }));
  change({ credentialFile: f.authPath }); assert.throws(() => readHarnessLogin(f.configPath, f.root), /refresh-owner/);
  change({ codexHome: tmpdir() }); assert.throws(() => readHarnessLogin(f.configPath, f.root), /private login|isolated/);
  change({}); chmodSync(f.authPath, 0o644); await assert.rejects(refreshHarnessLogin(f.config), /private login file/);
  chmodSync(f.authPath, 0o600); symlinkSync(f.authPath, f.credentialFile); await assert.rejects(refreshHarnessLogin(f.config));
});

test('a stalled native refresh has a bounded lifetime and preserves the previous credential', async t => {
  const f = fixture('hang'); t.after(f.close); t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = refreshHarnessLogin(f.config).then(() => undefined, (error: unknown) => error);
  const deadline = Date.now() + 8000; while (!existsSync(f.log) && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  assert(existsSync(f.log)); t.mock.timers.tick(45001); assert(await pending instanceof Error); assert(!existsSync(f.credentialFile));
});

test('malformed private auth never echoes credential fragments into errors', async t => {
  const f = fixture(); t.after(f.close); writeFileSync(f.authPath, 'NEVER_EXPORT_REFRESH');
  await assert.rejects(refreshHarnessLogin(f.config), error => error instanceof Error && error.message === 'Invalid private login JSON');
  assert(!existsSync(f.log)); assert(!existsSync(f.credentialFile));
});
