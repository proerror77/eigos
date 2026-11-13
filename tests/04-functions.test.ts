import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal, route } from './fixture.js';

test('source Function follows its schema, source permission and revocation', async () => {
  const f = await fixture();
  try {
    const context = { principal, objects: new Objects(f.db, f.model, principal.owner), signal: AbortSignal.timeout(5000) };
    const result = await f.workflow.functions.invoke(f.model, 'searchPlaces', { city: route.city, keywords: route.origin }, context) as { data: { kind: string } };
    assert.equal(result.data.kind, 'places');
    await assert.rejects(f.workflow.functions.invoke(f.model, 'searchPlaces', { city: route.city, keywords: route.origin }, { ...context, principal: { ...principal, scopes: ['ontology:read'] } }), /Permission/);
    f.provider.flags.active = false;
    await assert.rejects(f.workflow.functions.invoke(f.model, 'searchPlaces', { city: route.city, keywords: route.origin }, context), /revoked/);
    assert.equal(f.provider.calls.length, 1);
  } finally { await f.close(); }
});
