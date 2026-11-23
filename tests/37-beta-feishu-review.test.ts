import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FeishuBetaReview, betaFeishuConfig } from '../packages/capabilities/feishu/beta-review.js';
import { hasBetaReadAccess } from '../packages/runtime/accounts.js';
import { BetaReview } from '../packages/runtime/beta-review.js';
import { accountGateway } from './account-harness.js';
import { fixture } from './fixture.js';

test('the public Beta page collects verified applicants and only their approved Feishu row can open the account and send mail', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'invite' });
  const directory = await mkdtemp(join(tmpdir(), 'eigos-feishu-beta-'));
  const path = join(directory, 'oauth.json'), approver = 'ou_approver';
  const config = betaFeishuConfig.parse({ baseToken: 'baseBeta', tableId: 'tblReview', approverOpenId: approver,
    mailbox: 'eigos@example.test', publicUrl: 'https://eigos.example.test',
    appId: 'cli_testapp', appSecretFile: join(directory, 'app.secret'), userTokenFile: path });
  const token = 'synthetic-test-access';
  await writeFile(path, JSON.stringify({ accessToken: token, refreshToken: 'synthetic-refresh',
    expiresAt: new Date(Date.now() + 300_000).toISOString() }), { mode: 0o600 });
  const records = new Map<string, { record_id: string; fields: Record<string, unknown>; last_modified_by: { id: string } }>();
  let createAttempts = 0, drafts = 0, sends = 0, loseCreate = true, loseSend = false;
  const mail: string[] = [];
  const fetcher: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    assert.equal(url.origin, 'https://open.feishu.cn');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + token);
    const body = JSON.parse(String(init?.body));
    const data = (value: unknown) => Response.json({ code: 0, data: value });
    if (url.pathname.endsWith('/search')) {
      const requested = body.filter.conditions[0].value[0] as string;
      assert(body.automatic_fields);
      return data({ items: [records.get(requested)].filter(Boolean), has_more: false });
    }
    if (url.pathname.endsWith('/batch_create')) {
      const [row] = body.records as [{ fields: Record<string, unknown> }];
      const applicationId = String(row.fields['申请编号']);
      assert.equal(url.searchParams.get('client_token'), applicationId);
      assert.equal(row.fields['批准使用'], false);
      assert(!records.has(applicationId));
      const record_id = 'rec' + String(++createAttempts);
      records.set(applicationId, { record_id, fields: row.fields, last_modified_by: { id: approver } });
      if (loseCreate) { loseCreate = false; throw new TypeError('Lost Base create acknowledgement'); }
      return data({ records: [{ record_id }] });
    }
    if (init?.method === 'PUT') {
      const row = [...records.values()].find(value => url.pathname.endsWith('/' + value.record_id))!;
      assert(row);
      assert.deepEqual(Object.keys(body.fields).sort(), ['邮件状态', '开通状态'].sort());
      Object.assign(row.fields, body.fields);
      return data({ record: { record_id: row.record_id } });
    }
    if (url.pathname.endsWith('/drafts')) {
      mail.push(Buffer.from(body.raw, 'base64url').toString());
      return data({ draft: { id: 'draft-' + ++drafts } });
    }
    if (url.pathname.endsWith('/send')) {
      sends++;
      if (loseSend) { loseSend = false; throw new TypeError('Lost mail response'); }
      assert(url.pathname.endsWith('/draft-1/send'));
      return data({ message_id: 'sent-1' });
    }
    throw new Error('Unexpected test request');
  };
  const runner = () => new BetaReview(f.db, new FeishuBetaReview(config, fetcher));
  const applicant = async (name: string) => {
    const email = name + '@example.test';
    const { cookie } = await g.login(name, email);
    assert.equal((await g.form('apply', cookie, new URLSearchParams({ email, purpose: 'Try EIGOS maps' }))).status, 303);
    return { cookie, email, owner: g.owner(name) };
  };
  try {
    const page = await fetch(g.url + '/beta');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /申请 EIGOS Beta[\s\S]*注册并申请/);
    const { cookie, owner, email } = await applicant('rider');
    const duplicate = await g.form('apply', cookie, new URLSearchParams({ email, purpose: 'Try EIGOS maps' }));
    assert.equal(duplicate.status, 303);
    assert.match(await g.page(cookie), /等待运营审核/);
    assert.equal((await runner().poll()).failures, 1);
    assert.equal((await runner().poll()).failures, 0);
    assert.equal(createAttempts, 1);
    const row = [...records.values()][0]!;
    row.fields['批准使用'] = 'true';
    await runner().poll();
    row.fields['批准使用'] = true;
    row.last_modified_by.id = 'ou_other_editor';
    await runner().poll();
    assert.equal(await g.accounts.account(owner), undefined);
    assert.equal(sends, 0);

    row.fields['已验证邮箱'] = 'different@example.test';
    row.last_modified_by.id = approver;
    await Promise.all([runner().poll(), runner().poll()]);
    assert.match(await g.page(cookie), /Beta 账号已开通/);
    assert.equal((await g.accounts.account(owner))?.approved_at, null);
    await g.form('approve', cookie);
    assert(await hasBetaReadAccess(f.db, owner));
    assert.match(mail[0]!, /To: <rider@example\.test>/);
    assert(!mail[0]!.includes('different@example.test'));
    const mailBody = Buffer.from(mail[0]!.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString();
    assert.match(mailBody, /可以开始测试[\s\S]*https:\/\/eigos\.example\.test\/account/);
    assert.equal(row.fields['邮件状态'], '已发送');
    await runner().poll();
    assert.deepEqual([drafts, sends], [1, 1]);
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.schema}.member_invitations`)).rowCount, 0);

    const other = await applicant('second');
    await runner().poll();
    const second = [...records.values()].at(-1)!;
    second.fields['批准使用'] = true;
    loseSend = true;
    await runner().poll();
    assert.equal((await g.accounts.account(other.owner))?.status, 'active');
    assert.equal(second.fields['邮件状态'], '待核对');
    await runner().poll();
    assert.deepEqual([drafts, sends], [2, 2]);
  } finally {
    await g.close(); await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
