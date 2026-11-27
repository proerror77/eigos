import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Accounts } from '../packages/runtime/accounts.js';
import { FeishuReviewCards, feishuReviewHandler, initializeFeishuCards, reviewCallbackPath, syncFeishuCards } from '../scripts/feishu-beta-card-review.js';
import { accountGateway } from './account-harness.js';
import { fixture } from './fixture.js';

test('only the designated reviewer can open the linked applicant, and the original card reconciles after an update failure', async () => {
  const f = await fixture(), gateway = await accountGateway(f, { signup: 'invite' });
  const config = { appId: 'cli_synthetic', reviewerOpenId: 'ou_reviewer', encryptKey: 'synthetic-encryption-key',
    verificationToken: 'synthetic-verification-token' };
  const server = feishuReviewHandler(f.db, config).listen(0, '127.0.0.1');
  await new Promise<void>((ok, reject) => { server.once('listening', ok); server.once('error', reject); });
  const callback = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + reviewCallbackPath;
  const email = 'beta-card-review@example.test', owner = gateway.owner('beta-card');
  const message = 'om_synthetic', accounts = new Accounts(f.db, 'invite');
  let key: string | undefined, sendCount = 0, updateCount = 0, allowPatch = false, currentTitle: string | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), data = JSON.parse(String(init?.body));
    assert.equal(url.origin, 'https://open.feishu.cn');
    if (url.pathname.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'synthetic-token', expire: 7200 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-token');
    const card = JSON.parse(data.content);
    if (url.pathname === '/open-apis/im/v1/messages') {
      sendCount++;
      assert.equal(data.receive_id, config.reviewerOpenId);
      assert.equal(data.msg_type, 'interactive');
      key = card.elements[1].actions[0].value.key;
      assert.equal(data.uuid, key);
      currentTitle = card.header.title.content;
      return Response.json({ code: 0, data: { message_id: message } });
    }
    updateCount++;
    assert.equal(init?.method, 'PATCH');
    assert.equal(url.pathname, '/open-apis/im/v1/messages/' + message);
    if (!allowPatch) return Response.json({ code: 17 }, { status: 503 });
    assert.match(card.header.title.content, /已开通/);
    assert.equal(card.elements.length, 1);
    currentTitle = card.header.title.content;
    return Response.json({ code: 0 });
  };
  const payload = (reviewer = config.reviewerOpenId, messageId = message, createdAt = String(Date.now()) + '000') => ({
    schema: '2.0', header: { app_id: config.appId, event_type: 'card.action.trigger', token: config.verificationToken,
      create_time: createdAt },
    event: { operator: { open_id: reviewer }, context: { open_message_id: messageId },
      action: { tag: 'button', value: { kind: 'eigos_beta_approve', key } } },
  });
  const click = (value: unknown, correctSignature = true, stamp = String(Math.floor(Date.now() / 1000))) => {
    const iv = randomBytes(16), nonce = randomBytes(8).toString('hex');
    const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(config.encryptKey).digest(), iv);
    const body = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64') });
    const signature = createHash('sha256').update(stamp + nonce + config.encryptKey).update(body).digest('hex');
    return fetch(callback, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Lark-Request-Timestamp': stamp,
      'X-Lark-Request-Nonce': nonce, 'X-Lark-Signature': correctSignature ? signature : 'a'.repeat(64) } });
  };
  try {
    await initializeFeishuCards(f.db);
    await gateway.login('beta-card', email);
    const bot = new FeishuReviewCards(config.appId, 'synthetic', config.reviewerOpenId, fakeFetch);
    const sync = () => syncFeishuCards(f.db, bot);
    assert.equal((await sync()).sent, 1);
    assert.match(currentTitle!, /待审核/);
    assert.equal((await click(payload(), false)).status, 401);
    assert.equal((await (await click(payload('ou_other'))).json()).toast.type, 'error');
    assert.equal((await (await click(payload(config.reviewerOpenId, 'om_other'))).json()).toast.type, 'error');
    assert.equal((await sync()).inspected, 0);
    assert.equal(await accounts.account(owner), undefined);
    const transportTimestamp = new Date().toISOString();
    const staleTime = Date.now() - 360_000;
    assert.equal((await click(payload(config.reviewerOpenId, message, String(staleTime) + '000'), true, transportTimestamp)).status, 401);
    assert.equal((await click(payload(config.reviewerOpenId, message, 'invalid'), true, transportTimestamp)).status, 401);
    assert.equal((await click(payload(), true, String(staleTime) + '000')).status, 401);
    assert.equal((await click(payload(), false, transportTimestamp)).status, 401);
    assert.match((await (await click(payload(), true, transportTimestamp)).json()).toast.content, /正在开通/);
    assert.equal((await sync()).failures, 1);
    assert.equal((await accounts.account(owner))?.status, 'active');
    assert.match(currentTitle!, /待审核/);
    allowPatch = true;
    assert.equal((await sync()).updated, 1);
    assert.match(currentTitle!, /已开通/);
    for (const stamp of [String(Math.floor(Date.now() / 1000)), String(Date.now()), String(Date.now()) + '000', String(Date.now()) + '000000']) {
      assert.match((await (await click(payload(), true, stamp)).json()).toast.content, /已处理/);
    }
    assert.deepEqual(await sync(), { inspected: 0, sent: 0, updated: 0, failures: 0 });
    assert.deepEqual([sendCount, updateCount], [1, 2]);
  } finally {
    await new Promise<void>(ok => server.close(() => ok()));
    await gateway.close();
    await f.close();
  }
});
