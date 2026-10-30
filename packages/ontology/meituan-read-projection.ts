import { digest } from '../core/delegation.js';
import { BusinessFactProjection, businessFactsEnabled, sourceEntityRef } from './business-fact-projection.js';
import { DomainError } from '../core/domain.js';
import { meituanActionSchemas, meituanSnapshotSchema, type MeituanReadSnapshot } from './meituan-read.js';
import { meituanReadDefinition } from './meituan-read-definition.js';
import { linkSnapshotDigest, type OntologyObjectStore, type LinkWrite, type ObjectWrite, type ReadBudget } from './object-store.js';
import type { ObjectRef } from './model.js';
import type { Computation } from './object-functions.js';
import { sourceProof } from './object-evidence.js';

export function checkedMeituanRead(value: unknown): MeituanReadSnapshot {
  const s = meituanSnapshotSchema.parse(value), { contentDigest, ...body } = s;
  const binding = meituanReadDefinition.actions.find(a => a.id === s.action)?.mcp;
  const input = meituanActionSchemas[s.action].parse(s.actionInput);
  if (!binding || digest(body) !== contentDigest || s.id !== s.receipt.id || binding.tool !== s.receipt.tool || digest(input.scope) !== digest(s.scope) || s.observedAt !== s.receipt.observedAt || Date.parse(s.expiresAt) !== Date.parse(s.observedAt) + 300000 || new Set(s.dependencies.map(r => r.id)).size !== s.dependencies.length) throw new DomainError('CONFLICT', 'Meituan source snapshot is inconsistent');
  const expectedKind = s.receipt.tool === 'search_poi' ? 'locations' : s.receipt.tool === 'get_address_list' ? 'addresses' : s.receipt.tool === 'get_address_info' ? 'address_detail' : 'quote';
  if (s.data.kind !== expectedKind || digest(s.dependencies) !== digest(binding.requires.filter(d => !d.optional || s.actionInput[d.observationInput] !== undefined).map(d => s.actionInput[d.observationInput]))) throw new DomainError('CONFLICT', 'Meituan source kind or dependency refs differ from the ontology');
  return s;
}
export function projectMeituanRead(graph: OntologyObjectStore, owner: string, value: unknown): ObjectRef {
  const s = checkedMeituanRead(value), ref = { type: 'MeituanReadObservation', id: s.id }, root = { type: 'ServiceRequest', id: s.requestId };
  if (graph.read(owner, root).properties.revision !== s.requestRevision || Date.parse(s.expiresAt) <= graph.now()) throw new DomainError('CONFLICT', 'Meituan source is stale or belongs to an old request');
  const record: ObjectWrite = { ref, properties: { id: s.id, displayTitle: '美团只读来源', requestRevision: s.requestRevision, snapshot: s } };
  const receiptRef = { type: 'SourceReceipt', id: `meituan:${s.id}` };
  const facts = businessFactsEnabled(graph) ? new BusinessFactProjection(graph, owner, s.observedAt, receiptRef) : undefined;
  const links: LinkWrite[] = [{ type: 'MeituanObservationRequest', from: ref, to: root }, { type: 'MeituanObservationScope', from: ref, to: s.scope }, ...s.dependencies.map(to => ({ type: 'MeituanObservationDependency', from: ref, to }))];
  const objects: ObjectWrite[] = [record], subjects = [{ object: ref, digest: digest(record.properties), linksDigest: linkSnapshotDigest(ref, links) }];
  const add = (type: string, id: string, title: string, properties: Record<string, unknown>, evidence = false) => {
    const object: ObjectWrite = { ref: { type, id }, properties: { [graph.model.object(type).primaryKey]: id, displayTitle: title, ...properties } }; objects.push(object);
    if (evidence) { subjects.push({ object: object.ref, digest: digest(object.properties), linksDigest: '' }); links.push({ type: `${type}Evidence`, from: object.ref, to: receiptRef }); }
    return object.ref;
  };
  if (s.data.kind === 'locations') for (const [index, place] of s.data.places.entries()) {
    const fields = {
    name: place.name, ...(place.address ? { address: { text: place.address, ...(place.city ? { city: place.city } : {}) } } : {}),
    ...(place.lat !== undefined && place.lng !== undefined ? { coordinates: { lat: place.lat, lng: place.lng }, coordinateUnit: 'degree', coordinateSystem: 'unknown' } : {}),
    };
    if (facts) {
      const identity = place.poiId !== undefined ? { kind: 'poiId', value: place.poiId, cityId: place.cityId } : place.id !== undefined ? { kind: 'id', value: place.id, cityId: place.cityId } : { kind: 'source_fingerprint', value: place };
      const entity = facts.entity(sourceEntityRef('Place', 'meituan:search_poi', identity), place.name, fields, 'PlaceEvidence');
      facts.edge('MeituanObservationPlaces', ref, entity);
    } else add('Place', digest({ observation: s.id, index, place }), place.name, fields, true);
  }
  const removeLinks: LinkWrite[] = [];
  if (s.data.kind === 'quote') {
    const data = s.data, parcel = add('Parcel', `parcel:${s.id}`, '用户声明的包裹', { contentsCategory: data.category, declaredContents: data.goodsName, declaredWeight: { amount: String(data.weightKg), unit: 'kg' } });
    const route = add('DeliveryRoute', `route:${s.id}`, '用户已确认的私密路线', { originSnapshot: { text: '用户确认的寄件地址', sourceRevision: s.id }, destinationSnapshot: { text: '用户确认的收件地址', sourceRevision: s.id }, selectedAt: s.observedAt });
    const provider = facts ? facts.entity(sourceEntityRef('Provider', 'meituan:personal', 'meituan'), '美团', { name: '美团个人只读渠道' }) : add('Provider', `meituan:${s.id}`, '美团', { name: '美团个人只读渠道' });
    const channel = facts ? facts.entity(sourceEntityRef('Channel', 'meituan:personal', 'mcp-stdio'), '美团只读', { name: '美团个人只读渠道', accessScope: ['read'], supportedOperationRefs: ['delivery_preview'] }) : add('Channel', `meituan-channel:${s.id}`, '美团只读', { name: '美团个人只读渠道', accessScope: ['read'], supportedOperationRefs: ['delivery_preview'] });
    const quote = add('DeliveryQuote', s.id, '同城跑腿估价', { observedAt: s.observedAt, expiresAt: s.expiresAt, validityBasis: 'local_refresh_limit', priceKind: 'estimate', pricingCompleteness: 'unknown', serviceLevel: data.service, quotedWeight: { amount: String(data.weightKg), unit: 'kg' }, requestRevision: s.requestRevision, parcelRevision: 1, routeRevision: 1, pricingTerms: { total: data.total, scope: 'unknown', components: [] } }, true);
    for (const [type, from, to] of [['ParcelRequest', parcel, root], ['RouteRequest', route, root], ['QuoteParcel', quote, parcel], ['QuoteRoute', quote, route], ['OfferRequest', quote, root], ['OfferProvider', quote, provider], ['OfferChannel', quote, channel]] as const) links.push({ type, from, to });
    facts?.edge('MeituanObservationQuote', ref, quote);
    for (const old of graph.related(owner, root, 'selectedRoute', { remaining: 1000 }) ?? []) removeLinks.push({ type: 'SelectedRoute', from: root, to: old.ref });
    links.push({ type: 'SelectedRoute', from: root, to: route });
  }
  if (facts) { objects.push(...facts.objects); links.push(...facts.links); removeLinks.push(...facts.removeLinks); }
  for (const subject of subjects) subject.linksDigest = linkSnapshotDigest(subject.object, links);
  subjects.push(...(facts?.subjects() ?? []));
  const scope = graph.read(owner, s.scope).properties.input as Record<string, unknown>;
  const receipt: ObjectWrite = { ref: receiptRef, properties: { [graph.model.object('SourceReceipt').primaryKey]: receiptRef.id, displayTitle: 'Meituan read source receipt', sourceIdentity: 'meituan-personal:mcp-stdio', sourceEventId: s.id, scope: s.data.kind === 'locations' ? 'public_locations' : 'delivery_quote', ...(s.data.kind === 'locations' ? { queryScope: { city: scope.city, keyword: scope.keyword } } : {}), observedAt: s.observedAt, evidenceLevel: s.receipt.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly', contentDigest: s.contentDigest, subjects, safeSummary: '单次只读事实；地址选项和联系人载荷保存在任务私密区，无下单付款' } };
  links.push({ type: 'MeituanObservationEvidence', from: ref, to: receiptRef }, { type: 'ReceiptRequest', from: receiptRef, to: root });
  graph.ingest(owner, { objects: [...objects, receipt], links, removeLinks }, { kind: s.receipt.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.id, observedAt: s.observedAt });
  return ref;
}
export function evaluateMeituanRead(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget, active = new Set<string>()): Computation | undefined {
  if (input.function !== 'meituanReadStatus') return;
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  if (input.object.type !== 'MeituanReadObservation' || active.has(input.object.id)) return unknown('Meituan observation type or dependency cycle is invalid');
  const object = graph.read(owner, input.object, budget), proof = sourceProof(graph, owner, input.object, budget);
  if (!proof) return unknown('Meituan source evidence differs');
  let s; try { s = checkedMeituanRead(object.properties.snapshot); } catch { return unknown('Meituan snapshot is invalid'); }
  if (Date.parse(s.observedAt) > graph.now() || Date.parse(s.expiresAt) <= graph.now()) return unknown('Meituan source expired under local policy');
  const roots = graph.related(owner, input.object, 'request', budget), scopes = graph.related(owner, input.object, 'scope', budget), dependencies = graph.related(owner, input.object, 'dependencies', budget);
  if (roots?.length !== 1 || roots[0]!.ref.id !== s.requestId || roots[0]!.properties.revision !== s.requestRevision || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope) || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.requestRevision !== s.requestRevision || !dependencies || digest(dependencies.map(d => d.ref).sort((a,b) => a.id.localeCompare(b.id))) !== digest([...s.dependencies].sort((a,b) => a.id.localeCompare(b.id)))) return unknown('Meituan observation belongs to another request, scope or source graph');
  for (const dependency of s.dependencies) {
    const source = checkedMeituanRead(graph.read(owner, dependency, budget).properties.snapshot);
    if (source.requestId !== s.requestId || source.requestRevision !== s.requestRevision || source.configurationDigest !== s.configurationDigest || evaluateMeituanRead(graph, owner, { function: input.function, object: dependency }, budget, new Set(active).add(s.id))?.status !== 'known') return unknown('Meituan dependency is not current owned source evidence');
  }
  return { status: 'known', value: { data: s.data, observedAt: s.observedAt, freshnessPolicyUntil: s.expiresAt, noBusinessWrites: true }, evidenceRefs: [input.object, ...proof.refs], evidenceLevels: proof.levels };
}
