import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ObjectRef } from './model.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectSource, type ObjectWrite, type ReadBudget, type LinkWrite } from './object-store.js';
import type { Computation } from './object-functions.js';
import { sourceProof } from './object-evidence.js';
import { catalogEntityRefs, checkedAgentCatalogObservation } from './catalog-agent-projection.js';
import { evaluateAgentCatalogFunction } from './catalog-agent-functions.js';
import { readCommerceObservation } from './commerce-journey-functions.js';
import { parseCommerceEntity } from './commerce-journey.js';
import { commerceProductVariantValues } from './product-attributes.js';

import { identityTypes, identityKindSchema, identityEndpointSchema, entityIdentityAssertionSchema, identityFunctionSchemas, identityAssertionRefSchema as assertionRef, type EntityIdentityAssertion } from './identity-model.js';
export * from './identity-model.js';

const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), time = z.iso.datetime({ offset: true });
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
/** Internal mapper utility. The evidence object is an actual source observation,
 * not a title, a buyer assertion or a fabricated source identifier. */
export function pinIdentityEndpoint(graph: OntologyObjectStore, owner: string, ref: ObjectRef, evidenceObject: ObjectRef, budget: ReadBudget = { remaining: 1000 }): z.infer<typeof identityEndpointSchema> {
  const subject = graph.read(owner, ref, budget), evidence = graph.read(owner, evidenceObject, budget);
  const proof = sourceProof(graph, owner, evidenceObject, budget);
  if (!proof || proof.refs.length !== 1) fail('Identity endpoint needs one exact source receipt');
  const receipt = graph.read(owner, proof.refs[0]!, budget);
  let sourceIdentity: string, sourceRecordId: string, sourceVersion: string;
  if (ref.type === 'ProductVariant' && evidenceObject.type === 'CatalogObservation') {
    if (evaluateAgentCatalogFunction(graph, owner, { function: 'catalogObservationStatus', object: evidenceObject }, budget)?.status !== 'known') fail('Catalog identity evidence is stale or out of scope');
    const snapshot = checkedAgentCatalogObservation(evidence.properties.snapshot), item = snapshot.items.find(item => same(catalogEntityRefs(snapshot, item.variantId).variant, ref));
    if (!item || !(graph.related(owner, ref, 'currentCatalogObservation', budget) ?? []).some(o => same(o.ref, evidenceObject))) fail('Catalog identity evidence does not describe the current variant');
    const specification = [{ name: 'variant_id', value: item.variantId }, ...(item.sku ? [{ name: 'sku', value: item.sku }] : [])];
    if (subject.properties.name !== item.title.slice(0, 500) || !same(subject.properties.specification, specification)
      || !same(subject.properties.typedAttributes ?? null, item.typedAttributes ?? null)) fail('Catalog variant changed outside its source observation');
    sourceIdentity = `shopify:${snapshot.merchant.shopId}`; sourceRecordId = item.variantId; sourceVersion = snapshot.contentDigest;
  } else if (ref.type === 'ProductVariant' && evidenceObject.type === 'CommerceProduct') {
    const snapshot = readCommerceObservation(graph, owner, evidenceObject, { budget }), data = parseCommerceEntity('CommerceProduct', snapshot.data);
    const values = commerceProductVariantValues(data);
    if (!(graph.related(owner, evidenceObject, 'productVariant', budget) ?? []).some(o => same(o.ref, ref))
      || !(graph.related(owner, ref, 'currentCommerceProduct', budget) ?? []).some(o => same(o.ref, evidenceObject))
      || subject.properties.specificationRevision !== digest(values)) fail('Commerce identity evidence does not describe the current variant');
    sourceIdentity = snapshot.receipt.sourceIdentity; sourceRecordId = `${data.merchantId}:${data.variantId}`; sourceVersion = `${snapshot.sourceVersion}:${snapshot.contentDigest}`;
  } else {
    if (!sourceProof(graph, owner, ref, budget) || evidence.ref.type !== `${ref.type}Observation` || !(graph.related(owner, evidenceObject, 'entity', budget) ?? []).some(o => same(o.ref, ref))
      || !(graph.related(owner, ref, 'currentObservation', budget) ?? []).some(o => same(o.ref, evidenceObject))
      || evidence.properties.valuesDigest !== digest(subject.properties) || !same(evidence.properties.snapshot, subject.properties)) fail('Identity endpoint evidence does not bind the current domain object');
    sourceIdentity = text.parse(evidence.properties.sourceIdentity); sourceRecordId = text.parse(evidence.properties.nativeIdentity); sourceVersion = `${text.parse(evidence.properties.sourceRevision)}:${String(evidence.properties.sourceVersion)}`;
  }
  return identityEndpointSchema.parse({ object: ref, revision: subject.revision, propertiesDigest: digest(subject.properties), sourceIdentity, sourceRecordId, sourceVersion,
    evidenceObject, evidenceDigest: digest(evidence.properties), receipt: receipt.ref, receiptDigest: digest(receipt.properties) });
}
export function identityAssertionLinks(ref: ObjectRef, assertion: EntityIdentityAssertion): LinkWrite[] {
  return [{ type: 'IdentityAssertionLeft', from: ref, to: assertion.left.object }, { type: 'IdentityAssertionRight', from: ref, to: assertion.right.object },
    ...(assertion.supersedes ? [{ type: 'IdentityAssertionPredecessor', from: ref, to: assertion.supersedes }] : [])];
}
export const identityAssertionSourceSchema = z.strictObject({ sourceIdentity: text, sourceEventId: text, assertionDigest: sha, observedAt: time, evidenceLevel: z.enum(['synthetic', 'provider_test', 'live_readonly']) });

/** Trusted connector/source-mapping entry only; deliberately has no public tool
 * or executable action binding. Call after the adapter authenticates its source.
 * This checks the exact assertion and existing source facts; no object is merged. */
export function projectEntityIdentityAssertion(graph: OntologyObjectStore, owner: string, raw: unknown, rawReceipt: unknown): z.infer<typeof assertionRef> {
  const assertion = entityIdentityAssertionSchema.parse(raw), receipt = identityAssertionSourceSchema.parse(rawReceipt);
  if (assertion.ownerDigest !== digest(owner) || receipt.sourceIdentity !== assertion.issuerIdentity || receipt.assertionDigest !== digest(assertion)
    || receipt.observedAt !== assertion.observedAt || Date.parse(assertion.observedAt) > graph.now()) fail('Identity assertion owner, issuer, receipt or time is invalid');
  const ref = { type: 'EntityIdentityAssertion' as const, id: digest({ owner, issuer: receipt.sourceIdentity, event: receipt.sourceEventId }) };
  for (const endpoint of [assertion.left, assertion.right]) {
    graph.read(owner, endpoint.object);
    const source = graph.read(owner, endpoint.receipt);
    if (Date.parse(String(source.properties.observedAt)) > Date.parse(assertion.observedAt)) fail('Identity assertion predates its endpoint source evidence');
    if (receipt.evidenceLevel !== 'synthetic' && source.properties.evidenceLevel === 'synthetic') fail('Synthetic identity evidence cannot be promoted');
    if (assertion.lifecycle === 'active' && !same(pinIdentityEndpoint(graph, owner, endpoint.object, endpoint.evidenceObject), endpoint)) fail('Identity endpoint source version changed');
  }
  if (assertion.supersedes) {
    const old = entityIdentityAssertionSchema.parse(graph.read(owner, assertion.supersedes).properties.assertion);
    if (old.issuerIdentity !== assertion.issuerIdentity || old.identityKind !== assertion.identityKind || !same(old.left.object, assertion.left.object) || !same(old.right.object, assertion.right.object)
      || old.sourceVersion >= assertion.sourceVersion || Date.parse(old.observedAt) > Date.parse(assertion.observedAt)
      || assertion.lifecycle === 'revoked' && (!same(old.left, assertion.left) || !same(old.right, assertion.right))) fail('Identity successor must preserve issuer and pair and advance the exact source version');
    if (!sourceProof(graph, owner, assertion.supersedes, { remaining: 1000 })) fail('Identity predecessor has no valid source receipt');
    if ((graph.related(owner, assertion.supersedes, 'successors', { remaining: 1000 }) ?? []).some(o => !same(o.ref, ref))) fail('Identity assertion history cannot fork');
  }
  const record: ObjectWrite = { ref, properties: { id: ref.id, displayTitle: '实体同一性来源判断', assertion } }, links = identityAssertionLinks(ref, assertion);
  const receiptObject = { type: 'SourceReceipt', id: `identity:${ref.id}` };
  const source: ObjectSource = { kind: receipt.evidenceLevel === 'synthetic' ? 'synthetic' : 'provider', id: receipt.sourceIdentity, observedAt: receipt.observedAt };
  const sealed: ObjectWrite = { ref: receiptObject, properties: { receiptId: receiptObject.id, displayTitle: '实体身份来源回执', sourceIdentity: receipt.sourceIdentity, sourceEventId: receipt.sourceEventId,
    scope: 'identity_mapping', observedAt: receipt.observedAt, evidenceLevel: receipt.evidenceLevel, contentDigest: receipt.assertionDigest,
    subjects: [{ object: ref, digest: digest(record.properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: '来源对两个固定实体版本的判断；不合并对象、不继承库存价格、不授予权限' } };
  assertIdentityAssertionWrite(graph, owner, record, source);
  graph.ingest(owner, { objects: [record, sealed], links: [...links, { type: 'EntityIdentityAssertionEvidence', from: ref, to: receiptObject }] }, source);
  return ref;
}

/** Also call from the central ingestion boundary for this concrete type. */
export function assertIdentityAssertionWrite(graph: OntologyObjectStore, owner: string, object: ObjectWrite, source: ObjectSource): void {
  if (object.ref.type !== 'EntityIdentityAssertion') return;
  const assertion = entityIdentityAssertionSchema.parse(object.properties.assertion);
  if (assertion.ownerDigest !== digest(owner) || !['synthetic', 'provider'].includes(source.kind) || source.id !== assertion.issuerIdentity || source.observedAt !== assertion.observedAt) fail('Identity assertions require a trusted owned source mapping');
  try {
    const old = graph.readPrivate(owner, object.ref);
    if (!same(old.properties, object.properties) || !same(old.source, source)) fail('Identity assertions are immutable; append a source-versioned successor');
  } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
}

export function evaluateIdentityFunction(graph: OntologyObjectStore, owner: string, raw: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (!['entityIdentityBetween', 'entityIdentityStatus'].includes(raw.function)) return;
  const input = z.union(identityFunctionSchemas).parse(raw);
  let left: ObjectRef, right: ObjectRef, kind: z.infer<typeof identityKindSchema>;
  let requested: ObjectRef | undefined;
  if (input.function === 'entityIdentityStatus') {
    const object = graph.read(owner, input.object, budget), assertion = entityIdentityAssertionSchema.parse(object.properties.assertion);
    left = assertion.left.object; right = assertion.right.object; kind = assertion.identityKind; requested = object.ref;
  } else { left = input.object; right = input.other; kind = input.identityKind; }
  graph.read(owner, left, budget); graph.read(owner, right, budget);
  if (left.type !== identityTypes[kind] || right.type !== identityTypes[kind]) throw new DomainError('INVALID_INPUT', 'Identity comparison level does not match both subject types');
  const refs: ObjectRef[] = [left, right], levels: string[] = [], reasons: string[] = [];
  const records = [...(graph.related(owner, left, 'identityAssertionsAsLeft', budget) ?? []), ...(graph.related(owner, left, 'identityAssertionsAsRight', budget) ?? [])];
  const applicable = records.flatMap(record => {
    const parsed = entityIdentityAssertionSchema.safeParse(record.properties.assertion);
    if (!parsed.success) return [];
    const a = parsed.data;
    if (a.identityKind !== kind || !(same(a.left.object, left) && same(a.right.object, right) || same(a.left.object, right) && same(a.right.object, left))) return [];
    return [{ record, a }];
  });
  const states: string[] = [], superseded = new Set(applicable.flatMap(({ a }) => a.supersedes ? [a.supersedes.id] : []));
  for (const { record, a } of applicable) {
    const proof = sourceProof(graph, owner, record.ref, budget); refs.push(record.ref);
    if (!proof || a.ownerDigest !== digest(owner) || !graph.containsLinks(owner, identityAssertionLinks(record.ref, a))) { states.push('unknown'); reasons.push('Assertion source receipt or exact relationships changed'); continue; }
    refs.push(...proof.refs); levels.push(...proof.levels);
    if (superseded.has(record.ref.id)) continue;
    if (Date.parse(a.observedAt) > graph.now()) { states.push('unknown'); reasons.push('Assertion comes from the future'); continue; }
    if (a.lifecycle === 'revoked') { states.push('revoked'); continue; }
    if (Date.parse(a.expiresAt) <= graph.now()) { states.push('expired'); continue; }
    try {
      if (![a.left, a.right].every(endpoint => same(pinIdentityEndpoint(graph, owner, endpoint.object, endpoint.evidenceObject, budget), endpoint))) fail('Endpoint changed');
      states.push(a.relation);
    } catch { states.push('unknown'); reasons.push('An asserted entity version or its source evidence is no longer current'); }
  }
  const determinate = new Set(states.filter(s => ['equivalent', 'different'].includes(s)));
  const status = determinate.size > 1 ? 'conflict' : states.includes('unknown') ? 'unknown' : determinate.size === 1 ? [...determinate][0]!
    : states.includes('revoked') ? 'revoked' : states.includes('expired') ? 'expired' : 'unknown';
  return { status: 'known', value: { status, identityKind: kind, left, right, reasons, ...(requested ? { requestedAssertion: requested, superseded: superseded.has(requested.id) } : {}),
    currentAssertions: applicable.filter(({ record }) => !superseded.has(record.ref.id)).map(({ record }) => record.ref), grantsAuthority: false, mergesObjects: false, transfersTerms: false }, evidenceRefs: refs, evidenceLevels: [...new Set(levels)] };
}
