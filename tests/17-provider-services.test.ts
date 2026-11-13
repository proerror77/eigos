import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { serviceProvider } from './service-fixture.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import type { AgentDriver, AgentTool } from '../packages/runtime/agent.js';
import { digest } from '../packages/core/identity.js';

test('provider observations project typed Interfaces and keep partial pages, unknown inventory and provenance', async () => {
  const provider = serviceProvider(),
    f = await fixture(undefined, provider.resolve);
  try {
    const graph = new Objects(f.db, f.model, f.access);
    const eventPage = await f.capabilities.actions.apply(f.access, f.model, 'SearchLumaEvents', {}, 'events');
    const hotelPage = await f.capabilities.actions.apply(
      f.access,
      f.model,
      'SearchRollingGoHotels',
      { place: '上海', checkIn: new Date(Date.now() + 86400000).toISOString().slice(0, 10), nights: 1, adults: 1 },
      'hotels',
    );
    const productPage = await f.capabilities.actions.apply(
      f.access,
      f.model,
      'SearchShopifyProducts',
      { query: 'umbrella', country: 'CN' },
      'products',
    );
    assert.equal((await graph.query({ type: 'ServiceOffering' })).items.length, 3);
    assert.equal((await graph.query({ type: 'AttendableEvent' })).items.length, 1);
    assert.equal((await graph.query({ type: 'HotelOffer' })).items[0]!.properties.priceKind, 'reference');
    assert.equal((await graph.query({ type: 'ProductOffer' })).items[0]!.properties.available, null);
    assert.equal((await graph.query({ type: 'ProductOffer' })).items[0]!.properties.deliveryTime, 'unknown');
    assert.equal((await graph.read(hotelPage)).properties.complete, false);
    assert.equal((await graph.read(productPage)).properties.complete, false);
    const result = (await f.capabilities.functions.invoke(
      f.model,
      'readServiceSearch',
      { search: eventPage },
      { principal, objects: graph, signal: AbortSignal.timeout(5000) },
    )) as { items: unknown[]; evidence: string };
    assert.equal(result.items.length, 1);
    assert.equal(result.evidence, 'synthetic');
    provider.flags.stale = true;
    await assert.rejects(
      f.capabilities.actions.apply(f.access, f.model, 'SearchLumaEvents', {}, 'old-events'),
      /expired/,
    );
    assert.equal((await graph.query({ type: 'ServiceSearchResult' })).items.length, 3);
  } finally {
    await f.close();
  }
});

test('service permissions and revocation are checked before reads and source errors cannot become empty results', async () => {
  const provider = serviceProvider(),
    f = await fixture(undefined, provider.resolve);
  try {
    await setGrants(
      f.db,
      principal.owner,
      memberGrants(f.model).filter((g) => g.resource !== 'Eigos/source/Shopify'),
    );
    const access = await Access.load(f.db, principal);
    await assert.rejects(
      f.capabilities.actions.apply(access, f.model, 'SearchShopifyProducts', { query: 'x', country: 'US' }, 'denied'),
      /Permission/,
    );
    assert.equal(provider.flags.calls.length, 0);
    provider.flags.active = false;
    await assert.rejects(f.capabilities.actions.apply(access, f.model, 'SearchLumaEvents', {}, 'revoked'), /revoked/);
    assert.equal((await new Objects(f.db, f.model, access).query({ type: 'ServiceSearchResult' })).items.length, 0);
  } finally {
    await f.close();
  }
});

test('canonical service identity survives refresh and rejects old or conflicting source versions', async () => {
  const provider = serviceProvider(),
    f = await fixture(undefined, provider.resolve);
  try {
    const graph = new Objects(f.db, f.model, f.access),
      first = await f.capabilities.actions.apply(f.access, f.model, 'SearchLumaEvents', {}, 'first');
    const before = await graph.read((await graph.query({ type: 'AttendableEvent' })).items[0]!.ref);
    provider.flags.observedAt = String(before.properties.observedAt);
    provider.flags.start = new Date(Date.parse(provider.flags.start) + 600000).toISOString();
    await assert.rejects(
      f.capabilities.actions.apply(f.access, f.model, 'SearchLumaEvents', {}, 'conflicting'),
      /older or conflicting/,
    );
    assert.equal((await graph.read(before.ref)).revision, before.revision);
    provider.flags.observedAt = new Date(Date.parse(String(before.properties.observedAt)) + 1000).toISOString();
    const second = await f.capabilities.actions.apply(f.access, f.model, 'SearchLumaEvents', {}, 'newer');
    const current = (await graph.query({ type: 'AttendableEvent' })).items;
    assert.equal(current.length, 1);
    assert.deepEqual(current[0]!.ref, before.ref);
    assert.equal(current[0]!.properties.start, provider.flags.start);
    const context = { principal, objects: graph, signal: AbortSignal.timeout(5000) };
    await assert.rejects(
      f.capabilities.functions.invoke(f.model, 'readServiceSearch', { search: first }, context),
      /superseded/,
    );
    const result = (await f.capabilities.functions.invoke(
      f.model,
      'readServiceSearch',
      { search: second },
      context,
    )) as { items: unknown[] };
    assert.equal(result.items.length, 1);
    provider.flags.observedAt = String(before.properties.observedAt);
    await assert.rejects(
      f.capabilities.actions.apply(f.access, f.model, 'SearchLumaEvents', {}, 'older'),
      /older or conflicting/,
    );
  } finally {
    await f.close();
  }
});

class LumaPAAgent implements AgentDriver {
  readonly model = 'recorded-luma-pa-choice';
  async run(_prompt: string, tools: ReadonlyMap<string, AgentTool>) {
    await tools.get('complete_with_action')!.invoke({
      action: {
        interface: { type: 'EventSearch', implementation: 'LumaEventSearch', action: 'search' },
        input: { query: 'AI events', location: 'Shanghai' },
      },
      read: { function: 'readServiceSearch', resultParameter: 'search' },
    });
  }
}
test('Grok PA Luma reads resume the original task and retain PA-reported evidence', async () => {
  const f = await fixture(new LumaPAAgent());
  try {
    const task = await f.tasks.submit(principal, { requestId: 'pa-luma', message: 'Find Luma events through my PA' });
    await f.worker.runOne();
    const waiting = await f.tasks.get(principal, task.id),
      request = waiting.result as { requestId: string; capability: string };
    assert.equal(waiting.state, 'input-required');
    assert.equal(request.capability, 'luma.events.read');
    assert.equal(
      (await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.source_calls WHERE state='running'`)).rows[0]!.n,
      0,
    );
    await new PARequests(f.tasks).respond(principal, task.id, {
      requestId: request.requestId,
      response: {
        status: 'available',
        accountRef: 'synthetic-grok-luma-account',
        source: 'https://mcp.luma.com',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 240000).toISOString(),
        complete: false,
        cursor: 'next-page',
        items: [],
        proofDigest: digest('synthetic-PA-tool-response'),
      },
    });
    await f.worker.runOne();
    const complete = await f.tasks.get(principal, task.id);
    assert.equal(complete.state, 'completed', JSON.stringify(complete));
    const page = (await new Objects(f.db, f.model, f.access).query({ type: 'ServiceSearchResult' })).items[0]!;
    assert.equal(page.properties.evidence, 'pa_reported');
    assert.equal(page.properties.complete, false);
    assert.equal(page.properties.cursor, 'next-page');
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.pa_requests`)).rows[0]!.n, 1);
  } finally {
    await f.close();
  }
});
