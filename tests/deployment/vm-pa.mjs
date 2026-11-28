// Original PA for the isolated VM rehearsal. Its credential stays on the test runner.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Accounts, emailDigest } from '../../dist/packages/runtime/accounts.js';
import { Database } from '../../dist/packages/runtime/database.js';
import { businessGrants, setGrants } from '../../dist/packages/runtime/access.js';
import { Metadata } from '../../dist/packages/runtime/metadata.js';
import { digest } from '../../dist/packages/core/identity.js';
import { PersonalAgentClient } from '../../dist/packages/sdk/pa-client.js';
import { didiPAAccountResources } from '../../dist/packages/ontology/didi-pa-access.js';

const [command, file] = process.argv.slice(2);
const baseUrl = 'http://127.0.0.1:39117';
const address = '隔离演练合成住宅';
if (command === 'seed') {
  const db = new Database('postgres://postgres:synthetic-only@127.0.0.1:5432/vm_rehearsal');
  try {
    const owner = digest('vm-rehearsal-pa');
    const email = 'vm-pa@example.invalid';
    const accounts = new Accounts(db, 'invite');
    assert(await accounts.apply({ owner, email_hash: emailDigest(email) }, email, 'VM restore rehearsal'));
    assert(await accounts.approveApplication(owner, email));
    const token = await accounts.issueAgentToken(owner);
    assert(token);
    const model = await new Metadata(db).active();
    await setGrants(db, 'account-actions:' + owner, businessGrants(model).filter(g => didiPAAccountResources.has(g.resource)));
    const pa = new PersonalAgentClient({ baseUrl, token, ontology: 'Eigos' });
    const task = await pa.submitAction('save-home', 'SavePersonalPlace', {
      role: 'home', city: '上海', address, confirmed: true, expectedRevision: 0,
    }, 'original-chat');
    assert(task.id);
    await writeFile(file, JSON.stringify({ token, id: task.id }), { mode: 0o600, flag: 'wx' });
  } finally {
    await db.close();
  }
} else {
  assert.equal(command, 'read');
}
const { token, id } = JSON.parse(await readFile(file, 'utf8'));
const pa = new PersonalAgentClient({ baseUrl, token, ontology: 'Eigos' });
const until = Date.now() + 30000;
for (;;) {
  const task = await pa.get(id, AbortSignal.timeout(5000));
  assert.equal(task.id, id);
  assert.equal(task.contextId, 'original-chat');
  if (task.status.state === 'TASK_STATE_COMPLETED') break;
  assert(command === 'seed' && Date.now() < until, 'Original task state: ' + task.status.state);
  await delay(200);
}
const { items } = await pa.query('PersonalPlaceVersion');
assert.equal(items.length, 1);
assert.equal(items[0].properties.address, address);
console.log(id);
