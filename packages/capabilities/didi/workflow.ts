import { digest, requireScope, type Principal } from '../../core/identity.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import { Database } from '../../runtime/database.js';
import { Metadata } from '../../runtime/metadata.js';
import { Objects } from '../../runtime/objects.js';
import { Actions } from '../../runtime/actions.js';
import { ingest } from '../../runtime/ingestion.js';
import { Tasks, routeInputSchema, type RouteInput, type Task } from '../../runtime/tasks.js';
import { rideFunctions, sourceResultSchema, type SourceResult, type SourceResolver } from './functions.js';

export class Clarification extends Error {
  constructor(message: string, readonly choices?: { role: string; places: ObjectData[] }) { super(message); }
}
export function routeFromMessage(message: string): RouteInput {
  const text = message.replace(/(?:不|不要|不许)(?:真实)?(?:下单|发单|付款|支付|订车|叫车)/g, '');
  if (/(下单|付款|支付|订车)/.test(text)) throw new Clarification('当前可查询估价，请确认只询价。');
  const match = /从\s*(.+?)\s*(?:到|前往|去)\s*(.+?)(?=，|,|。|；|;|只询价|只查|估价|询价|$)/.exec(text);
  const city = /([\u4e00-\u9fff]{2,5}市)/.exec(text)?.[1] ?? (text.includes('上海') ? '上海市' : undefined);
  if (!match || !city) throw new Clarification('请提供所在城市、上车地点和目的地。');
  return routeInputSchema.parse({ city, origin: match[1]!.trim(), destination: match[2]!.trim() });
}

export class RideWorkflow {
  readonly functions;
  readonly actions;
  constructor(private readonly db: Database, private readonly metadata: Metadata, private readonly tasks: Tasks, private readonly source: SourceResolver) {
    this.functions = rideFunctions(source);
    this.actions = new Actions(db, this.functions);
  }
  async run(task: Task, signal: AbortSignal) {
    const route = task.input.route ?? routeFromMessage(task.input.message);
    requireScope({ owner: task.owner, scopes: task.scopes }, 'tasks:write');
    await (await this.source(task.owner)).assertCurrent();
    const model = await this.metadata.get(task.release);
    // The Worker executes the accepted inquiry as its service identity. Source
    // access still requires the active account binding for this task's owner.
    const principal: Principal = { owner: task.owner, scopes: ['ontology:read', 'ontology:write', 'sources:Didi:read'] };
    const objects = new Objects(this.db, model, task.owner), context = { objects, principal, signal, taskId: task.id };
    const read = async (role: 'origin' | 'destination') => sourceResultSchema.parse(await this.tasks.source(task, role, { city: route.city, keywords: route[role] },
      async () => { await this.tasks.current(task); return this.functions.invoke(model, 'searchPlaces', { city: route.city, keywords: route[role] }, context); }));
    const searches = await Promise.all([read('origin'), read('destination')]);
    const receiptObject = async (graph: Objects, result: SourceResult): Promise<ObjectRef> => {
      const ref = { type: 'SourceReceipt', id: result.receipt.id };
      await graph.create(ref, { id: ref.id, name: result.receipt.tool, bindingId: result.receipt.bindingId, tool: result.receipt.tool,
        observedAt: result.receipt.receivedAt, evidence: result.evidence, contentDigest: result.receipt.resultDigest });
      return ref;
    };
    await this.db.transaction(async client => {
      await this.tasks.current(task, client, true);
      const graph = new Objects(this.db, model, task.owner, client);
      for (const result of searches) {
        if (result.data.kind !== 'places') throw new Error('Expected place source result');
        const receipt = await receiptObject(graph, result);
        const rows = result.data.places.map(place => ({ id: digest([result.receipt.bindingId, place.id]), name: place.name, city: place.city,
          address: place.addressAll || place.address || place.name, coordinates: { lat: place.lat, lng: place.lng }, coordinateSystem: place.coordinateSystem,
          sourceBinding: result.receipt.bindingId, observedAt: result.receipt.receivedAt }));
        const places = await ingest(graph, model, 'DidiPlaces', rows);
        await graph.linkBatch(places.map(ref => ({ type: 'PlaceSource', from: ref, to: receipt })));
      }
      await (await this.source(task.owner)).assertCurrent();
    });
    const select = async (index: number, name: string): Promise<ObjectData> => {
      const result = searches[index]!;
      if (result.data.kind !== 'places') throw new Error('Expected places');
      const ids = new Set(result.data.places.map(place => digest([result.receipt.bindingId, place.id])));
      const role = index === 0 ? 'origin' : 'destination';
      const candidates = await objects.query({ type: 'Location', from: { object: { type: 'SourceReceipt', id: result.receipt.id }, link: 'places' }, where: { city: route.city }, limit: 100 });
      const choice = task.input.places?.[role];
      const selected = candidates.items.filter(item => ids.has(item.ref.id) && (choice ? digest(item.ref) === digest(choice) : item.properties.name === name));
      if (candidates.cursor || selected.length !== 1) throw new Clarification(`请确认“${name}”的完整地址或具体入口。`, { role, places: candidates.items });
      return selected[0]!;
    };
    const [origin, destination] = await Promise.all([select(0, route.origin), select(1, route.destination)]);
    const routeRef = { type: 'Route', id: digest([origin.ref, destination.ref]) };
    await this.db.transaction(async client => {
      await this.tasks.current(task, client, true);
      const graph = new Objects(this.db, model, task.owner, client);
      await graph.create(routeRef, { id: routeRef.id, name: `${origin.properties.name} → ${destination.properties.name}` });
      await graph.link({ type: 'RouteOrigin', from: routeRef, to: origin.ref });
      await graph.link({ type: 'RouteDestination', from: routeRef, to: destination.ref });
    });
    const action = model.resolveAction(routeRef, 'RideEstimatable', 'requestEstimate', { requestId: task.id, route: routeRef, requestedAt: task.created_at.toISOString() });
    const request = await this.actions.apply(principal, model, action.action, action.input, task.id, client => this.tasks.current(task, client, true));
    const result = sourceResultSchema.parse(await this.tasks.source(task, 'estimate', { route: routeRef }, async () => {
      await this.tasks.current(task);
      return this.functions.invoke(model, 'estimateRoute', { route: routeRef }, context);
    }));
    if (result.data.kind !== 'estimate' || !result.data.items.length) throw new Clarification('供应商没有返回这条路线的费用估计。');
    const prices = result.data.items.filter(item => !route.serviceClass || item.productName === route.serviceClass);
    if (!prices.length) throw new Clarification('供应商未返回所选车型，请选择返回的车型。');
    await this.db.transaction(async client => {
      await this.tasks.current(task, client, true);
      await (await this.source(task.owner)).assertCurrent();
      const graph = new Objects(this.db, model, task.owner, client), receipt = await receiptObject(graph, result);
      const rows = prices.map(item => ({ id: digest([receipt.id, item.productCategory]), name: item.productName, productCategory: item.productCategory,
        priceText: item.priceText, estimatedAmount: item.estimatedMoney ? `${BigInt(item.estimatedMoney.minor) / 100n}.${String(BigInt(item.estimatedMoney.minor) % 100n).padStart(2, '0')}` : null,
        currency: 'CNY', feesComplete: 'unknown', observedAt: result.receipt.receivedAt, expiresAt: new Date(Date.parse(result.receipt.startedAt) + 300000).toISOString() }));
      const quotes = await ingest(graph, model, 'DidiEstimates', rows);
      await graph.linkBatch(quotes.flatMap(ref => [{ type: 'EstimateRequest', from: ref, to: request }, { type: 'EstimateSource', from: ref, to: receipt }]));
      const current = await graph.read(request);
      if (current.properties.status !== 'quoted') await graph.edit(request, current.revision, { status: 'quoted' });
    });
    const accepted = await this.functions.invoke(model, 'readRideEstimates', { request }, context);
    await (await this.source(task.owner)).assertCurrent();
    return { ...accepted as object, route: { origin: origin.properties, destination: destination.properties }, elapsedMs: Date.now() - task.created_at.getTime() };
  }
}
