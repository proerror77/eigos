import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal, route } from './fixture.js';
import { Ontology } from '../packages/ontology/model.js';
import { Functions } from '../packages/runtime/functions.js';
import { Actions } from '../packages/runtime/actions.js';

test('edit Functions require an Action and source permissions are checked before provider access', async () => {
  const f = await fixture();
  try {
    const objects = new Objects(f.db, f.model, principal.owner), context = { principal, objects, signal: AbortSignal.timeout(5000) };
    await assert.rejects(f.capabilities.functions.invoke(f.model, 'prepareRideInquiry', route, context), /through an Action/);
    const caller = { ...principal, scopes: ['ontology:read', 'ontology:write'] };
    await assert.rejects(f.capabilities.actions.apply(caller, f.model, 'EstimateRide', route, 'request'), /Permission/);
    assert.equal(f.provider.calls.length, 0);
    assert.equal((await objects.query({ type: 'RideRequest' })).items.length, 0);
    await assert.rejects(f.capabilities.actions.apply({ ...principal, scopes: [] }, f.model, 'EstimateRide', route, 'request'), /Permission/);
  } finally { await f.close(); }
});

test('function-backed inquiry commits its graph once and rolls it all back when the claim check fails', async () => {
  const f = await fixture();
  try {
    const objects = new Objects(f.db, f.model, principal.owner);
    await assert.rejects(f.capabilities.actions.apply(principal, f.model, 'EstimateRide', route, 'rollback-inquiry', async () => { throw Error('claim expired'); }), /claim expired/);
    for (const type of ['RideRequest', 'RideEstimatable', 'PriceEstimate']) assert.equal((await objects.query({ type })).items.length, 0);
    const first = await f.capabilities.actions.apply(principal, f.model, 'EstimateRide', route, 'accepted-inquiry');
    const calls = f.provider.calls.length;
    assert.deepEqual(await f.capabilities.actions.apply(principal, f.model, 'EstimateRide', route, 'accepted-inquiry'), first);
    assert.equal(f.provider.calls.length, calls);
    assert.equal((await objects.query({ type: 'RideRequest' })).items.length, 1);
    assert.equal((await objects.query({ type: 'PriceEstimate' })).items.length, 2);
  } finally { await f.close(); }
});

test('an invalid edit Function return cannot commit its staged writes', async () => {
  const f = await fixture();
  try {
    const parameters = { type: 'object', properties: {}, additionalProperties: false };
    const model = new Ontology({ ...f.model.document,
      functionTypes: [...f.model.document.functionTypes, { apiName: 'BrokenEdit', description: 'Invalid return regression', edits: true, parameters, returns: { type: 'string' } }],
      actionTypes: [...f.model.document.actionTypes, { apiName: 'BrokenAction', description: 'Invalid return regression', parameters, objectParameters: {}, submissionCriteria: [], function: 'BrokenEdit' }],
    });
    const ref = { type: 'Route', id: 'must-not-exist' };
    const functions = new Functions(new Map([['BrokenEdit', (_input, context) => context.edit!(ref, async objects => { await objects.create(ref, { id: ref.id, name: 'invalid edit' }); })]]));
    await assert.rejects(new Actions(f.db, functions).apply(principal, model, 'BrokenAction', {}, 'invalid-return'));
    await assert.rejects(new Objects(f.db, model, principal.owner).read(ref));
  } finally { await f.close(); }
});

test('generic action rules commit once, detect changed retries and roll back a failed submission', async () => {
  const f = await fixture();
  try {
    const document = structuredClone(f.model.document);
    const action = { apiName: 'CreateRoute', description: 'Create an explicitly named route',
      parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false },
      objectParameters: {}, submissionCriteria: [], rules: [{ op: 'createObject', object: { type: 'Route', id: { parameter: 'id' } }, properties: { id: { parameter: 'id' }, name: { parameter: 'name' } } }], result: { type: 'Route', id: { parameter: 'id' } } };
    const model = new Ontology({ ...document, actionTypes: [...document.actionTypes, action] });
    await f.metadata.publish(model.document);
    const args = { id: 'new-route', name: 'Route created by a generic rule' };
    const [first, repeated] = await Promise.all([f.capabilities.actions.apply(principal, model, 'CreateRoute', args, 'atomic'), f.capabilities.actions.apply(principal, model, 'CreateRoute', args, 'atomic')]);
    assert.deepEqual(first, repeated);
    await assert.rejects(f.capabilities.actions.apply(principal, model, 'CreateRoute', { ...args, name: 'changed' }, 'atomic'), /already used/);
    await assert.rejects(f.capabilities.actions.apply(principal, model, 'CreateRoute', { ...args, id: 'rolled-back' }, 'abort', async () => { throw Error('cancel'); }));
    await assert.rejects(new Objects(f.db, model, principal.owner).read({ type: 'Route', id: 'rolled-back' }));
  } finally { await f.close(); }
});
