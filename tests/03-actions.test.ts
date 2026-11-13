import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';
import { Ontology } from '../packages/ontology/model.js';

test('Action submission criteria reject an incomplete route and roll back all edits', async () => {
  const f = await fixture();
  try {
    const objects = new Objects(f.db, f.model, principal.owner), route = { type: 'Route', id: 'incomplete' };
    await objects.create(route, { id: route.id, name: 'incomplete route' });
    const action = f.model.resolveAction(route, 'RideEstimatable', 'requestEstimate', { requestId: 'request', route, requestedAt: new Date().toISOString() });
    await assert.rejects(f.workflow.actions.apply(principal, f.model, action.action, action.input, 'request'));
    assert.equal((await objects.query({ type: 'RideRequest' })).items.length, 0);
    await assert.rejects(f.workflow.actions.apply({ ...principal, scopes: [] }, f.model, action.action, action.input, 'request'), /Permission/);
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
    const [first, repeated] = await Promise.all([f.workflow.actions.apply(principal, model, 'CreateRoute', args, 'atomic'), f.workflow.actions.apply(principal, model, 'CreateRoute', args, 'atomic')]);
    assert.deepEqual(first, repeated);
    await assert.rejects(f.workflow.actions.apply(principal, model, 'CreateRoute', { ...args, name: 'changed' }, 'atomic'), /already used/);
    await assert.rejects(f.workflow.actions.apply(principal, model, 'CreateRoute', { ...args, id: 'rolled-back' }, 'abort', async () => { throw Error('cancel'); }));
    await assert.rejects(new Objects(f.db, model, principal.owner).read({ type: 'Route', id: 'rolled-back' }));
  } finally { await f.close(); }
});
