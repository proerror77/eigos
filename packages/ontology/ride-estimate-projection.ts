import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { didiEndpoint } from '../capabilities/didi/contracts.js';
import { rideEstimateActionSchemas, rideEstimateObservationSchema, type RideEstimateObservation } from './ride-estimate.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite } from './object-store.js';
import type { ObjectRef } from './model.js';
import { BusinessFactProjection, businessFactsEnabled, sourceEntityRef } from './business-fact-projection.js';
import type { DidiPlace } from '../capabilities/didi/contracts.js';

export function checkedRideEstimate(value: unknown): RideEstimateObservation {
  const s = rideEstimateObservationSchema.parse(value), { contentDigest, ...body } = s;
  const input = rideEstimateActionSchemas[s.action].parse(s.actionInput);
  if (digest(body) !== contentDigest || s.id !== s.receipt.id || s.receipt.endpoint !== didiEndpoint(s.receipt.environment)
    || digest(input.scope) !== digest(s.scope) || s.receipt.resultDigest !== digest(s.data) || s.observedAt !== s.receipt.receivedAt
    || Date.parse(s.receipt.startedAt) > Date.parse(s.observedAt) || Date.parse(s.expiresAt) !== Date.parse(s.receipt.startedAt) + 300000
    || s.evidenceKind === 'live_readonly' && s.receipt.environment !== 'production' || s.evidenceKind === 'provider_mock' && s.receipt.environment !== 'mock'
    || (s.action === 'SearchDidiPlaces') !== (s.data.kind === 'places') || (s.action === 'EstimateDidiRide') !== !!s.route) throw new DomainError('CONFLICT', 'DiDi source snapshot is inconsistent');
  if (s.data.kind === 'places' && new Set(s.data.places.map(p => p.id)).size !== s.data.places.length) throw new DomainError('CONFLICT', 'Duplicate place identity');
  if (s.data.kind === 'estimate' && new Set(s.data.items.map(p => p.productCategory)).size !== s.data.items.length) throw new DomainError('CONFLICT', 'Duplicate product category');
  return s;
}

export function projectRideEstimate(graph: OntologyObjectStore, owner: string, value: unknown): ObjectRef {
  const s = checkedRideEstimate(value), root = { type: 'ServiceRequest', id: s.requestId };
  if (graph.read(owner, root).properties.revision !== s.requestRevision) throw new DomainError('CONFLICT', 'DiDi response has an old request revision');
  const subject = { type: s.data.kind === 'places' ? 'DidiPlaceObservation' : 'RideEstimateObservation', id: s.id };
  const objects: ObjectWrite[] = [], links: LinkWrite[] = [];
  const receipt = { type: 'SourceReceipt', id: `didi:${s.id}` };
  const facts = businessFactsEnabled(graph) ? new BusinessFactProjection(graph, owner, s.observedAt, receipt) : undefined;
  const namespace = `didi:${s.receipt.environment}:${s.receipt.bindingId}`;
  // DiDi supplies a content identity, not a persistent native place identifier.
  // Equal source snapshots can be reused; changed coordinates/name are never merged.
  const place = (value: DidiPlace) => {
    const ref = sourceEntityRef('Place', namespace, { identityKind: value.identityKind, id: value.id });
    return facts!.entity(ref, value.name, { name: value.name, address: { text: value.addressAll || value.address || value.name, city: value.city },
      coordinates: { lat: value.lat, lng: value.lng }, coordinateUnit: 'degree', coordinateSystem: value.coordinateSystem }, 'PlaceEvidence');
  };
  const add = (ref: ObjectRef, title: string, fields: Record<string, unknown>) => {
    try { graph.read(owner, ref); throw new DomainError('CONFLICT', 'DiDi observations cannot be replayed'); }
    catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
    const def = graph.model.object(ref.type), record = { ref, properties: { [def.primaryKey]: ref.id, displayTitle: title.slice(0, 500), ...fields } }; objects.push(record); return record;
  };
  const record = add(subject, s.data.kind === 'places' ? '滴滴地点搜索' : '滴滴车型估价', { requestRevision: s.requestRevision, snapshot: s });
  const provider = facts ? sourceEntityRef('Provider', namespace, 'didi-mcp') : { type: 'Provider', id: digest({ observation: s.id, provider: 'didi-mcp' }) };
  if (facts) facts.entity(provider, '滴滴官方 MCP', { name: '滴滴官方 MCP', verifiedIdentityRefs: [s.receipt.endpoint] });
  else add(provider, '滴滴官方 MCP', { name: '滴滴官方 MCP', verifiedIdentityRefs: [s.receipt.endpoint] });
  links.push({ type: `${subject.type}Request`, from: subject, to: root }, { type: `${subject.type}Scope`, from: subject, to: s.scope }, { type: `${subject.type}Provider`, from: subject, to: provider });
  if (s.route) {
    const input = rideEstimateActionSchemas.EstimateDidiRide.parse(s.actionInput);
    const route = facts ? sourceEntityRef('RideRoute', namespace, { origin: s.route.origin.id, destination: s.route.destination.id }) : { type: 'RideRoute', id: digest({ observation: s.id, route: s.route }) };
    if (facts) {
      facts.entity(route, `${s.route.origin.name} → ${s.route.destination.name}`, { origin: s.route.origin.name, destination: s.route.destination.name }, 'RideRouteEvidence');
      facts.edge('RideRouteOriginPlace', route, place(s.route.origin)); facts.edge('RideRouteDestinationPlace', route, place(s.route.destination));
      if (s.data.kind === 'estimate') for (const item of s.data.items) {
        const minor = item.estimatedMoney?.minor;
        const estimatedAmount = minor === undefined ? undefined : `${BigInt(minor) / 100n}.${String(BigInt(minor) % 100n).padStart(2, '0')}`;
        const estimate = facts.fact(sourceEntityRef('RideEstimate', namespace, { observation: s.id, category: item.productCategory }), item.productName,
          { observedAt: s.observedAt, expiresAt: s.expiresAt, requestRevision: s.requestRevision, productCategory: item.productCategory, productName: item.productName,
            ...(item.priceText ? { priceText: item.priceText } : {}), ...(estimatedAmount ? { estimatedAmount, currency: 'CNY' } : {}), priceKind: 'estimate', feesComplete: 'unknown' });
        facts.edge('RideObservationEstimates', subject, estimate); facts.edge('RideEstimateRequest', estimate, root);
        facts.edge('RideEstimateBusinessRoute', estimate, route); facts.edge('RideEstimateBusinessProvider', estimate, provider);
      }
    } else add(route, `${s.route.origin.name} → ${s.route.destination.name}`, { origin: s.route.origin.name, destination: s.route.destination.name });
    links.push({ type: 'RideEstimateRoute', from: subject, to: route }, { type: 'RideEstimateOriginSearch', from: subject, to: input.originObservation }, { type: 'RideEstimateDestinationSearch', from: subject, to: input.destinationObservation });
  }
  if (facts && s.data.kind === 'places') for (const value of s.data.places) facts.edge('DidiObservationPlaces', subject, place(value));
  if (facts) { objects.push(...facts.objects); links.push(...facts.links); }
  add(receipt, '滴滴只读来源回执', { sourceIdentity: `didi-mcp:${s.receipt.environment}:${s.receipt.bindingId}`, sourceEventId: s.receipt.id, scope: 'domain_ride', observedAt: s.observedAt,
    evidenceLevel: s.evidenceKind === 'fixture' ? 'synthetic' : s.evidenceKind === 'provider_mock' ? 'provider_test' : 'live_readonly', contentDigest: s.contentDigest,
    subjects: [{ object: subject, digest: digest(record.properties), linksDigest: linkSnapshotDigest(subject, links) }, ...(facts?.subjects() ?? [])], safeSummary: '一次地点或车型估价读取；价格是预估，完整费用、叫车可用性与接送承诺未知' });
  links.push({ type: 'ReceiptRequest', from: receipt, to: root }, { type: `${subject.type}Evidence`, from: subject, to: receipt });
  graph.ingest(owner, { objects, links, removeLinks: facts?.removeLinks }, { kind: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.receipt.id, observedAt: s.observedAt });
  return subject;
}
