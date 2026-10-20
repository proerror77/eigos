import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { paotuiInputs } from '../capabilities/paotui-current-inputs.js';
import type { CurrentAddressSelection } from '../capabilities/paotui-address-selection.js';
import type { SavedAddress } from '../capabilities/paotui-atomic.js';
import type { ServiceRequest } from './execution.js';
import type { ObjectRef } from './model.js';
import type { ObjectSnapshot } from './planning-contract.js';
import type { LinkWrite, ObjectSource, ObjectView, OntologyObjectStore } from './object-store.js';

export function paotuiBusinessRefs(owner: string, requestId: string) {
  const id = digest({ owner, requestId, namespace: 'paotui-current-business' });
  return {
    parcel: { type: 'Parcel', id: `paotui:${id}` },
    route: { type: 'DeliveryRoute', id: `paotui:${id}` },
    provider: { type: 'Provider', id: 'meituan-paotui' },
    channel: { type: 'Channel', id: 'meituan-paotui:owned-readonly' },
  };
}
export type PaotuiBusinessRefs = ReturnType<typeof paotuiBusinessRefs>;
export function paotuiSavedAddressRef(owner: string, namespace: string, addressId: string): ObjectRef {
  return { type: 'SavedAddress', id: `paotui:${digest({ owner, namespace, addressId })}` };
}
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function existing(graph: OntologyObjectStore, owner: string, ref: ObjectRef): ObjectView | undefined {
  try { return graph.readPrivate(owner, ref); } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
}
/** Receipt timestamps alone do not change a current business object. A changed
 * source identity here represents changed facts, including private address data. */
function upsert(graph: OntologyObjectStore, owner: string, ref: ObjectRef, values: Record<string, unknown>, source: ObjectSource, links: LinkWrite[] = [], removeLinks: LinkWrite[] = []) {
  const def = graph.model.object(ref.type), properties = { [def.primaryKey]: ref.id, ...values }, old = existing(graph, owner, ref);
  const changed = !old || !same(old.properties, properties) || old.source.kind !== source.kind || old.source.id !== source.id;
  graph.ingest(owner, { objects: changed ? [{ ref, properties, ...(old ? { expectedRevision: old.revision } : {}) }] : [], links, removeLinks }, source);
}
const messageTime = (request: ServiceRequest) => request.messages.at(-1)?.receivedAt ?? new Date(0).toISOString();

export function initializePaotuiBusiness(graph: OntologyObjectStore, owner: string, request: ServiceRequest, goodsName?: string, delivery = true): PaotuiBusinessRefs {
  const refs = paotuiBusinessRefs(owner, request.id), root = { type: 'ServiceRequest', id: request.id }, facts = paotuiInputs(request).fields;
  const source: ObjectSource = { kind: 'task', id: 'meituan-paotui:owned-readonly', observedAt: messageTime(request) };
  upsert(graph, owner, refs.provider, { displayTitle: '美团跑腿', name: '美团跑腿' }, source);
  upsert(graph, owner, refs.channel, { displayTitle: '本人授权只读渠道', name: '美团本人只读渠道', accessScope: ['read'], supportedOperationRefs: ['get_address_list', 'get_address_info', 'delivery_preview'] }, source);
  if (!delivery) return refs;
  const field = (name: string) => facts[name]?.status === 'confirmed' ? facts[name] : undefined;
  const parcelFacts = { category: field('category'), weight: field('weightKg'), contents: field('goodsText'), goodsName };
  upsert(graph, owner, refs.parcel, { displayTitle: '本人声明的包裹',
    ...(parcelFacts.category ? { contentsCategory: parcelFacts.category.value } : {}),
    ...(parcelFacts.weight ? { declaredWeight: { amount: String(parcelFacts.weight.value), unit: 'kg' } } : {}),
    ...(goodsName ? { declaredContents: goodsName } : {}),
  }, { kind: 'user', id: digest(parcelFacts), observedAt: messageTime(request) }, [{ type: 'ParcelRequest', from: refs.parcel, to: root }]);
  if (!existing(graph, owner, refs.route)) upsert(graph, owner, refs.route, { displayTitle: '本人配送路线' },
    { kind: 'user', id: digest({ selections: {} }), observedAt: messageTime(request) }, [{ type: 'RouteRequest', from: refs.route, to: root }]);
  return refs;
}

export function projectPaotuiAddresses(graph: OntologyObjectStore, owner: string, namespace: string, addresses: SavedAddress[], source: ObjectSource): ObjectRef[] {
  return addresses.map(address => {
    const ref = paotuiSavedAddressRef(owner, namespace, address.addressId);
    // The identifier and all physical/contact fields stay private. A source
    // change still advances the object revision when these hidden facts change.
    upsert(graph, owner, ref, { displayTitle: '本人保存地址', label: '本人保存地址', sourceReference: address.addressId },
      { ...source, id: digest({ namespace, address }) });
    return ref;
  });
}

export function projectPaotuiRoute(graph: OntologyObjectStore, owner: string, request: ServiceRequest, refs: PaotuiBusinessRefs, namespace: string,
  roles: Partial<Record<'sender' | 'recipient', CurrentAddressSelection>>) {
  const root = { type: 'ServiceRequest', id: request.id }, links: LinkWrite[] = [{ type: 'RouteRequest', from: refs.route, to: root }], removeLinks: LinkWrite[] = [];
  const selected = Object.fromEntries((['sender', 'recipient'] as const).flatMap(role => {
    const choice = roles[role];
    if (!choice) return [];
    const ref = paotuiSavedAddressRef(owner, namespace, choice.address.addressId);
    // Only authenticated, already projected address objects can be selected.
    graph.read(owner, ref);
    return [[role, { ref, content: digest({ namespace, address: choice.address }), messageId: choice.source.id, receivedAt: choice.source.receivedAt }]];
  })) as Partial<Record<'sender' | 'recipient', { ref: ObjectRef; content: string; messageId: string; receivedAt: string }>>;
  for (const [role, link, name] of [['sender', 'RouteOrigin', 'originAddress'], ['recipient', 'RouteDestination', 'destinationAddress']] as const) {
    for (const old of graph.related(owner, refs.route, name, { remaining: 1000 }) ?? []) if (!selected[role] || !same(old.ref, selected[role]!.ref)) removeLinks.push({ type: link, from: refs.route, to: old.ref });
    if (selected[role]) links.push({ type: link, from: refs.route, to: selected[role]!.ref });
  }
  const complete = !!roles.sender && !!roles.recipient && roles.sender.address.addressId !== roles.recipient.address.addressId && roles.sender.address.cityId === roles.recipient.address.cityId;
  for (const old of graph.related(owner, root, 'selectedRoute', { remaining: 1000 }) ?? []) if (!complete || !same(old.ref, refs.route)) removeLinks.push({ type: 'SelectedRoute', from: root, to: old.ref });
  if (complete) links.push({ type: 'SelectedRoute', from: root, to: refs.route });
  const selectedAt = Object.values(selected).map(s => s.receivedAt).sort().at(-1);
  upsert(graph, owner, refs.route, { displayTitle: '本人配送路线', ...(complete ? { selectedAt } : {}) },
    { kind: 'user', id: digest({ selections: selected }), observedAt: selectedAt ?? messageTime(request) }, links, removeLinks);
}

export function paotuiObjectSnapshot(graph: OntologyObjectStore, owner: string, ref: ObjectRef): ObjectSnapshot {
  const value = graph.read(owner, ref);
  return { ref, revision: value.revision, propertiesDigest: digest(value.properties), linksDigest: graph.relationshipDigest(owner, ref, { remaining: 1000 }) };
}
export function matchesPaotuiSnapshot(graph: OntologyObjectStore, owner: string, snapshot: ObjectSnapshot) {
  try { return same(paotuiObjectSnapshot(graph, owner, snapshot.ref), snapshot); } catch { return false; }
}
