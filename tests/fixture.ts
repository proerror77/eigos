import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Database } from '../packages/runtime/database.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Tasks } from '../packages/runtime/tasks.js';
import { RideWorkflow } from '../packages/capabilities/didi/workflow.js';
import { Worker } from '../apps/worker/worker.js';
import { developmentPrincipal } from '../apps/gateway/auth.js';
import { DidiMcpConnector } from '../packages/capabilities/didi/connector.js';
import { didiToolInputs } from '../packages/capabilities/didi/contracts.js';
import type { DidiSource } from '../packages/capabilities/didi/functions.js';

export const document = JSON.parse(readFileSync(new URL('../packages/ontology/definitions/ride.json', import.meta.url), 'utf8'));
export const route = { city: '上海市', origin: '中企云翠森林', destination: '前滩太古里' };
export const principal = developmentPrincipal;
export async function provider() {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-provider-')), key = 'synthetic-didi-key';
  const keyFile = join(directory, 'key'); await writeFile(keyFile, key, { mode: 0o600 });
  const calls: string[] = [], inputs: Record<string, unknown>[] = [];
  const flags = { active: true, ambiguous: false, before: undefined as (() => Promise<void>) | undefined };
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body));
    if (request.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-didi', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: Object.entries(didiToolInputs).map(([name, schema]) => ({ name, inputSchema: z.toJSONSchema(schema) })) };
    else if (request.method === 'tools/call') {
      const name = request.params.name, args = request.params.arguments;
      calls.push(name); inputs.push(args); await flags.before?.();
      if (name === 'maps_textsearch') {
        const place = { display_name: args.keywords, address: '浦东新区', address_all: args.keywords + '上海市浦东新区', city: args.city, location: { lat: 31.2, lng: args.keywords === route.origin ? 121.5 : 121.48 } };
        result = { content: [{ type: 'text', text: JSON.stringify(flags.ambiguous ? [place, { ...place, location: { lat: 31.3, lng: 121.6 } }] : [place]) }] };
      } else if (name === 'taxi_estimate') result = { structuredContent: { traceId: 'PRIVATE_ORDER_TOKEN', items: [{ productName: '快车', productCategory: 'fast', priceText: '73.05' }, { productName: '专车', productCategory: 'premium', priceText: '100-120元' }] } };
      else throw new Error('Unexpected provider tool');
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  const connector = new DidiMcpConnector({ bindingId: 'synthetic', keyFile, keySha256: createHash('sha256').update(key).digest('hex'), environment: 'production' }, fetcher, true);
  const source: DidiSource = { bindingId: 'synthetic', connector, async assertCurrent() { if (!flags.active) throw new Error('Source revoked'); } };
  return { source, calls, inputs, flags, close: () => rm(directory, { recursive: true, force: true }) };
}
export async function fixture() {
  const url = process.env.EIGOS_TEST_DATABASE_URL;
  if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).password !== 'synthetic-only') throw new Error('Use npm test to provision the isolated test database');
  const schema = 'eigos_test_' + randomUUID().replaceAll('-', ''), db = new Database(url, schema);
  await db.initialize();
  const metadata = new Metadata(db), model = await metadata.publish(document), tasks = new Tasks(db, metadata), p = await provider();
  const source = async (owner: string) => { if (owner !== principal.owner) throw new Error('Wrong source owner'); return p.source; };
  const workflow = new RideWorkflow(db, metadata, tasks, source), worker = new Worker(tasks, workflow);
  return { db, schema, model, metadata, tasks, workflow, worker, source, provider: p,
    submit: () => tasks.submit(principal, { requestId: randomUUID(), message: '从中企云翠森林到前滩太古里，只询价', route }),
    async close() { worker.stop(); await db.query(`DROP SCHEMA ${db.schema} CASCADE`); await db.close(); await p.close(); },
  };
}
