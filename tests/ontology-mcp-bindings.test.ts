import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { didiReadDefinition } from '../packages/ontology/didi-read-definition.js';
import { loadMcpReadModule, mcpReadModuleRef, parseMcpReadModule, resolveOntologyMcpRead } from '../packages/ontology/mcp-read.js';
import { businessModel } from '../packages/ontology/business-model.js';
import { chooseDidi, setupDidi, input, observeDidi } from './fixtures/didi.js';
import { owner } from './backend-fixture.js';

test('A separately maintained ontology file changes MCP tool and parameter binding without interpreter changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-ontology-')), file = join(directory, 'module.json');
  try {
    const original = structuredClone(didiReadDefinition), changed = structuredClone(original);
    changed.version = '2';
    const action = changed.actions.find(a => a.id === 'SearchDidiPlaces')!;
    action.mcp.tool = 'another_authorized_search';
    action.mcp.arguments.city = { from: 'scope', path: ['providerCityCode'] };
    writeFileSync(file, JSON.stringify(changed));
    const loaded = loadMcpReadModule(file), binding = loaded.actions.find(a => a.id === action.id)!.mcp;
    assert(Object.isFrozen(binding.arguments));
    const call = resolveOntologyMcpRead(binding, { keywords: '站点', role: 'origin' }, { origin: '站点', city: '北京市', providerCityCode: '010' }, () => assert.fail('Search has no declared dependency'));
    assert.equal(call.tool, 'another_authorized_search');
    assert.deepEqual(call.args, { keywords: '站点', city: '010' });
    assert.notEqual(mcpReadModuleRef(loaded).digest, mcpReadModuleRef(original).digest);
    assert.equal(loaded.version, '2');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('The interpreter resolves declared dependency names and argument paths, without scheduling source actions', () => {
  const module = structuredClone(didiReadDefinition), binding = module.actions.find(a => a.id === 'EstimateDidiRide')!.mcp;
  binding.requires[0]!.name = 'departure';
  binding.requires[0]!.observationInput = 'chosenDeparture';
  for (const source of Object.values(binding.arguments)) if (source.from === 'selection' && source.name === 'origin') source.name = 'departure';
  binding.route!.origin = 'departure';
  const calls: string[] = [];
  const checked = parseMcpReadModule(module).actions.find(a => a.id === 'EstimateDidiRide')!.mcp;
  const call = resolveOntologyMcpRead(checked, {}, {}, dep => {
    calls.push(dep.observationInput);
    return dep.name === 'departure' ? { name: '站点甲', lng: 120.1, lat: 31.2 } : { name: '站点乙', lng: 120.3, lat: 31.4 };
  });
  assert.deepEqual(calls, ['chosenDeparture', 'destinationObservation']);
  assert.equal(call.args.from_lng, '120.1'); assert.equal(call.args.from_name, '站点甲');
  assert.equal((call.route!.origin as { name: string }).name, '站点甲');
  assert.throws(() => resolveOntologyMcpRead(checked, {}, {}, () => { throw new Error('Evidence unavailable'); }), /Evidence unavailable/);
});

test('Malformed, cyclic, executable, credential or endpoint-bearing ontology data fails closed', () => {
  for (const mutate of [
    (m: any) => { m.actions[0].mcp.endpoint = 'https://untrusted.example'; },
    (m: any) => { m.actions[0].mcp.key = 'forbidden'; },
    (m: any) => { m.actions[0].mcp.arguments.keywords.path = ['constructor']; },
    (m: any) => { m.actions[0].mcp.arguments.keywords = { from: 'eval', expression: 'anything()' }; },
    (m: any) => { m.actions[1].mcp.requires[0].action = 'EstimateDidiRide'; m.actions[1].mcp.requires[0].objectType = 'RideEstimateObservation'; },
    (m: any) => { m.actions[1].mcp.requires = []; },
    (m: any) => { m.actions.push(m.actions[0]); },
  ]) {
    const module = structuredClone(didiReadDefinition); mutate(module);
    assert.throws(() => parseMcpReadModule(module));
  }
});

test('Ontology discovery exposes the actual tool binding and dependencies to the model', () => {
  const action = businessModel.action('EstimateDidiRide');
  assert.deepEqual(action.read!.mcp, didiReadDefinition.actions.find(a => a.id === action.id)!.mcp);
  assert.equal(action.read!.module!.digest, mcpReadModuleRef(didiReadDefinition).digest);
  const t = setupDidi((ctx, access) => {
    const described = access.session.call('describe_ontology', { actions: ['EstimateDidiRide'] }) as { actions: { read: { mcp: unknown } }[] };
    assert.deepEqual(described.actions[0]!.read.mcp, action.read!.mcp);
    assert(ctx.capability.actions!.filter(a => a.effect === 'read').every(a => a.ref.version === didiReadDefinition.version));
    assert(ctx.capability.actions!.filter(a => a.effect !== 'read').every(a => a.ref.id === 'StartTaskObservationWatch' && a.effect === 'local'));
    return chooseDidi(ctx, access);
  });
  return (async () => { try { const job = t.b.submit(); assert.equal((await t.finish(job.id)).state, 'completed'); } finally { t.close(); } })();
});

test('Declared evidence dependencies require actual model evaluations before an estimate can leave the Worker', async () => {
  const t = setupDidi((ctx, access) => {
    const call = access.session.call.bind(access.session);
    access.session.call = (tool, args) => tool === 'evaluate_ontology' ? { status: 'known' } : call(tool, args);
    return chooseDidi(ctx, access);
  });
  try {
    const job = t.b.submit(), done = await t.finish(job.id);
    assert.notEqual(done.state, 'completed');
    assert(!t.calls.some(c => c.name === 'taxi_estimate'));
    assert(done.delegation!.agent!.feedback.some(f => f.message.includes('read and evaluate')));
  } finally { t.close(); }
});

test('The model can search the destination first and defer the origin to a later decision', async () => {
  const t = setupDidi((ctx, access) => {
    const observations = observeDidi(ctx, access);
    const missing = (['destination', 'origin'] as const).find(role => !observations.some(o => o.snapshot.actionInput.role === role));
    if (!missing) return chooseDidi(ctx, access);
    return { kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic model chooses only one endpoint now',
      steps: [{ id: missing, action: 'SearchDidiPlaces', argumentsJson: JSON.stringify({ scope: ctx.state.scope, role: missing, keywords: input[missing] }), dependsOn: [], inputRefs: [] }], completionJson: '' };
  });
  try {
    const job = t.b.submit(); await t.b.run(); await t.b.run();
    const firstCalls = t.calls.filter(c => c.method === 'tools/call');
    assert.equal(firstCalls.length, 1); assert.equal(firstCalls[0]!.args!.keywords, input.destination);
    assert.equal(t.store.get(owner, job.id).delegation!.agent!.observations.length, 1);
    assert.equal((await t.finish(job.id)).state, 'completed');
    const all = t.calls.filter(c => c.method === 'tools/call');
    assert.deepEqual(all.map(c => c.name), ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.equal(all[1]!.args!.keywords, input.origin);
  } finally { t.close(); }
});
