import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { digest } from '../packages/core/delegation.js';
import type { AgentActionContext, AgentProgramContext } from '../packages/core/agent-program.js';
import { owner, principal } from './backend-fixture.js';
import { setup, programContext } from './fixtures/paotui-agent.js';
import { paotuiBusinessRefs, paotuiSavedAddressRef, projectPaotuiAddresses } from '../packages/ontology/paotui-business-context.js';
import { PaotuiAddressSelection } from '../packages/capabilities/paotui-address-selection.js';
import { checkedPaotuiObservation } from '../packages/ontology/paotui-agent-projection.js';
import { paotuiAgentActions } from '../packages/ontology/paotui-agent.js';
import { sourceProof } from '../packages/ontology/object-evidence.js';
import type { ObjectRef } from '../packages/ontology/model.js';

const goal = '从家里寄到公司，一份文件，500克，普通送，只查询';
function contextFixture() {
  const f = setup(), job = f.b.submit({ goal });
  job.delegation!.request = f.program.prepareRequest(job.delegation!.request); f.store.save(owner, job);
  let ctx = programContext(f.store, owner, job.delegation!.request, f.program);
  const refs = paotuiBusinessRefs(owner, job.id), graph = f.store.ontology;
  const related = (ref: ObjectRef, link: string) => graph.related(owner, ref, link, { remaining: 1000 }) ?? [];
  const read = async (action = 'ReadSavedAddresses', input: Record<string, unknown> = { scope: ctx.state.scope }) => {
    const actionCtx: AgentActionContext = { ...ctx, planId: randomUUID(), intentId: randomUUID(), attemptId: randomUUID(), modelRunId: randomUUID() };
    const result = await f.program.invoke(actionCtx, action, input, new AbortController().signal);
    const ref = f.store.transaction(() => f.program.project(actionCtx, action, input, result));
    ctx.state.observations.push(ref); return ref;
  };
  const quote = async () => {
    const book = await read();
    const sender = await read('ReadSavedAddressDetail', { scope: ctx.state.scope, book, selector: '家里', role: 'sender' });
    const recipient = await read('ReadSavedAddressDetail', { scope: ctx.state.scope, book, selector: '公司', role: 'recipient' });
    const input = { scope: ctx.state.scope, parcel: refs.parcel, route: refs.route, sender, recipient };
    return { ref: await read('PreviewDeliveryQuote', input), input };
  };
  const amend = (answer: string) => {
    const changed = f.b.tasks.amend(principal, { taskId: job.id, expectedRevision: f.store.get(owner, job.id).revision!, requestId: randomUUID(), answer });
    changed.delegation!.request = f.program.prepareRequest(changed.delegation!.request); f.store.save(owner, changed);
    ctx = programContext(f.store, owner, changed.delegation!.request, f.program);
    return ctx;
  };
  return { ...f, job, refs, graph, related, read, quote, amend, context: () => ctx };
}

test('current parcel, selected route, saved addresses and source identities precede quote and stay stable across repeated reads', async () => {
  const f = contextFixture();
  try {
    assert.deepEqual(f.graph.read(owner, f.refs.parcel).properties.declaredWeight, { amount: '0.5', unit: 'kg' });
    assert.equal(f.graph.read(owner, f.refs.parcel).properties.declaredContents, '一份文件');
    assert.equal(f.graph.query(owner, { type: 'DeliveryQuote' }).items.length, 0);
    assert.equal(f.graph.query(owner, { type: 'SavedAddress' }).items.length, 0);
    const parcel = f.graph.read(owner, f.refs.parcel);
    const book = await f.read(), route = f.graph.read(owner, f.refs.route), addresses = f.graph.query(owner, { type: 'SavedAddress' }).items;
    assert.equal(f.calls.filter(c => c.operation === 'delivery_preview').length, 0);
    assert.equal(addresses.length, 2);
    assert.deepEqual(f.related({ type: 'ServiceRequest', id: f.job.id }, 'selectedRoute').map(r => r.ref), [f.refs.route]);
    assert.equal(f.related(f.refs.route, 'originAddress').length, 1); assert.equal(f.related(f.refs.route, 'destinationAddress').length, 1);
    assert.equal(f.related(book, 'addresses').length, 2);
    assert(!('originSnapshot' in route.properties)); assert(!('destinationSnapshot' in route.properties));
    for (const a of addresses) {
      assert(!('address' in a.properties)); assert(!('sourceReference' in a.properties));
      assert.throws(() => f.graph.query(owner, { object: a.ref, select: ['sourceReference'] }), /Restricted/);
      assert.throws(() => f.graph.read('someone-else', a.ref));
    }
    await f.read();
    assert.deepEqual(f.graph.read(owner, f.refs.parcel), parcel);
    assert.deepEqual(f.graph.read(owner, f.refs.route), route);
    assert.deepEqual(f.graph.query(owner, { type: 'SavedAddress' }).items, addresses);
    const q = await f.quote(), snapshot = checkedPaotuiObservation(f.graph.readPrivate(owner, q.ref).properties.privateSnapshot);
    assert(snapshot.inputState);
    const typed = f.related(q.ref, 'quote')[0]!;
    assert.equal(typed.properties.parcelRevision, parcel.revision); assert.equal(typed.properties.routeRevision, route.revision);
    assert.deepEqual(f.related(typed.ref, 'parcel').map(r => r.ref), [f.refs.parcel]);
    assert.deepEqual(f.related(typed.ref, 'route').map(r => r.ref), [f.refs.route]);
    assert.equal(f.graph.query(owner, { type: 'Provider' }).items.length, 1); assert.equal(f.graph.query(owner, { type: 'Channel' }).items.length, 1);
    assert.equal(f.graph.evaluate(owner, { function: 'deliveryQuoteMatches', object: typed.ref, request: { type: 'ServiceRequest', id: f.job.id }, serviceLevel: 'ordinary' }).value, 'pass');
    assert.deepEqual(paotuiAgentActions.find(a => a.id === 'PreviewDeliveryQuote')!.inputs, { scope: 'PaotuiTask', parcel: 'Parcel', route: 'DeliveryRoute', sender: 'PaotuiObservation', recipient: 'PaotuiObservation' });
    const safe = JSON.stringify([f.context().state, ...Object.values(f.refs).map(ref => f.graph.read(owner, ref)), addresses]);
    assert(!safe.includes('PRIVATE_')); assert(!safe.includes('13800000000')); assert(!safe.includes('"addressId"'));
  } finally { f.store.close(); }
});

test('weight correction updates the same parcel, retains route and service, invalidates prior quote without rewriting its receipt', async () => {
  const f = contextFixture();
  try {
    const original = await f.quote(), snapshot = f.graph.readPrivate(owner, original.ref), quote = f.related(original.ref, 'quote')[0]!;
    const parcel = f.graph.read(owner, f.refs.parcel), route = f.graph.read(owner, f.refs.route), addresses = f.graph.query(owner, { type: 'SavedAddress' }).items;
    const beforeService = f.context().request.confirmedInputs!.paotui!.fields.service;
    f.amend('重量改为1公斤，原先500克作废');
    assert.equal(f.graph.read(owner, f.refs.parcel).revision, parcel.revision + 1);
    assert.deepEqual(f.graph.read(owner, f.refs.parcel).properties.declaredWeight, { amount: '1', unit: 'kg' });
    assert.deepEqual(f.graph.read(owner, f.refs.route), route); assert.deepEqual(f.graph.query(owner, { type: 'SavedAddress' }).items, addresses);
    assert.deepEqual(f.context().request.confirmedInputs!.paotui!.fields.service, beforeService);
    assert.notEqual(f.graph.evaluate(owner, { function: 'paotuiObservationStatus', object: original.ref }).status, 'known');
    assert.notEqual(f.graph.evaluate(owner, { function: 'deliveryQuoteMatches', object: quote.ref, request: { type: 'ServiceRequest', id: f.job.id }, serviceLevel: 'ordinary' }).value, 'pass');
    assert.deepEqual(f.graph.readPrivate(owner, original.ref), snapshot);
    assert(sourceProof(f.graph, owner, original.ref, { remaining: 1000 }));
    assert(sourceProof(f.graph, owner, quote.ref, { remaining: 1000 }));
    await f.quote();
    assert.deepEqual(f.calls.filter(c => c.operation === 'delivery_preview').map(c => c.input.weightKg), [0.5, 1]);
    assert.equal(f.graph.query(owner, { type: 'Parcel' }).items.length, 1); assert.equal(f.graph.query(owner, { type: 'DeliveryRoute' }).items.length, 1);
  } finally { f.store.close(); }
});

test('withdrawn recipient clears only that route role and changed private address data advances versions before another quote', async () => {
  const f = contextFixture();
  try {
    const original = await f.quote(), parcel = f.graph.read(owner, f.refs.parcel), sender = f.related(f.refs.route, 'originAddress')[0]!, route = f.graph.read(owner, f.refs.route);
    f.amend('收件地址取消，暂时待定');
    assert.deepEqual(f.related(f.refs.route, 'originAddress').map(a => a.ref), [sender.ref]);
    assert.equal(f.related(f.refs.route, 'destinationAddress').length, 0);
    assert.equal(f.related({ type: 'ServiceRequest', id: f.job.id }, 'selectedRoute').length, 0);
    assert(f.graph.read(owner, f.refs.route).revision > route.revision); assert.deepEqual(f.graph.read(owner, f.refs.parcel), parcel);
    f.amend('收件仍用公司');
    await f.read();
    assert.equal(f.related({ type: 'ServiceRequest', id: f.job.id }, 'selectedRoute').length, 1);
    f.flags.changedBook = true; await f.read();
    assert.equal(f.graph.read(owner, sender.ref).revision, sender.revision + 1, 'Private content changes still version the stable address');
    assert.equal(f.related(f.refs.route, 'originAddress').length, 0);
    assert.equal(f.related(f.refs.route, 'destinationAddress').length, 1);
    assert.equal(f.related({ type: 'ServiceRequest', id: f.job.id }, 'selectedRoute').length, 0);
    assert.equal(f.graph.evaluate(owner, { function: 'paotuiObservationStatus', object: original.ref }).status, 'unknown');
    const question = f.program.clarify(f.context(), '请选择地址');
    assert(question.startsWith('请选择寄件地址。另一个已确认地址及其他信息保留。'));
  } finally { f.store.close(); }
});

test('account change creates a distinct owned address namespace and requires renewed selection', async () => {
  const f = contextFixture();
  try {
    f.flags.accountIdentity = 'a'.repeat(64); await f.read();
    const old = f.related(f.refs.route, 'originAddress')[0]!.ref;
    f.flags.accountIdentity = 'b'.repeat(64); const fresh = await f.read();
    assert.equal(f.related({ type: 'ServiceRequest', id: f.job.id }, 'selectedRoute').length, 0);
    assert(!f.related(fresh, 'addresses').some(a => a.ref.id === old.id));
    const count = f.calls.length;
    await assert.rejects(f.read('ReadSavedAddressDetail', { scope: f.context().state.scope, book: fresh, selector: '家里', role: 'sender' }), /choice/);
    assert.equal(f.calls.length, count);
    f.amend('寄件仍用家里，收件仍用公司'); await f.read();
    assert.equal(f.related({ type: 'ServiceRequest', id: f.job.id }, 'selectedRoute').length, 1);
    assert.notEqual(f.related(f.refs.route, 'originAddress')[0]!.ref.id, old.id);
  } finally { f.store.close(); }
});

test('verified account identity keeps saved addresses stable across tasks and tokens while authorization choices remain separate', () => {
  const f = setup();
  try {
    const choices = new PaotuiAddressSelection(f.store), first = f.b.submit({ goal }).delegation!.request, second = f.b.submit({ goal }).delegation!.request;
    const addresses = [{ addressId: 'a', address: 'PRIVATE_ORIGIN', tag: '家里', cityId: '1', lat: 1, lng: 1 }, { addressId: 'b', address: 'PRIVATE_DESTINATION', tag: '公司', cityId: '1', lat: 2, lng: 2 }];
    choices.observe(owner, first, 'token-a', addresses, { authorizationEpoch: 'epoch-a', accountIdentity: 'a'.repeat(64) });
    const original = choices.current(owner, first, 'token-a', addresses);
    choices.observe(owner, first, 'token-b', addresses, { authorizationEpoch: 'epoch-a', accountIdentity: 'a'.repeat(64) });
    choices.observe(owner, second, 'token-b', addresses, { authorizationEpoch: 'epoch-b', accountIdentity: 'a'.repeat(64) });
    const refreshed = choices.current(owner, first, 'token-b', addresses), anotherTask = choices.current(owner, second, 'token-b', addresses);
    assert.equal(original.namespace, refreshed.namespace); assert.equal(original.namespace, anotherTask.namespace);
    const source = { kind: 'synthetic' as const, id: 'fixture-account-observation', observedAt: new Date().toISOString() };
    const originals = projectPaotuiAddresses(f.store.ontology, owner, original.namespace, addresses, source);
    assert.deepEqual(projectPaotuiAddresses(f.store.ontology, owner, anotherTask.namespace, addresses, source), originals);
    assert.equal(f.store.ontology.query(owner, { type: 'SavedAddress' }).items.length, 2);
    choices.observe(owner, first, 'token-c', addresses, { authorizationEpoch: 'new-epoch', accountIdentity: 'a'.repeat(64) });
    const revokedThenRenewed = choices.current(owner, first, 'token-c', addresses);
    assert.equal(revokedThenRenewed.namespace, original.namespace);
    assert.deepEqual(revokedThenRenewed.roles, {}, 'Entity continuity never renews old selection authority');
    choices.observe(owner, second, 'token-other-account', addresses, { authorizationEpoch: 'epoch-other', accountIdentity: 'b'.repeat(64) });
    const otherAccount = choices.current(owner, second, 'token-other-account', addresses);
    assert.notEqual(otherAccount.namespace, original.namespace);
    assert.notDeepEqual(projectPaotuiAddresses(f.store.ontology, owner, otherAccount.namespace, addresses, source), originals);
    assert.notDeepEqual(paotuiSavedAddressRef('another-owner', original.namespace, 'a'), originals[0]);
    const provisional = f.b.submit({ goal }).delegation!.request;
    choices.observe(owner, provisional, 'unverified-token', addresses);
    assert.notEqual(choices.current(owner, provisional, 'unverified-token', addresses).namespace, original.namespace);
  } finally { f.store.close(); }
});

test('foreign refs, swapped detail roles and restated facts fail before preview; an in-flight input change drops the late response', async () => {
  const f = contextFixture();
  try {
    const ready = await f.quote(), before = f.calls.length;
    for (const input of [
      { ...ready.input, parcel: { type: 'Parcel', id: 'another-task' } },
      { ...ready.input, route: { type: 'DeliveryRoute', id: 'another-task' } },
      { ...ready.input, sender: ready.input.recipient, recipient: ready.input.sender },
      { ...ready.input, weightKg: 99 },
    ]) await assert.rejects(f.read('PreviewDeliveryQuote', input));
    assert.equal(f.calls.length, before);
    const observationCount = f.graph.query(owner, { type: 'PaotuiObservation' }).items.length;
    f.flags.before = async operation => {
      if (operation !== 'delivery_preview') return;
      const parcel = f.graph.read(owner, f.refs.parcel);
      f.graph.ingest(owner, { objects: [{ ref: parcel.ref, expectedRevision: parcel.revision, properties: { ...parcel.properties, declaredWeight: { amount: '2', unit: 'kg' } } }] }, parcel.source);
    };
    await assert.rejects(f.read('PreviewDeliveryQuote', ready.input), /superseded|changed/);
    assert.equal(f.graph.query(owner, { type: 'PaotuiObservation' }).items.length, observationCount);
    assert.equal(f.graph.query(owner, { type: 'DeliveryQuote' }).items.length, 1);
  } finally { f.store.close(); }
});

test('known contents missing from grounding require model repair before any business objects or source reads', () => {
  const f = setup();
  try {
    const job = f.b.submit({ goal }), request = f.program.prepareRequest(job.delegation!.request);
    f.store.save(owner, { ...job, delegation: { ...job.delegation!, request } });
    assert.throws(() => f.program.initialize(f.store.ontology, owner, request, {}), /repair this interpretation without asking the owner again/);
    assert.throws(() => f.program.initialize(f.store.ontology, owner, request, { goodsName: 'a rewritten document' }), /exact current parcel contents phrase/);
    assert.equal(f.calls.length, 0); assert.equal(f.store.ontology.query(owner, { type: 'Parcel' }).items.length, 0);
    assert.equal(f.store.ontology.query(owner, { type: 'PaotuiTask' }).items.length, 0);
  } finally { f.store.close(); }
});

test('historical scalar-input observations still decode without being reinterpreted as current object inputs', async () => {
  const f = contextFixture();
  try {
    const q = await f.quote(), current = checkedPaotuiObservation(f.graph.readPrivate(owner, q.ref).properties.privateSnapshot);
    const { inputState, contentDigest: _digest, ...body } = current;
    assert(inputState);
    body.actionInput = { scope: current.scope, sender: q.input.sender, recipient: q.input.recipient, ...inputState.facts };
    const legacy = checkedPaotuiObservation({ ...body, contentDigest: digest(body) });
    assert.equal(legacy.inputState, undefined); assert.equal(legacy.summary.weightKg, 0.5);
    assert.throws(() => f.program.validate(f.context() as AgentProgramContext, 'PreviewDeliveryQuote', legacy.actionInput));
  } finally { f.store.close(); }
});
