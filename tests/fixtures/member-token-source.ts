import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../../packages/core/config.js';

export const sourceTokens = { alice: 'TEST_ALICE_PRIVATE_TOKEN_0123456789', bob: 'TEST_BOB_PRIVATE_TOKEN_9876543210', rotated: 'TEST_ALICE_ROTATED_TOKEN_2468013579' };
export function memberTokenSource(config: Config, dir: string) {
  const directory = join(dir, 'source'), bin = join(directory, 'bin'), keyFile = join(directory, 'vault.key'), log = join(directory, 'calls.jsonl'), behaviorPath = join(directory, 'behavior.json');
  mkdirSync(bin, { recursive: true, mode: 0o700 }); writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' }); writeFileSync(behaviorPath, '{}');
  writeFileSync(join(bin, 'pt-passport'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({command:'FORBIDDEN_PASSPORT'})+'\\n');process.exit(1);`, { mode: 0o700 });
  writeFileSync(join(directory, 'paotui.js'), `
const fs = require('node:fs');
const command = process.argv[2], behavior = JSON.parse(fs.readFileSync(${JSON.stringify(behaviorPath)},'utf8'));
const accounts = ${JSON.stringify(Object.fromEntries(Object.entries(sourceTokens).map(([name, token]) => [token, name])))};
const account = accounts[process.env.MCP_ACCESS_TOKEN];
if (!account) throw new Error('Unexpected credential');
if (fs.realpathSync(process.env.HOME) !== fs.realpathSync(process.cwd()) || fs.realpathSync(process.cwd()) === fs.realpathSync(${JSON.stringify(directory)})) throw new Error('Operator cache was inherited');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command, account})+'\\n');
if (behavior.revokeOn === command) {
 const {DatabaseSync} = require('node:sqlite'), db = new DatabaseSync(${JSON.stringify(config.DATABASE_PATH)});
 db.exec('PRAGMA busy_timeout=5000');
 const row=db.prepare('SELECT owner,body FROM member_source_credentials WHERE owner=?').get(behavior.owner);
 const body=JSON.parse(row.body);body.state='revoked';body.revision++;body.ciphertext='';
 db.prepare('UPDATE member_source_credentials SET body=? WHERE owner=?').run(JSON.stringify(body),row.owner);db.close();
}
if (behavior.failOn === command) throw new Error(process.env.MCP_ACCESS_TOKEN);
const addresses=[{addressId:account+'-a',address:account.toUpperCase()+'_PRIVATE_ORIGIN',cityId:1,name:'Synthetic',lat:1,lng:1},{addressId:account+'-b',address:account.toUpperCase()+'_PRIVATE_DESTINATION',cityId:1,name:'Synthetic',lat:2,lng:2}];
if (command==='get_address_list') console.log(JSON.stringify({status:'ok',addresses}));
else if (command==='get_address_info') console.log(JSON.stringify({status:'ok',phone:'13800000000'}));
else if (command==='delivery_preview') console.log(JSON.stringify({status:'ok',_previewTotal:account==='bob'?'23.50':'12.50',_deliveryFee:account==='bob'?'23.50':'12.50',feeDisplay:'synthetic'}));
else throw new Error('Unapproved command');
`, { mode: 0o600 });
  config.EIGOS_PAOTUI_SKILL_DIR = directory; config.EIGOS_MEMBER_SOURCE_KEY_FILE = keyFile; config.EIGOS_AUDIT_PATH = join(dir, 'gateway-audit.jsonl');
  return { directory, bin, keyFile, behavior: (value: object) => writeFileSync(behaviorPath, JSON.stringify(value)),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s) as { command: string; account?: string }) : [] };
}
