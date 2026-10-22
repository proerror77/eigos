// Synthetic receipt source and deterministic decisions; no personal source is contacted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { GeoAgentProgram } from '../packages/capabilities/geo-agent.js';
import { PaotuiGeoDiscoverySource } from '../packages/capabilities/paotui-geo-discovery.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import { acknowledgeReads, backend, evidence, observeTaskContext, owner } from './backend-fixture.js';

function setup(outsideAllowlist = false) {
  const query = { city: '北京市', keyword: '天安门' }, calls: unknown[] = [];
  const business = { source: 'meituan', readOnly: true, places: [{ name: 'Synthetic public location', address: 'Synthetic square', poiId: 'fixture-place', city: query.city }] };
  const result = { ...business, ontologyReceipt: { id: randomUUID(), transport: 'mcp-stdio', server: 'eigos-ontology', capabilityRef: { id: 'geo.search', version: '1' }, ontologyRef: { id: 'locations-and-parcel-quotes', version: '1' }, tool: 'ontology_geo_search', evidenceKind: 'fixture', inputDigest: digest(query), resultDigest: digest(business), observedAt: new Date().toISOString(), sourceCalls: ['search_poi'], readOnly: true } };
  const source = new PaotuiGeoDiscoverySource({ query: async input => { calls.push(input); return result; } }, digest('fixture-public-query'), [query]);
  const program = new GeoAgentProgram(source.adapter, source.configurationDigest, 'sandbox'), store = new JobStore(':memory:');
  const catalog = new ExecutionCatalog([program.capability()], [], [], [], [program]);
  const model: Reasoner = {
    ground: async (request, _caps, _signal, access) => {
      observeTaskContext(access);
      const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Keep bounded source observation outcome', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([{ id: 'places', predicate: 'geo.locations_observed', phase: 'fact', description: 'Actual returned public query', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] }]) };
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
    plan: async () => { throw new Error('Public query composition must not use a fixed recipe'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      const pin = (access.session.call('discover_actions', { actionId: 'ReadPublicLocations' }) as ActionDiscoveryPage).items[0]!.bindings[0]!.pin;
      const base: AgentDecision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Use exact public query and current original source facts', steps: [], completionJson: '' };
      let decision: AgentDecision;
      const component = ctx.state.composition!.contexts[0];
      if (!component) decision = { ...base, kind: 'prepare', contexts: [{ id: 'geo', bindingDigest: pin.digest, inputJson: JSON.stringify({ ...query, ...(outsideAllowlist ? { keyword: 'unapproved' } : {}) }) }] };
      else {
        access.session.call('query_ontology', { object: component.scope });
        const result = ctx.state.observations.find(ref => ref.type === 'GeoObservation');
        if (result) { access.session.call('query_ontology', { object: result }); decision = { ...base, kind: 'complete', completionJson: JSON.stringify({ components: [{ contextId: 'geo', proposalJson: JSON.stringify({ result }) }], criteria: [{ id: 'places', contextIds: ['geo'] }], conditions: [] }) }; }
        else decision = { ...base, steps: [{ id: 'query', action: 'ReadPublicLocations', contextId: 'geo', bindingDigest: pin.digest, argumentsJson: JSON.stringify({ scope: component.scope }), dependsOn: [], inputRefs: [], contributesTo: ['places'] }] };
      }
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
  };
  const b = backend(catalog, model, store);
  const run = async () => { const id = b.submit({ goal: 'PRIVATE_GOAL; 查询已允许的公开地点，仅返回来源实际观察，不保证完整覆盖。', executionEnvironment: 'sandbox' }).id; for (let i = 0; i < 10 && ['working', 'submitted'].includes(store.get(owner, id).state); i++) await b.run(); return store.get(owner, id); };
  return { store, calls, run, query };
}

test('composed public query preserves the allowlisted scope and original typed locations without disclosing the goal', async () => {
  const t = setup();
  try {
    const done = await t.run(); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.deepEqual(t.calls, [{ action: 'search_address', ...t.query }]);
    const observation = t.store.ontology.query(owner, { type: 'GeoObservation' }).items[0]!.properties.snapshot as { completeCoverageKnown: boolean; locations: unknown[] };
    assert.equal(observation.completeCoverageKnown, false); assert.equal(observation.locations.length, 1);
    assert.equal(done.delegation!.plan, undefined); assert(!JSON.stringify(t.calls).includes('PRIVATE_GOAL'));
  } finally { t.store.close(); }
});

test('a model-selected public query cannot expand the trusted configured allowlist', async () => {
  const t = setup(true);
  try { const done = await t.run(); assert.equal(done.state, 'paused'); assert.equal(t.calls.length, 0); assert.equal(done.delegation!.acceptance, undefined); }
  finally { t.store.close(); }
});
