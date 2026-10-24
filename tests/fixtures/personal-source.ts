import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Member } from '../../packages/members/store.js';
import type { Config } from '../../packages/core/config.js';
import type { PersonalSource } from '../../packages/core/personal-source.js';

// No real credential or merchant: the actual Worker -> stdio MCP -> local CLI
// transport runs against deterministic, isolated executables in this test directory.
export function personalSourceFixture(config: Config, context: { alice: Member; dir: string }) {
  const directory = join(context.dir, 'source'), bin = join(directory, 'bin'), connectionFile = join(directory, 'connection.json');
  const log = join(directory, 'calls.jsonl'), behaviorFile = join(directory, 'behavior.json');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const connection: PersonalSource = { version: 1, connectionId: randomUUID(), revision: 1, memberId: context.alice.id,
    owner: { issuer: context.alice.issuer, tenant: context.alice.tenant, subject: context.alice.subject }, credential: 'local_pt_passport', localUid: process.getuid!(), purpose: 'delivery_quote_readonly', state: 'active', expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const write = (value: unknown) => writeFileSync(connectionFile, JSON.stringify(value), { mode: 0o600 }); write(connection);
  writeFileSync(behaviorFile, '{}');
  writeFileSync(join(bin, 'pt-passport'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command:'passport'})+'\\n');console.log('TEST_ONLY_SECRET_NEVER_PERSIST');`, { mode: 0o700 });
  writeFileSync(join(directory, 'paotui.js'), `
const fs = require('node:fs');
const command = process.argv[2], args = process.argv.slice(3);
const behavior = JSON.parse(fs.readFileSync(${JSON.stringify(behaviorFile)}, 'utf8'));
if (process.env.MCP_ACCESS_TOKEN !== 'TEST_ONLY_SECRET_NEVER_PERSIST') throw new Error('Missing fixture token');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({command})+'\\n');
if (behavior.revokeOn === command) {
  const file=${JSON.stringify(connectionFile)}, c=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...c,state:'revoked',revision:c.revision+1}));
}
if (behavior.failOn === command) throw new Error('TEST_ONLY_SECRET_NEVER_PERSIST provider error');
const addresses=[{addressId:'owned-a',address:'PRIVATE_TEST_ORIGIN',cityId:1,name:'Synthetic A',lat:1,lng:1},{addressId:'owned-b',address:'PRIVATE_TEST_DESTINATION',cityId:1,name:'Synthetic B',lat:2,lng:2}];
if (command==='get_address_list') console.log(JSON.stringify({status:'ok',addresses}));
else if (command==='get_address_info') console.log(JSON.stringify({status:'ok',phone:'13800000000'}));
else if (command==='delivery_preview') console.log(JSON.stringify({status:'ok',_previewTotal:'12.50',_deliveryFee:'12.50',feeDisplay:'12.50元'}));
else throw new Error('Unapproved command');
`, { mode: 0o600 });
  config.EIGOS_PAOTUI_SKILL_DIR = directory;
  config.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE = connectionFile;
  return { directory, bin, connectionFile, connection, write,
    behavior: (value: object) => writeFileSync(behaviorFile, JSON.stringify(value)),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s) as { command: string }) : [] };
}
