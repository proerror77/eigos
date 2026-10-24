import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { networkGatewayFixture } from './fixtures/network-gateway.js';
import { ownerKey } from '../packages/core/domain.js';
import { inquiryFixture } from './fixtures/network-inquiry.js';
import { inquiryPage, workbenchPage } from '../apps/gateway/network/workbench-page.js';
import type { TaskSummary } from '../packages/core/task-summary.js';

function hidden(html: string, name: string) {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert(value, name); return value;
}

test('T12 member task form resumes the same task; MCP/A2A read back the reply, isolation and stale form fences hold', async () => {
  const f = await networkGatewayFixture(), client = new Client({ name: 't12-test-agent', version: '1' });
  try {
    const owner = ownerKey(f.a.p), task = f.gateway.tasks.submit(f.a.p, { goal: 'PRIVATE_TASK <script>no()</script>', requestId: randomUUID() });
    task.state = 'input-required'; task.question = '选择合成地址 A 还是 B？'; f.gateway.store.save(owner, task);
    const cookie = { Cookie: `__Host-eigos-member=${f.session.token}` }, url = `/members/network/tasks/${task.id}`;
    const page = await f.call(url, undefined, cookie), html = await page.text();
    assert.equal(page.status, 200); assert.equal(page.headers.get('referrer-policy'), 'same-origin'); assert.equal(page.headers.get('cache-control'), 'no-store'); assert(html.includes('&lt;script&gt;')); assert(!html.includes('<script>'));
    assert(html.includes('仅本人')); assert(html.includes(task.id)); assert(html.includes('选择合成地址'));
    const wb = await f.call('/members/network/workbench', undefined, cookie); assert.equal(wb.status, 200); assert((await wb.text()).includes(url));
    assert.equal((await f.call(url)).status, 401);
    assert.equal((await f.call(url, undefined, { Authorization: `Bearer ${f.a.token}` })).status, 401);
    const bs = f.gateway.members.createSession(f.bob.id), otherCookie = { Cookie: `__Host-eigos-member=${bs.token}` };
    const denied = await f.call(url, undefined, otherCookie); assert.equal(denied.status, 404); assert(!(await denied.text()).includes('PRIVATE_TASK'));
    assert(!(await (await f.call('/members/network/workbench', undefined, otherCookie)).text()).includes(task.id));
    const input = { _csrf: f.session.csrf, requestId: hidden(html, 'requestId'), expectedRevision: hidden(html, 'expectedRevision'), expectedUpdatedAt: hidden(html, 'expectedUpdatedAt'), answer: 'A，只补充合成地址，不下单' };
    const headers = { ...cookie, Origin: f.origin };
    assert.equal((await f.call(url + '/reply', { ...input, _csrf: 'wrong' }, headers)).status, 403);
    assert.equal((await f.call(url + '/reply', input, { ...headers, Origin: 'https://evil.test' })).status, 403);
    assert.equal((await f.call(url + '/reply', { ...input, _csrf: bs.csrf }, { ...otherCookie, Origin: f.origin })).status, 404);
    assert.equal((await f.call(url + '/reply', { ...input, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }, headers)).status, 409);
    const form = new URLSearchParams(input);
    const submitted = await fetch(f.http + url + '/reply', { method: 'POST', redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    assert.equal(submitted.status, 303); assert.equal(submitted.headers.get('location'), url);
    const refreshed = await f.call(url, undefined, cookie); assert((await refreshed.text()).includes('等待处理'));
    const replay = await f.call(url + '/reply', input, headers); assert.equal(replay.status, 409);
    const job = f.gateway.tasks.get(f.a.p, task.id); assert.equal(job.messages.filter(m => m.text === input.answer).length, 1);
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.http), { requestInit: { headers: { Authorization: `Bearer ${f.a.token}` } } }));
    const mcp = await client.callTool({ name: 'get_task', arguments: { taskId: task.id } }); assert(!mcp.isError, JSON.stringify(mcp));
    const summary = (mcp.structuredContent as { result: TaskSummary }).result, accepted = job.messages.findLast(m => m.role === 'user')!;
    assert.deepEqual(summary.latestInput, { id: accepted.id, text: input.answer, receivedAt: accepted.at }); assert(!('messages' in summary));
    const rpc = await f.call('/a2a', { jsonrpc: '2.0', id: 't12', method: 'GetTask', params: { id: task.id } }, { Authorization: `Bearer ${f.a.token}`, 'A2A-Version': '1.0' });
    const a2a = (await rpc.json()).result; assert.equal(a2a.id, task.id); assert.equal(a2a.status.state, 'TASK_STATE_SUBMITTED'); assert.deepEqual(a2a.metadata.latestInput, summary.latestInput);
    assert.equal(f.gateway.store.list(owner, { limit: 20, offset: 0 }).total, 1);
    f.gateway.members.setStatus(f.alice.id, 'suspended');
    assert.equal((await f.call('/members/network/workbench', undefined, cookie)).status, 403);
  } finally { await client.close(); await f.close(); }
});

test('T12 workbench pagination and unknown objects have bounded, useful responses without private leaks', async () => {
  const f = await networkGatewayFixture(); try {
    for (let n = 0; n < 21; n++) f.gateway.tasks.submit(f.a.p, { goal: `Private task ${n}`, requestId: randomUUID() });
    const cookie = { Cookie: `__Host-eigos-member=${f.session.token}` };
    const first = await f.call('/members/network/workbench', undefined, cookie), html = await first.text();
    assert.equal((html.match(/<span class="tag">仅本人/g) ?? []).length, 20); assert(html.includes('offset=20'));
    const next = await f.call('/members/network/workbench?offset=20', undefined, cookie); assert.equal(((await next.text()).match(/<span class="tag">仅本人/g) ?? []).length, 1);
    assert.equal((await f.call('/members/network/workbench?offset=-1', undefined, cookie)).status, 422);
    const missing = await f.call('/members/network/inquiries/' + randomUUID(), undefined, cookie); assert.equal(missing.status, 404); assert((await missing.text()).includes('已过期、撤回'));
    const space = f.gateway.network!.store.spaceId;
    const stale = await f.call(`/members/network/spaces/${space}?cursor=invalid`, undefined, cookie); assert.equal(stale.status, 409); assert((await stale.text()).includes('游标已过期'));
  } finally { await f.close(); }
});

test('T12 auth-required tasks cannot be approved by a reply or additional form fields', async () => {
  const f = await networkGatewayFixture(); try {
    const task = f.gateway.tasks.submit(f.a.p, { goal: 'Private authorization test', requestId: randomUUID() });
    task.state = 'auth-required'; f.gateway.store.save(ownerKey(f.a.p), task);
    const url = `/members/network/tasks/${task.id}`, cookie = { Cookie: `__Host-eigos-member=${f.session.token}` };
    const page = await f.call(url, undefined, cookie), html = await page.text(); assert(!html.includes('<textarea')); assert(html.includes('需要独立授权'));
    const body = { _csrf: f.session.csrf, requestId: randomUUID(), expectedRevision: task.revision, expectedUpdatedAt: task.updatedAt, answer: 'approve' };
    assert.equal((await f.call(url + '/reply', body, { ...cookie, Origin: f.origin })).status, 409);
    assert.equal((await f.call(url + '/reply', { ...body, permit: { environment: 'live' } }, { ...cookie, Origin: f.origin })).status, 422);
    assert.equal(f.gateway.tasks.get(f.a.p, task.id).state, 'auth-required');
  } finally { await f.close(); }
});

test('T12 private views distinguish stale decisions, corrected evidence and expired approvals without new source calls', async () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), job = await f.run();
    const quoteId = (job.artifact!.data.result as { ontologyReceipt: { id: string } }).ontologyReceipt.id;
    const choice = f.command({ operation: 'inquiry.request_selection', input: { inquiryId: inquiry.id, expectedRequestRevision: 1, quote: { type: 'DeliveryQuote', id: quoteId, revision: 1 }, selectionKind: 'reviewed' } }).refs[0]!.id;
    f.confirm(choice); f.command({ operation: 'inquiry.select_quote', choiceId: choice });
    assert(inquiryPage(f.service, f.a.member.id, inquiry.id).includes('当前版本有效'));
    const cardId = f.command({ operation: 'evidence.prepare', source: { kind: 'task', taskId: job.id }, projection: { kind: 'result' } }).refs[0]!.id;
    const draftId = f.command({ operation: 'draft.create', content: { kind: 'evidence_card', cardId, cardRevision: 1 } }).refs[0]!.id;
    const approvalId = f.request(draftId);
    const source = f.jobs.ontology.read(f.owner, { type: 'DeliveryQuote', id: quoteId });
    f.jobs.ontology.ingest(f.owner, { objects: [{ ref: source.ref, properties: { ...source.properties, serviceLevel: 'express' }, expectedRevision: source.revision }] }, source.source);
    assert(inquiryPage(f.service, f.a.member.id, inquiry.id).includes('已过期或来源、要求已变化'));
    const stale = workbenchPage(f.service, f.a.member.id); assert(stale.includes('来源已变化'));
    assert.equal(f.service.panel(f.a.member.id).approvals.find(a => a.id === approvalId)?.current, false);
    assert.throws(() => f.service.memberInquiry(f.b.member.id, inquiry.id), (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'NOT_FOUND');
    assert.equal(f.readCount(), 2); assert.equal(f.alternateReadCount(), 0);
    assert.equal(f.store.scan('evidence').length, 1, 'Read-only pages do not create additional cards');
  } finally { f.close(); }
});


test('T12 displayed-question fence is checked inside the shared task write transaction', async () => {
  const f = await networkGatewayFixture(); try {
    const owner = ownerKey(f.a.p), task = f.gateway.tasks.submit(f.a.p, { goal: 'Concurrent question test', requestId: randomUUID() });
    task.state = 'input-required'; task.question = 'Old question'; f.gateway.store.save(owner, task);
    const once = f.gateway.store.once.bind(f.gateway.store);
    // A Worker commits a new question after the page precheck, before the reply transaction.
    f.gateway.store.once = (o, operation, id, fingerprint, action) => {
      const changed = f.gateway.store.get(owner, task.id); changed.updatedAt = new Date(Date.parse(task.updatedAt) + 1).toISOString(); changed.question = 'New question'; f.gateway.store.save(owner, changed);
      return once(o, operation, id, fingerprint, action);
    };
    const response = await f.call(`/members/network/tasks/${task.id}/reply`, { _csrf: f.session.csrf, requestId: randomUUID(), expectedRevision: task.revision, expectedUpdatedAt: task.updatedAt, answer: 'Answer to old question' }, { Cookie: `__Host-eigos-member=${f.session.token}`, Origin: f.origin });
    assert.equal(response.status, 409);
    const current = f.gateway.tasks.get(f.a.p, task.id); assert.equal(current.question, 'New question'); assert.equal(current.messages.length, 1);
  } finally { await f.close(); }
});
