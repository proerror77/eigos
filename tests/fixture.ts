import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Database } from '../packages/runtime/database.js';
import { Access, setGrants, memberGrants } from '../packages/runtime/access.js';
import { businessDefinition } from '../packages/ontology/definition.js';
import { Ontology } from '../packages/ontology/model.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Tasks } from '../packages/runtime/tasks.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { OntologyAgent, type AgentDriver } from '../packages/runtime/agent.js';
import { FixtureAgent } from './agent-driver.js';
import { Worker } from '../apps/worker/worker.js';
import { developmentPrincipal } from '../apps/gateway/auth.js';
import { DidiMcpConnector } from '../packages/capabilities/didi/connector.js';
import { didiToolInputs } from '../packages/capabilities/didi/contracts.js';
import type { DidiSource } from '../packages/capabilities/didi/functions.js';
import type { ServiceResolver } from '../packages/capabilities/services/sources.js';
import { ScheduledActions,ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';
import { digest } from '../packages/core/identity.js';

export const document = businessDefinition;
export const route = { city: '上海市', origin: '中企云翠森林', destination: '前滩太古里' };
export const principal = developmentPrincipal;
export async function provider() {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-provider-')), key = 'synthetic-didi-key';
  const keyFile = join(directory, 'key'); await writeFile(keyFile, key, { mode: 0o600 });
  const calls: string[] = [], inputs: Record<string, unknown>[] = [];
  const flags = { active: true, ambiguous: false, related: true, durationSeconds:300, amountMinor:'7305',orderEnabled:true, loseOrderReply:false, orderCreates:0, orderQueries:0, before: undefined as (() => Promise<void>) | undefined };
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body));
    if (request.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-didi', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: Object.entries(didiToolInputs).map(([name, schema]) => ({ name, inputSchema: {...z.toJSONSchema(schema),...(name==='maps_direction_driving'?{required:['origin','destination']}:{})} })) };
    else if (request.method === 'tools/call') {
      const name = request.params.name, args = request.params.arguments;
      calls.push(name); inputs.push(args); await flags.before?.();
      if (name === 'maps_textsearch') {
        const place = { display_name: args.keywords, address: '浦东新区', address_all: args.keywords + '上海市浦东新区', city: args.city, location: { lat: 31.2, lng: args.keywords === route.origin ? 121.5 : 121.48 } };
        const places = [place];
        if (flags.related) places.push({ ...place, display_name: args.keywords + '东门', location: { lat: 31.21, lng: 121.51 } });
        if (flags.ambiguous) places.push({ ...place, location: { lat: 31.3, lng: 121.6 } });
        result = { content: [{ type: 'text', text: JSON.stringify(places) }] };
      } else if (name === 'taxi_estimate') result = { structuredContent: { traceId: 'PRIVATE_ORDER_TOKEN', items: [{ productName: '快车', productCategory: 'fast', priceText: '73.05' }, { productName: '专车', productCategory: 'premium', priceText: '100-120元' }] } };
      else if(name==='maps_direction_driving')result={structuredContent:{status:'success',duration:{value:flags.durationSeconds},distance:{value:1951}}};
      else throw new Error('Unexpected provider tool');
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  const connector = new DidiMcpConnector({ bindingId: 'synthetic', keyFile, keySha256: createHash('sha256').update(key).digest('hex'), environment: 'production' }, fetcher, true);
  const source: DidiSource = { bindingId: 'synthetic', connector, async assertCurrent() { if (!flags.active) throw new Error('Source revoked'); } };
  source.orders={environment:'mock',supportedCurrencies:['CNY'],async assertAvailable(){if(!flags.orderEnabled)throw new Error('DIDI_ORDER_EXECUTION_DISABLED');},async quote(_input,category){return {traceId:'PRIVATE_ORDER_TOKEN',amountMinor:flags.amountMinor,currency:'CNY',category};},async create(_quote,_signal,guard){await guard();flags.orderCreates++;if(flags.loseOrderReply)throw new Error('Synthetic lost reply');return {orderId:'synthetic-original-order',status:'Created by fixture',state:'created',independentRead:false,evidence:'synthetic',observedAt:new Date().toISOString(),contentDigest:digest('created')};},async query(orderId){flags.orderQueries++;return {orderId,status:'Independent fixture status',state:'reported',independentRead:true,evidence:'synthetic',observedAt:new Date().toISOString(),contentDigest:digest('queried')};},async cancel(){throw new Error('No synthetic cancellation requested');}};
  return { source, calls, inputs, flags, close: () => rm(directory, { recursive: true, force: true }) };
}
export async function fixture(driver: AgentDriver = new FixtureAgent(),services?:ServiceResolver) {
  const url = process.env.EIGOS_TEST_DATABASE_URL;
  if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).password !== 'synthetic-only') throw new Error('Use npm test to provision the isolated test database');
  const schema = 'eigos_test_' + randomUUID().replaceAll('-', ''), db = new Database(url, schema);
  await db.initialize();
  const metadata = new Metadata(db), tasks = new Tasks(db, metadata), p = await provider();
  await setGrants(db, 'deployment', [{ resource: 'Eigos', permission: 'manage_definition' }]);
  const publisher = await Access.load(db, { owner: 'deployment', scopes: [] });
  await setGrants(db, principal.owner, memberGrants(new Ontology(document)));
  const access = await Access.load(db, principal);
  const source = async (owner: string) => { if (owner !== principal.owner) throw new Error('Wrong source owner'); return p.source; };
  const capabilities = createCapabilities(db, source,services), model = await metadata.publish(document, capabilities, publisher), agent = new OntologyAgent(db, metadata, tasks, capabilities, driver), worker = new Worker(tasks, agent,new ScheduledActions(db,metadata),new ScheduledActionRunner(db,metadata,tasks,capabilities.actions));
  return { db, schema, model, metadata, tasks, capabilities, access, publisher, agent, worker, source, provider: p,
    submit: () => tasks.submit(principal, { requestId: randomUUID(), message: '从中企云翠森林到前滩太古里，只询价', route }),
    async close() { worker.stop(); await db.query(`DROP SCHEMA ${db.schema} CASCADE`); await db.close(); await p.close(); },
  };
}
