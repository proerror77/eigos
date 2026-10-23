import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DidiMcpConnector, DidiReadError } from '../packages/capabilities/didi/connector.js';
import { DidiAgentProgram, DIDI_PROGRAM_REF } from '../packages/capabilities/didi/program.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { estimatedMoney, mapDidiResult } from '../packages/capabilities/didi/mapping.js';
import { checkedRideEstimate } from '../packages/ontology/ride-estimate-projection.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/delegation.js';
import { groundRequirements } from '../packages/coordinator/requirements.js';
import { owner, principal } from './backend-fixture.js';
import { didiFixture, setupDidi, chooseDidi, observeDidi, input, syntheticKey } from './fixtures/didi.js';

const context = { requestId: 'fixture-request', requestRevision: 1, actionInputDigest: 'x', planId: 'fixture-plan', intentId: 'fixture-intent', attemptId: 'fixture-attempt', modelRunId: 'fixture-model' };
const signal = () => AbortSignal.timeout(5000);

test('DiDi is off by default, account scoped, pure on construction, and configured identically for both roles', () => {
  const f = didiFixture(); try {
    assert(!createExecutionCatalog().summaries(owner).some(c => c.ref.id === DIDI_PROGRAM_REF.id));
    const catalog = createExecutionCatalog({ didi: f.binding });
    assert(catalog.summaries(owner).some(c => c.ref.id === DIDI_PROGRAM_REF.id));
    assert(!catalog.summaries('other-owner').some(c => c.ref.id === DIDI_PROGRAM_REF.id));
    assert(!catalog.summaries(owner, 16, 'sandbox').some(c => c.ref.id === DIDI_PROGRAM_REF.id));
    const env = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(40), EIGOS_DIDI_KEY_FILE: f.keyFile, EIGOS_DIDI_KEY_SHA256: f.binding.keySha256, EIGOS_DIDI_BINDING_ID: f.binding.bindingId };
    assert.equal(readConfig(env).EIGOS_DIDI_KEY_FILE, readWorkerConfig(env).EIGOS_DIDI_KEY_FILE);
    for (const override of [{ HOST: '0.0.0.0' }, { NODE_ENV: 'production' }, { EIGOS_AUTH_MODE: 'jwt' }, { EIGOS_DIDI_KEY_FILE: 'relative' }, { EIGOS_DIDI_KEY_SHA256: undefined }, { EIGOS_DIDI_BINDING_ID: undefined }, { EIGOS_DIDI_AUDIT_DIR: 'relative' }, { EIGOS_DIDI_ORDERS_ENABLED: 'true' }]) assert.throws(() => readWorkerConfig({ ...env, ...override }));
    assert.equal(f.calls.length, 0);
    assert.notEqual(new DidiAgentProgram({ ...f.binding, keySha256: '1'.repeat(64) }).configurationDigest, new DidiAgentProgram(f.binding).configurationDigest);
  } finally { f.close(); }
});

test('Only the two whitelisted tools reach the SDK transport; provider advertising writes grants no authority', async () => {
  const f = didiFixture(); try {
    for (const tool of ['taxi_create_order', 'taxi_cancel_order', 'taxi_query_order', 'taxi_get_driver_location', 'taxi_generate_ride_app_link', '__proto__']) await assert.rejects(f.connector.invoke(context, tool as never, {}, signal()), e => e instanceof DidiReadError && e.code === 'TOOL_NOT_ALLOWED');
    assert.equal(f.calls.length, 0);
    const directory = await f.connector.discover(signal()); assert.deepEqual(directory.enabledTools.map(t => t.name), ['maps_textsearch', 'taxi_estimate']);
    assert(!f.calls.some(c => c.method === 'tools/call'));
    await f.connector.invoke(context, 'maps_textsearch', { city: '北京市', keywords: '北京西站' }, signal());
    assert(f.calls.every(c => c.redirect === 'manual'));
    await assert.rejects(f.connector.invoke(context, 'maps_textsearch', { city: '北京市', keywords: 'x', endpoint: 'https://evil.example' }, signal()));
    await assert.rejects(f.connector.invoke(context, 'taxi_estimate', { from_lat: 1 }, signal()));
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  } finally { f.close(); }
});

test('Private credential permissions, symlinks, changed account and missing credential are rejected without network', async () => {
  const f = didiFixture(); try {
    chmodSync(f.keyFile, 0o644); await assert.rejects(f.connector.discover(signal()), /PRIVATE_CREDENTIAL_UNAVAILABLE/);
    chmodSync(f.keyFile, 0o600); writeFileSync(f.keyFile, 'different-account-key', { mode: 0o600 }); await assert.rejects(f.connector.discover(signal()), /PRIVATE_CREDENTIAL_UNAVAILABLE/);
    const link = join(f.directory, 'link'); symlinkSync(f.keyFile, link);
    await assert.rejects(new DidiMcpConnector({ ...f.binding, keyFile: link }).discover(signal()), /PRIVATE_CREDENTIAL_UNAVAILABLE/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('Exact decimal prices convert without floats; approximate, ranged and absent prices stay unknown', () => {
  assert.deepEqual(estimatedMoney('73.05'), { minor: '7305', currency: 'CNY' });
  assert.deepEqual(estimatedMoney('￥0.10元'), { minor: '10', currency: 'CNY' });
  for (const price of ['约73元', '100-120元', '73起', '1.234', '', '-1', '1e3']) assert.equal(estimatedMoney(price), undefined);
  assert.throws(() => mapDidiResult('taxi_estimate', { content: [{ type: 'text', text: 'success: 10 yuan' }] }));
  assert.throws(() => mapDidiResult('maps_textsearch', { content: [{ type: 'text', text: 'not JSON' }] }));
});

test('A credential revoked during an in-flight read prevents accepting its return', async () => {
  const f = didiFixture(); try {
    f.flags.before = async () => { chmodSync(f.keyFile, 0o644); };
    await assert.rejects(f.connector.invoke(context, 'maps_textsearch', { city: '北京市', keywords: '北京西站' }, signal()), /PRIVATE_CREDENTIAL_UNAVAILABLE/);
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  } finally { f.close(); }
});

test('Official SDK handles a Streamable HTTP event-stream tool response', async () => {
  const f = didiFixture(); try {
    f.flags.transform = (body, request) => request.method === 'tools/call' ? new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : body;
    const result = await f.connector.invoke(context, 'maps_textsearch', { city: '北京市', keywords: '北京西站' }, signal());
    assert.equal(result.data.kind, 'places'); assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  } finally { f.close(); }
});

test('HTTP, RPC, MCP, schema drift, redirect, oversized body and credential echoes fail without source replay or leakage', async () => {
  const cases = [
    (body: any, req: any) => req.method === 'tools/list' ? new Response(null, { status: 302, headers: { location: 'https://evil.example' } }) : body,
    (body: any, req: any) => req.method === 'tools/list' ? new Response('private denial', { status: 401 }) : body,
    (body: any, req: any) => req.method === 'tools/list' ? new Response('limit', { status: 429 }) : body,
    (body: any, req: any) => { if (req.method === 'tools/list') body.result.tools[0].inputSchema.required.push('undocumented'); return body; },
    (body: any, req: any) => req.method === 'tools/call' ? { ...body, error: { code: -32021, message: syntheticKey }, result: undefined } : body,
    (body: any, req: any) => req.method === 'tools/call' ? { ...body, result: { isError: true, content: [{ type: 'text', text: syntheticKey }] } } : body,
    (body: any, req: any) => req.method === 'tools/call' ? { ...body, result: { content: [{ type: 'text', text: JSON.stringify([{ name: syntheticKey }]) }] } } : body,
    (body: any, req: any) => req.method === 'tools/call' ? new Response('x'.repeat(1048600), { headers: { 'content-type': 'application/json' } }) : body,
  ];
  for (const transform of cases) {
    const f = didiFixture(); try {
      f.flags.transform = transform;
      await assert.rejects(f.connector.invoke(context, 'maps_textsearch', { city: '北京市', keywords: '北京西站' }, signal()), error => { assert(error instanceof DidiReadError); assert(!String(error).includes(syntheticKey)); return true; });
      assert(f.calls.filter(c => c.method === 'tools/call').length <= 1);
    } finally { f.close(); }
  }
});

test('Agent searches independently, chooses non-first exact endpoints, and projects source-backed estimates only', async () => {
  const t = setupDidi(); try {
    const job = t.b.submit({ goal: '只查北京西站到西二旗地铁站的滴滴估价，不下单不付款' });
    await t.b.run(); assert.equal(t.calls.length, 0, 'initialization is pure');
    const done = await t.finish(job.id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback)); assert(done.delegation!.acceptance?.accepted);
    const calls = t.calls.filter(c => c.method === 'tools/call'); assert.equal(calls.length, 3);
    const estimate = calls.find(c => c.name === 'taxi_estimate')!;
    assert.equal(estimate.args!.from_lng, '116.32'); assert.equal(estimate.args!.from_lat, '39.92');
    assert.equal(typeof estimate.args!.from_lng, 'string'); assert.equal(estimate.args!.from_name, input.origin);
    const observations = done.delegation!.agent!.observations, ref = observations.find(r => r.type === 'RideEstimateObservation')!;
    const s = checkedRideEstimate(t.store.ontology.read(owner, ref).properties.snapshot); assert.equal(s.data.kind, 'estimate');
    if (s.data.kind !== 'estimate') assert.fail(); assert.deepEqual(s.data.items[0]!.estimatedMoney, { minor: '7305', currency: 'CNY' }); assert.equal(s.data.items[1]!.estimatedMoney, undefined);
    assert.equal(t.store.ontology.evaluate(owner, { function: 'rideEstimateStatus', object: ref }).status, 'known');
    for (const type of ['RideRequest', 'RideOption', 'RideTrip', 'Order', 'Payment']) assert.equal(t.store.ontology.query(owner, { type }).items.length, 0);
    const serialized = JSON.stringify(done); assert(!serialized.includes(syntheticKey)); assert(!serialized.includes('PRIVATE_TRACE'));
    const raw = readFileSync(join(t.directory, 'audit', 'responses', s.id + '.json'), 'utf8'); assert(raw.includes('PRIVATE_TRACE')); assert(!raw.includes(syntheticKey));
    assert.equal(createHash('sha256').update(raw).digest('hex'), s.receipt.responseSha256);
    assert(t.store.intents(owner, job.id).every(i => i.effect === 'read' && i.state === 'effect_confirmed' && t.store.attempts(owner, i.id).length === 1));
    assert.throws(() => t.store.ontology.read('other-owner', ref));
    const originalNow = t.store.ontology.now; Object.defineProperty(t.store.ontology, 'now', { value: () => originalNow() + 300001 });
    assert.equal(t.store.ontology.evaluate(owner, { function: 'rideEstimateStatus', object: ref }).status, 'unknown');
  } finally { t.close(); }
});

test('DiDi advertises separate query endpoint roles and preserves exact message provenance', () => {
  const t = setupDidi(); try {
    const job = t.b.submit({ goal: '只查北京西站到西二旗地铁站的估价' }), request = job.delegation!.request;
    const roles = t.catalog.capability(DIDI_PROGRAM_REF).requirementRoles;
    assert.deepEqual(roles!.map(r => r.role), ['origin', 'destination']);
    const extracted = (['origin', 'destination'] as const).map(role => ({ requirement: { id: role, kind: 'location', role, strength: 'hard', expected: { ref: input[role] } }, messageId: request.messages[0]!.id, quote: input[role] }));
    const grounded = groundRequirements(request, JSON.stringify(extracted), [], roles);
    assert.equal(grounded.requirements.length, 2);
    assert.throws(() => groundRequirements(request, JSON.stringify(extracted.map(r => ({ ...r, messageId: r.messageId + '-wrong' }))), [], roles), /provenance/);
    assert.equal(t.calls.length, 0);
  } finally { t.close(); }
});

test('Both hard query endpoints pass only from matched source names, addresses or explicit city prefixes', async () => {
  const t = setupDidi(chooseDidi, { ...input, city: '北京' }); try {
    const job = t.b.submit({ goal: '只查北京市北京西站到西二旗地铁站的估价', requirements: [
      { id: 'from', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: '北京市北京西站' } },
      { id: 'to', kind: 'location', role: 'destination', strength: 'hard', expected: { ref: '西二旗地铁站地点2号' } },
    ] });
    const done = await t.finish(job.id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert(done.delegation!.acceptance!.checks.filter(c => ['from', 'to'].includes(c.requirementId)).every(c => c.result === 'pass'));
    assert.equal(done.delegation!.acceptance!.checks.filter(c => ['from', 'to'].includes(c.requirementId)).length, 2);
    for (const type of ['RideTrip', 'Order', 'Payment']) assert.equal(t.store.ontology.query(owner, { type }).items.length, 0);
  } finally { t.close(); }
});

test('An endpoint requested by the user cannot be fabricated from task input when the source differs', async () => {
  const t = setupDidi(); try {
    const job = t.b.submit({ goal: '起点必须是北京东站，只查价', requirements: [{ id: 'from', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: '北京东站' } }] });
    const done = await t.finish(job.id);
    assert.notEqual(done.state, 'completed'); assert(!done.delegation!.acceptance?.accepted); assert(!done.artifact);
    assert(t.calls.filter(c => c.method === 'tools/call').every(c => ['maps_textsearch', 'taxi_estimate'].includes(c.name!)));
  } finally { t.close(); }
});

test('Ambiguous exact names cannot silently select the first match or send an estimate', async () => {
  const t = setupDidi(); try {
    t.flags.ambiguous = true; const job = t.b.submit({ goal: '只查地点不猜上车点' }); await t.b.run(); await t.b.run(); await t.b.run();
    const current = t.store.get(owner, job.id); assert(current.delegation!.agent!.feedback.some(f => f.message.includes('Ambiguous place')));
    assert(!t.calls.some(c => c.name === 'taxi_estimate'));
  } finally { t.close(); }
});

test('A same-name place returned in another city cannot replace the requested route', async () => {
  const t = setupDidi(); try {
    t.flags.transform = (body, request) => {
      if (request.method === 'tools/call' && request.params.name === 'maps_textsearch') {
        const places = JSON.parse(body.result.content[0].text); for (const place of places) place.city = '上海市'; body.result.content[0].text = JSON.stringify(places);
      }
      return body;
    };
    const job = t.b.submit(); await t.b.run(); await t.b.run(); await t.b.run();
    assert(!t.calls.some(c => c.name === 'taxi_estimate'));
    assert(t.store.get(owner, job.id).delegation!.agent!.feedback.some(f => f.kind === 'validation'));
  } finally { t.close(); }
});

test('A source observation from another task of the same owner cannot supply route coordinates', async () => {
  let firstRequest: string | undefined, foreign: { type: string; id: string } | undefined;
  const t = setupDidi((ctx, access) => {
    firstRequest ??= ctx.request.id;
    const result = chooseDidi(ctx, access);
    if (ctx.request.id === firstRequest) { foreign ??= ctx.state.observations.find(r => r.type === 'DidiPlaceObservation'); return result; }
    if (foreign && result.steps.some(s => s.action === 'EstimateDidiRide')) {
      access.session.call('query_ontology', { object: foreign });
      const selected = result.steps[0]!, args = JSON.parse(selected.argumentsJson); args.originObservation = foreign;
      return { ...result, steps: [{ ...selected, argumentsJson: JSON.stringify(args) }] };
    }
    return result;
  });
  try {
    const first = t.b.submit(); assert.equal((await t.finish(first.id)).state, 'completed'); assert(foreign);
    const calls = t.calls.filter(c => c.name === 'taxi_estimate').length;
    const second = t.b.submit(); await t.b.run(); await t.b.run(); await t.b.run();
    assert.equal(t.calls.filter(c => c.name === 'taxi_estimate').length, calls);
    assert(t.store.get(owner, second.id).delegation!.agent!.feedback.some(f => f.kind === 'validation'));
  } finally { t.close(); }
});

test('Place-only empty searches complete with a bounded no-result and no estimate', async () => {
  const t = setupDidi((ctx, access) => {
    const observations = observeDidi(ctx, access);
    return { kind: observations.length ? 'complete' : 'execute', requestRevision: ctx.request.revision, message: 'Read only this search', steps: observations.length ? [] : [{ id: 'search', action: 'SearchDidiPlaces', argumentsJson: JSON.stringify({ scope: ctx.state.scope, role: 'search', keywords: '不存在的公共地点' }), dependsOn: [], inputRefs: [] }], completionJson: observations.length ? JSON.stringify({ observation: observations[0]!.ref, rationale: 'The bounded source search returned no places' }) : '' };
  }, { mode: 'places', city: '北京市', keywords: '不存在的公共地点' });
  try { t.flags.empty = true; const job = t.b.submit(); const done = await t.finish(job.id); assert.equal(done.state, 'completed'); assert.match(done.artifact!.data.deliverable, /未返回结果/); assert.equal(t.calls.filter(c => c.method === 'tools/call').length, 1); }
  finally { t.close(); }
});

test('A selected class absent from the source is reported without substituting another class', async () => {
  const t = setupDidi(chooseDidi, { ...input, serviceClass: '豪华车' }); try {
    const job = t.b.submit(); const done = await t.finish(job.id); assert.equal(done.state, 'completed'); assert.match(done.artifact!.data.deliverable, /未返回符合指定车型/); assert(!done.artifact!.data.deliverable.includes('快车：'));
  } finally { t.close(); }
});

test('Canceling while a source read is in flight preserves audit without projecting late results', async () => {
  const t = setupDidi(); try {
    const job = t.b.submit(); await t.b.run();
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>(r => { started = r; }), hold = new Promise<void>(r => { release = r; });
    t.flags.before = async name => { if (name === 'maps_textsearch') { started(); await hold; } };
    const pending = t.b.run(); await ready; t.b.tasks.cancel(principal, job.id); release(); await pending;
    assert.equal(t.store.get(owner, job.id).state, 'canceled');
    assert.equal(t.store.ontology.query(owner, { type: 'DidiPlaceObservation' }).items.length, 0);
    assert(!t.calls.some(c => c.name === 'taxi_estimate'));
  } finally { t.close(); }
});
