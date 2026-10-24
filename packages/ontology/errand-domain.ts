import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ObjectRef } from './model.js';
import { linkSnapshotDigest, type ObjectWrite, type ObjectSource, type LinkWrite, type OntologyObjectStore, type ReadBudget } from './object-store.js';
import type { Computation } from './object-functions.js';
import { sourceProof } from './object-evidence.js';

import { transactionPartyRoleSchema, errandConstraintsSchema, errandQuoteCommitmentsSchema, errandFunctionSchemas, transactionPartyRoleRefSchema as roleRef, type TransactionPartyRole } from './errand-model.js';
export * from './errand-model.js';

const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), time = z.iso.datetime({ offset: true });
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export function pinTransactionRoleObject(graph: OntologyObjectStore, owner: string, object: ObjectRef) {
  const value = graph.read(owner, object);
  return { object, revision: value.revision, propertiesDigest: digest(value.properties), linksDigest: graph.relationshipDigest(owner, object, { remaining: 1000 }) };
}
export function transactionPartyRoleLinks(ref: ObjectRef, assignment: TransactionPartyRole): LinkWrite[] {
  return [{ type: 'TransactionRoleScope', from: ref, to: assignment.scope.object }, { type: 'TransactionRoleParty', from: ref, to: assignment.party.object },
    ...(assignment.participation ? [{ type: 'TransactionRoleParticipation', from: ref, to: assignment.participation.object }] : []),
    ...(assignment.supersedes ? [{ type: 'TransactionRolePredecessor', from: ref, to: assignment.supersedes }] : [])];
}
const roleSource = z.strictObject({ sourceIdentity: text, sourceEventId: text, assignmentDigest: sha, observedAt: time, evidenceLevel: z.enum(['synthetic', 'user_asserted', 'provider_test', 'live_readonly', 'live_operation']) });
function validateAssignment(graph: OntologyObjectStore, owner: string, assignment: TransactionPartyRole) {
  if (assignment.ownerDigest !== digest(owner)) fail('Party assignment belongs to a different owner');
  for (const endpoint of [assignment.scope, assignment.party, ...(assignment.participation ? [assignment.participation] : [])]) {
    graph.read(owner, endpoint.object);
    if (assignment.state === 'assigned' && !same(pinTransactionRoleObject(graph, owner, endpoint.object), endpoint)) fail('Party role scope or participant version changed');
  }
  if (assignment.participation && assignment.state === 'assigned') {
    const participation = graph.read(owner, assignment.participation.object), providers = graph.related(owner, participation.ref, 'provider', { remaining: 1000 });
    if (providers?.length !== 1 || !same(providers[0]!.ref, assignment.party.object) || participation.properties.role !== assignment.role
      || !participation.properties.validUntil || Date.parse(String(participation.properties.validUntil)) <= graph.now()) fail('Channel participation does not support this exact party role');
  }
}
/** Trusted source/selected-contact mapper only. No public import or new action is
 * installed. User contact selections remain user_asserted in the receipt. */
export function projectTransactionPartyRole(graph: OntologyObjectStore, owner: string, raw: unknown, rawSource: unknown): z.infer<typeof roleRef> {
  const assignment = transactionPartyRoleSchema.parse(raw), receipt = roleSource.parse(rawSource);
  validateAssignment(graph, owner, assignment);
  if (receipt.assignmentDigest !== digest(assignment) || receipt.sourceIdentity !== assignment.issuerIdentity || receipt.observedAt !== assignment.observedAt || Date.parse(receipt.observedAt) > graph.now()) fail('Role source receipt differs from the exact assignment');
  if (receipt.evidenceLevel === 'user_asserted' && !['sender', 'receiver'].includes(assignment.role)) fail('User contact selection cannot prove seller, fulfiller or courier responsibility');
  const ref = { type: 'TransactionPartyRole' as const, id: digest({ owner, issuer: receipt.sourceIdentity, event: receipt.sourceEventId }) }, links = transactionPartyRoleLinks(ref, assignment);
  if (assignment.supersedes) {
    const old = transactionPartyRoleSchema.parse(graph.read(owner, assignment.supersedes).properties.assignment);
    if (old.issuerIdentity !== assignment.issuerIdentity || old.role !== assignment.role || !same(old.scope.object, assignment.scope.object) || old.sourceVersion >= assignment.sourceVersion || Date.parse(old.observedAt) > Date.parse(assignment.observedAt)
      || assignment.state === 'revoked' && (!same(old.scope, assignment.scope) || !same(old.party, assignment.party))) fail('Role successor must advance its original source assignment');
    if ((graph.related(owner, assignment.supersedes, 'successors', { remaining: 1000 }) ?? []).some(value => !same(value.ref, ref))) fail('Party assignment history cannot fork');
  }
  const object: ObjectWrite = { ref, properties: { id: ref.id, displayTitle: `明确范围的 ${assignment.role} 角色`, assignment } }, receiptObject = { type: 'SourceReceipt', id: `role:${ref.id}` };
  const source: ObjectSource = { kind: receipt.evidenceLevel === 'user_asserted' ? 'user' : receipt.evidenceLevel === 'synthetic' ? 'synthetic' : 'provider', id: receipt.sourceIdentity, observedAt: receipt.observedAt };
  assertTransactionPartyRoleWrite(graph, owner, object, source);
  graph.ingest(owner, { objects: [object, { ref: receiptObject, properties: { receiptId: receiptObject.id, displayTitle: '交易角色来源回执', sourceIdentity: receipt.sourceIdentity, sourceEventId: receipt.sourceEventId,
    scope: 'party_role', observedAt: receipt.observedAt, evidenceLevel: receipt.evidenceLevel, contentDigest: receipt.assignmentDigest,
    subjects: [{ object: ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: '明确业务范围的角色与来源；本人选择的收发联系人保留声明级别，不推定履约权限' } }],
    links: [...links, { type: 'TransactionPartyRoleEvidence', from: ref, to: receiptObject }] }, source);
  return ref;
}
export function assertTransactionPartyRoleWrite(graph: OntologyObjectStore, owner: string, object: ObjectWrite, source: ObjectSource) {
  if (object.ref.type !== 'TransactionPartyRole') return;
  const assignment = transactionPartyRoleSchema.parse(object.properties.assignment);
  if (assignment.ownerDigest !== digest(owner) || source.id !== assignment.issuerIdentity || source.observedAt !== assignment.observedAt || source.kind === 'task' || source.kind === 'user' && !['sender', 'receiver'].includes(assignment.role)) fail('Party assignments require an owned valid source or explicit contact selection');
  try { const old = graph.readPrivate(owner, object.ref); if (!same(old.properties, object.properties) || !same(old.source, source)) fail('Party roles are immutable; append a source-versioned successor'); }
  catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
}
export function compareErrandConstraints(actual: unknown, requested: unknown) {
  const constraints = errandConstraintsSchema.parse(requested), source = errandQuoteCommitmentsSchema.safeParse(actual);
  if (constraints.serviceType !== 'parcel_delivery') return { status: 'unsupported' as const, missing: [], different: ['serviceType'] };
  if (!source.success) return { status: 'unknown' as const, missing: ['errandCommitments'], different: [] };
  const missing: string[] = [], different: string[] = [];
  const compare = (wanted: Record<string, unknown>, found: Record<string, unknown>, prefix = '') => {
    for (const [key, value] of Object.entries(wanted)) {
      const path = `${prefix}${key}`;
      if (found[key] === undefined) missing.push(path);
      else if (value && typeof value === 'object' && !Array.isArray(value)) compare(value as Record<string, unknown>, found[key] as Record<string, unknown>, `${path}.`);
      else if (!same(value, found[key])) different.push(path);
    }
  };
  compare(constraints, source.data);
  return { status: different.length ? 'different' as const : missing.length ? 'unknown' as const : 'matches' as const, missing, different };
}
export function evaluateErrandFunction(graph: OntologyObjectStore, owner: string, raw: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (!['errandQuoteMatches', 'transactionRoleStatus'].includes(raw.function)) return;
  const input = z.union(errandFunctionSchemas).parse(raw), object = graph.read(owner, input.object, budget);
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  if (input.function === 'errandQuoteMatches') {
    const proof = sourceProof(graph, owner, object.ref, budget);
    if (!proof || !object.properties.expiresAt || Date.parse(String(object.properties.expiresAt)) <= graph.now()) return unknown('Errand quote source is missing, changed or expired');
    const requests = graph.related(owner, object.ref, 'request', budget), parcels = graph.related(owner, object.ref, 'parcel', budget), routes = graph.related(owner, object.ref, 'route', budget);
    if (requests?.length !== 1 || parcels?.length !== 1 || routes?.length !== 1 || requests[0]!.properties.revision !== object.properties.requestRevision
      || parcels[0]!.revision !== object.properties.parcelRevision || routes[0]!.revision !== object.properties.routeRevision) return unknown('Quote does not bind the current request, parcel and route versions');
    const selected = graph.related(owner, requests[0]!.ref, 'selectedRoute', budget);
    if (selected?.length !== 1 || !same(selected[0]!.ref, routes[0]!.ref)) return unknown('Quote route is no longer selected');
    const comparison = compareErrandConstraints(object.properties.errandCommitments, input.constraints);
    if (comparison.status === 'unknown') return unknown(`Requested parcel handling is unproven: ${comparison.missing.join(', ')}`);
    return { status: 'known', value: { matches: comparison.status === 'matches', ...comparison, binding: 'read_only_delivery_preview', grantsAuthority: false, provesFulfillment: false }, evidenceRefs: [object.ref, ...proof.refs], evidenceLevels: proof.levels };
  }
  const assignment = transactionPartyRoleSchema.parse(object.properties.assignment), receipts = graph.related(owner, object.ref, 'sourceReceipts', budget);
  if (receipts?.length !== 1) return unknown('Scoped role source receipt is missing or ambiguous');
  const receipt = receipts[0]!, expectedLinks = transactionPartyRoleLinks(object.ref, assignment), subjects = receipt.properties.subjects as { object: ObjectRef; digest: string; linksDigest: string }[];
  if (receipt.properties.scope !== 'party_role' || receipt.properties.contentDigest !== digest(assignment) || receipt.properties.sourceIdentity !== assignment.issuerIdentity
    || receipt.properties.observedAt !== assignment.observedAt || !receipt.properties.sourceEventId || !Array.isArray(subjects)
    || !subjects.some(s => same(s.object, object.ref) && s.digest === digest(object.properties) && s.linksDigest === graph.relationshipDigest(owner, object.ref, budget))
    || !graph.containsLinks(owner, expectedLinks)) return unknown('Scoped role source facts or exact relationships changed');
  if (receipt.properties.evidenceLevel === 'user_asserted' ? receipt.source.kind !== 'user' || object.source.kind !== 'user' : !sourceProof(graph, owner, object.ref, budget)) return unknown('Scoped role evidence is not a valid source mapping');
  const successors = graph.related(owner, object.ref, 'successors', budget) ?? [];
  if (successors.length) return { status: 'known', value: { status: 'superseded', successors: successors.map(value => value.ref), grantsAuthority: false }, evidenceRefs: [object.ref, receipt.ref, ...successors.map(value => value.ref)], evidenceLevels: [String(receipt.properties.evidenceLevel)] };
  try { validateAssignment(graph, owner, assignment); } catch { return unknown('Role scope or party version changed; require a new exact source assignment'); }
  if (Date.parse(assignment.observedAt) > graph.now()) return unknown('Role assignment is from the future');
  const status = assignment.state === 'revoked' ? 'revoked' : Date.parse(assignment.expiresAt) <= graph.now() ? 'expired' : receipt.properties.evidenceLevel === 'user_asserted' ? 'declared' : 'assigned';
  if (receipt.properties.evidenceLevel === 'user_asserted' && !['sender', 'receiver'].includes(assignment.role)) return unknown('User declarations cannot establish commercial responsibility');
  return { status: 'known', value: { status, role: assignment.role, scope: assignment.scope, party: assignment.party, grantsAuthority: false }, evidenceRefs: [object.ref, receipt.ref, assignment.scope.object, assignment.party.object], evidenceLevels: [String(receipt.properties.evidenceLevel)] };
}
