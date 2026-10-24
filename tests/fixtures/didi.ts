// Synthetic source data and model decisions; never a live account or ride.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { didiBookingToolInputs } from '../../packages/capabilities/didi/booking-contracts.js';
import { DidiMcpConnector } from '../../packages/capabilities/didi/connector.js';
import { didiToolInputs, type DidiBinding } from '../../packages/capabilities/didi/contracts.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { DIDI_PROGRAM_REF } from '../../packages/capabilities/didi/program.js';
import type { AgentDecision, AgentStep } from '../../packages/ontology/agent-actions.js';
import type { AgentPlanningContext, PlanningAccess, Reasoner } from '../../packages/coordinator/coordinator.js';
import type { RideEstimateObservation } from '../../packages/ontology/ride-estimate.js';
import { digest } from '../../packages/core/delegation.js';
import { JobStore } from '../../packages/core/store.js';
import { backend, evidence, interpretation, observeTaskContext, acknowledgeReads } from '../backend-fixture.js';

export const syntheticKey = 'didi-fixture-key-never-a-real-account';
export const input = { mode: 'estimate', city: '北京市', origin: '北京西站', destination: '西二旗地铁站' } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const sourcePlace = (name: string, offset = 0) => ({ display_name: name, address: `地点${offset}号`, address_all: `${name}地点${offset}号`, city: '北京市', location: { lng: 116.3 + offset / 100, lat: 39.9 + offset / 100 } });
export function didiFixture(options: { booking?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-didi-')), keyFile = join(directory, 'key');
  writeFileSync(keyFile, syntheticKey, { mode: 0o600 });
  const binding: DidiBinding = { bindingId: 'synthetic-didi', keyFile, keySha256: createHash('sha256').update(syntheticKey).digest('hex'), environment: options.booking ? 'mock' : 'production', auditDirectory: join(directory, 'audit') };
  const calls: { method?: string; name?: string; args?: Record<string, unknown>; redirect?: RequestRedirect }[] = [];
  const flags = { empty: false, ambiguous: false, before: undefined as undefined | ((name: string) => Promise<void>), transform: undefined as undefined | ((body: any, request: any) => any) };
  const fetcher: typeof fetch = async (_url, init = {}) => {
    if (init.method === 'GET') return new Response(null, { status: 405 });
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    const request = JSON.parse(String(init.body));
    calls.push({ method: request.method, name: request.params?.name, args: request.params?.arguments, redirect: init.redirect });
    if (request.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-didi', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [...Object.entries(didiToolInputs).map(([name, schema]) => ({ name, inputSchema: z.toJSONSchema(schema) })), ...(options.booking ? Object.entries(didiBookingToolInputs).map(([name, schema]) => ({ name, inputSchema: z.toJSONSchema(schema) })) : [{ name: 'taxi_create_order', inputSchema: { type: 'object' } }])] };
    else {
      const name = request.params.name;
      await flags.before?.(name);
      if (name === 'maps_textsearch') {
        const target = request.params.arguments.keywords;
        const places = flags.empty ? [] : [sourcePlace('非目标地点', 1), sourcePlace(target, 2), ...(flags.ambiguous ? [sourcePlace(target, 3)] : [])];
        result = { content: [{ type: 'text', text: JSON.stringify(places) }] };
      } else if (name === 'taxi_create_order') result = { content: [], structuredContent: { orderId: 'mock-fixture-order', status: '匹配中', from: { name: input.origin }, to: { name: input.destination } } };
      else if (name === 'taxi_query_order') result = { content: [], structuredContent: { orderId: request.params.arguments.order_id, statusCode: 1, statusText: '司机已接单', driver: { name: '模拟司机', carModel: '模拟车型', carPlate: 'MOCK' } } };
      else result = { content: [{ type: 'text', text: 'Untrusted prose must never be the fare source' }], structuredContent: { traceId: 'PRIVATE_TRACE_NEVER_TO_MODEL', items: flags.empty ? [] : [{ productName: '快车', productCategory: 'native-fast', priceText: '73.05' }, { productName: '专车', productCategory: 'native-premium', priceText: '100-120元' }] } };
    }
    const body = flags.transform?.({ jsonrpc: '2.0', id: request.id, result }, request) ?? { jsonrpc: '2.0', id: request.id, result };
    return body instanceof Response ? body : json(body);
  };
  return { directory, keyFile, binding, calls, flags, fetcher, connector: new DidiMcpConnector(binding, fetcher, true), close: () => rmSync(directory, { recursive: true, force: true }) };
}
const step = (id: string, action: string, arguments_: object): AgentStep => ({ id, action, argumentsJson: JSON.stringify(arguments_), dependsOn: [], inputRefs: [] });
const decision = (ctx: AgentPlanningContext, steps: AgentStep[] = [], completion?: object): AgentDecision => ({ kind: completion ? 'complete' : 'execute', requestRevision: ctx.request.revision, message: 'Synthetic choice based on the exact requested endpoints and source observations', steps, completionJson: completion ? JSON.stringify(completion) : '' });
export function observeDidi(ctx: AgentPlanningContext, access: PlanningAccess) {
  observeTaskContext(access);
  access.session.call('describe_ontology', { search: 'RideEstimate', limit: 5 });
  access.session.call('query_ontology', { object: { type: 'ServiceRequest', id: ctx.request.id } });
  access.session.call('query_ontology', { object: ctx.state.scope });
  return ctx.state.observations.map(ref => {
    const value = access.session.call('query_ontology', { object: ref }) as { items: { properties: { snapshot: RideEstimateObservation } }[] };
    access.session.call('evaluate_ontology', { function: 'rideEstimateStatus', object: ref });
    return { ref, snapshot: value.items[0]!.properties.snapshot };
  });
}
export type DidiChoice = (ctx: AgentPlanningContext, access: PlanningAccess) => AgentDecision;
export const chooseDidi: DidiChoice = (ctx, access) => {
  const observations = observeDidi(ctx, access), scope = ctx.state.scope;
  if (!observations.length) return decision(ctx, [step('from', 'SearchDidiPlaces', { scope, role: 'origin', keywords: input.origin }), step('to', 'SearchDidiPlaces', { scope, role: 'destination', keywords: input.destination })]);
  const estimate = observations.find(o => o.snapshot.data.kind === 'estimate');
  if (estimate) return decision(ctx, [], { observation: estimate.ref, rationale: 'Return the source estimates; fees and ride outcome remain unknown' });
  const from = observations.find(o => o.snapshot.actionInput.role === 'origin')!, to = observations.find(o => o.snapshot.actionInput.role === 'destination')!;
  if (from.snapshot.data.kind !== 'places' || to.snapshot.data.kind !== 'places') throw new Error('Wrong fixture');
  return decision(ctx, [step('price', 'EstimateDidiRide', { scope, originObservation: from.ref, originPlaceId: from.snapshot.data.places[1]!.id, destinationObservation: to.ref, destinationPlaceId: to.snapshot.data.places[1]!.id })]);
};
export function didiModel(choice: DidiChoice = chooseDidi, taskInput: object = input): Reasoner {
  return { ground: async (request, _caps, _signal, access) => ({ decision: { ...interpretation(observeTaskContext(access) ?? request, DIDI_PROGRAM_REF.id, taskInput), capabilityRef: DIDI_PROGRAM_REF }, evidence: evidence() }), plan: async () => { throw new Error('No legacy route workflow'); }, act: async (ctx, _signal, access) => { const chosen = choice(ctx, access); acknowledgeReads(access); return { decision: chosen, evidence: { ...evidence(), decisionDigest: digest(chosen) } }; } };
}
export function setupDidi(choice: DidiChoice = chooseDidi, taskInput: object = input) {
  const fixture = didiFixture(), store = new JobStore(':memory:'), catalog = createExecutionCatalog({ store, didi: { ...fixture.binding, connector: fixture.connector } }), b = backend(catalog, didiModel(choice, taskInput), store);
  const finish = async (id: string) => { for (let i = 0; i < 12; i++) { const job = store.get(JSON.stringify(['local-development', 'local', 'developer']), id); if (!['submitted', 'working'].includes(job.state)) return job; await b.run(); } throw new Error('Synthetic task did not settle'); };
  return { ...fixture, store, catalog, b, finish, close: () => { store.close(); fixture.close(); } };
}
