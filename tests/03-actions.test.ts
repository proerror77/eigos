import { Access, setGrants, memberGrants } from '../packages/runtime/access.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal, route } from './fixture.js';
import { Ontology } from '../packages/ontology/model.js';
import { Functions } from '../packages/runtime/functions.js';
import { Actions } from '../packages/runtime/actions.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { ExternalOperations } from '../packages/runtime/external-operations.js';

test('edit Functions require an Action and source permissions are checked before provider access', async () => {
  const f = await fixture();
  try {
    const objects = new Objects(f.db, f.model, f.access), context = { principal, objects, signal: AbortSignal.timeout(5000) };
    await assert.rejects(f.capabilities.functions.invoke(f.model, 'prepareRideInquiry', route, context), /through an Action/);
    await setGrants(f.db, principal.owner, memberGrants(f.model).filter(grant => grant.permission !== 'read_source'));
    const caller = await Access.load(f.db, principal);
    await assert.rejects(f.capabilities.actions.apply(caller, f.model, 'EstimateRide', route, 'request'), /Permission/);
    assert.equal(f.provider.calls.length, 0);
    assert.equal((await objects.query({ type: 'RideRequest' })).items.length, 0);
    await assert.rejects(f.capabilities.actions.apply(await Access.load(f.db, { owner: 'ungranted', scopes: [] }), f.model, 'EstimateRide', route, 'request'), /Permission/);
  } finally { await f.close(); }
});

test('function-backed inquiry commits its graph once and rolls it all back when the claim check fails', async () => {
  const f = await fixture();
  try {
    const objects = new Objects(f.db, f.model, f.access);
    await assert.rejects(f.capabilities.actions.apply(f.access, f.model, 'EstimateRide', route, 'rollback-inquiry', async () => { throw Error('claim expired'); }), /claim expired/);
    for (const type of ['RideRequest', 'RideEstimatable', 'PriceEstimate']) assert.equal((await objects.query({ type })).items.length, 0);
    const first = await f.capabilities.actions.apply(f.access, f.model, 'EstimateRide', route, 'accepted-inquiry');
    const calls = f.provider.calls.length;
    assert.deepEqual(await f.capabilities.actions.apply(f.access, f.model, 'EstimateRide', route, 'accepted-inquiry'), first);
    assert.equal(f.provider.calls.length, calls);
    assert.equal((await objects.query({ type: 'RideRequest' })).items.length, 1);
    assert.equal((await objects.query({ type: 'PriceEstimate' })).items.length, 2);
  } finally { await f.close(); }
});

test('an invalid edit Function return cannot commit its staged writes', async () => {
  const f = await fixture();
  try {
    const parameters = { type: 'object', properties: {}, additionalProperties: false };
    const definition = new Ontology({ id: 'Eigos', version: 'broken-edit', objectTypes: [{apiName:'Route',displayName:'Route',description:'Route',primaryKey:'id',titleProperty:'name',interfaces:{},properties:{id:{description:'ID',schema:{type:'string'},required:true},name:{description:'Name',schema:{type:'string'},required:true}}}], interfaceTypes: [], linkTypes: [], dataSources: [],
      functionTypes: [{ apiName: 'BrokenEdit', description: 'Invalid return regression', edits: true, parameters, returns: { type: 'string' } }],
      actionTypes: [{ apiName: 'BrokenAction', description: 'Invalid return regression', parameters, objectParameters: {}, submissionCriteria: [], function: 'BrokenEdit' }],
    });
    const ref = { type: 'Route', id: 'must-not-exist' };
    const functions = new Functions(new Map([['BrokenEdit', (_input, context) => context.edit!(ref, async objects => { await objects.create(ref, { id: ref.id, name: 'invalid edit' }); })]]), definition.document.functionTypes);
    const model = await f.metadata.publish(definition.document, { describe: m => ({ functions: functions.bindings(m), sources: {} }) }, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model)); await f.access.refresh();
    await assert.rejects(new Actions(f.db, functions).apply(f.access, model, 'BrokenAction', {}, 'invalid-return'));
    await assert.rejects(new Objects(f.db, model, f.access).read(ref));
  } finally { await f.close(); }
});

test('function Actions check admission before preparation and dispatch intents only after a committed receipt', async () => {
  const f = await fixture();
  try {
    const input = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };
    const reference = { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false };
    const criterion = {
      apiName: 'AllowNotice', description: 'Test the current notice permission', version: '1',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, returns: { type: 'boolean' }, dependencies: {},
    };
    const edit = {
      apiName: 'PrepareNotice', description: 'Stage a route and its notice intent', version: '1',
      parameters: input, returns: reference, edits: true, dependencies: { objectTypes: ['Route'] },
    };
    const document = structuredClone(f.model.document);
    document.functionTypes.push(criterion, edit);
    document.actionTypes.push({
      apiName: 'CommitNotice', description: 'Commit a guarded notice', parameters: input, objectParameters: {},
      submissionCriteria: [{ function: criterion.apiName, arguments: {} }], function: edit.apiName,
    });
    let allowed = false, preparations = 0;
    const sent: string[] = [];
    const capabilities = createCapabilities(f.db, f.source, {
      effects: new Map([['Notify', async (payload) => { sent.push(String(payload.id)); }]]),
      functions: [
        { definition: criterion, implementationId: 'allow-notice-v1', handler: async () => allowed },
        { definition: edit, implementationId: 'prepare-notice-v1', handler: async (args, context) => {
          preparations++;
          const ref = { type: 'Route', id: String(args.id) };
          if (ref.id === 'revoked-before-provider') {
            // Simulate a condition changing while the Action's preparation was in flight.
            allowed = false;
            await new ExternalOperations(f.db).run(context.principal.owner, ref.id, { ref }, context.assertDispatch!, async () => {
              sent.push('unexpected synchronous send');
              return { accepted: true };
            });
          }
          context.deferEffect!({ name: 'Notice', handler: 'Notify', payload: { id: ref.id } });
          return context.edit!(ref, graph => graph.create(ref, { id: ref.id, name: 'Proposed route' }));
        } },
      ],
    });
    const model = await f.metadata.publish(document, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model));
    const access = await Access.load(f.db, principal), graph = new Objects(f.db, model, access);
    const apply = (id: string, beforeCommit?: Parameters<Actions['apply']>[5]) =>
      capabilities.actions.apply(access, model, 'CommitNotice', { id }, id, beforeCommit);

    await assert.rejects(apply('denied'), /submission criteria/);
    assert.equal(preparations, 0);
    assert.equal(await capabilities.effects.runOne(), false);
    allowed = true;
    await assert.rejects(apply('revoked-before-provider'), /submission criteria/);
    assert.equal(await new ExternalOperations(f.db).inspect(principal.owner, 'revoked-before-provider'), null);
    assert.deepEqual(sent, []);
    allowed = true;
    let fences = 0;
    await assert.rejects(apply('rolled-back-notice', async () => {
      if (++fences === 2) throw new Error('Final claim expired');
    }), /Final claim expired/);
    await assert.rejects(graph.read({ type: 'Route', id: 'rolled-back-notice' }), /unavailable/);
    assert.equal((await capabilities.effects.status(access, 'rolled-back-notice')).length, 0);
    assert.equal(await capabilities.effects.runOne(), false);
    assert.deepEqual(sent, []);

    await apply('committed-notice');
    await apply('committed-notice');
    const evidence = await f.db.query(`SELECT effect.state FROM ${f.db.schema}.action_effects effect
      JOIN ${f.db.schema}.actions committed USING(owner,request_id) WHERE effect.request_id='committed-notice'`);
    assert.deepEqual(evidence.rows, [{ state: 'pending' }]);
    assert.deepEqual(sent, []);
    assert.equal(await capabilities.effects.runOne(), true);
    assert.equal(await capabilities.effects.runOne(), false);
    assert.deepEqual(sent, ['committed-notice']);
    assert.equal(preparations, 3);
  } finally { await f.close(); }
});

test('generic action rules commit once, detect changed retries and roll back a failed submission', async () => {
  const f = await fixture();
  try {
    const document = structuredClone(f.model.document);
    const action = { apiName: 'CreateRoute', description: 'Create an explicitly named route',
      parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false },
      objectParameters: {}, submissionCriteria: [], rules: [{ op: 'createObject', object: { type: 'Route', id: { parameter: 'id' } }, properties: { id: { parameter: 'id' }, name: { parameter: 'name' } } }], result: { type: 'Route', id: { parameter: 'id' } } };
    const model = await f.metadata.publish({ ...document, actionTypes: [...document.actionTypes, action] }, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model)); await f.access.refresh();
    const args = { id: 'new-route', name: 'Route created by a generic rule' };
    const [first, repeated] = await Promise.all([f.capabilities.actions.apply(f.access, model, 'CreateRoute', args, 'atomic'), f.capabilities.actions.apply(f.access, model, 'CreateRoute', args, 'atomic')]);
    assert.deepEqual(first, repeated);
    await assert.rejects(f.capabilities.actions.apply(f.access, model, 'CreateRoute', { ...args, name: 'changed' }, 'atomic'), /already used/);
    await assert.rejects(f.capabilities.actions.apply(f.access, model, 'CreateRoute', { ...args, id: 'rolled-back' }, 'abort', async () => { throw Error('cancel'); }));
    await assert.rejects(new Objects(f.db, model, f.access).read({ type: 'Route', id: 'rolled-back' }));
  } finally { await f.close(); }
});
