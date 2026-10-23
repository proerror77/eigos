import type { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentActionContext } from '../core/agent-program.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import { sourceProof } from './object-evidence.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ReadBudget, type ObjectWrite, type LinkWrite } from './object-store.js';
import type { Computation } from './object-functions.js';
import { registrationSnapshotSchema as snapshotSchema, registrationPaymentSchema, registrationInputSchema, registrationOfferSchema, registrationRecordSchema, registrationEntities, type RegistrationData, type RegistrationSnapshot, type RegistrationResult } from './free-booking.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export function isFreeRegistration(value: { payment: z.infer<typeof registrationPaymentSchema> }) {
  return value.payment.requirement === 'not_required' && value.payment.total.minor === '0' && value.payment.feesComplete;
}
export function readRegistration(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget: ReadBudget = { remaining: 5000 }, options: { historical?: boolean } = {}): RegistrationSnapshot {
  if (!Object.hasOwn(registrationEntities, ref.type)) fail('Expected registration source evidence');
  const object = graph.read(owner, ref, budget), s = snapshotSchema.parse(object.properties.snapshot), { contentDigest, ...body } = s;
  const data = registrationEntities[s.payload.type].parse(s.payload.data);
  const proof = sourceProof(graph, owner, ref, budget), scopeObject = graph.read(owner, s.scope, budget);
  const scopes = graph.related(owner, ref, 'task', budget), requests = graph.related(owner, ref, 'request', budget);
  if (digest(body) !== contentDigest || s.payload.type !== ref.type || digest(object.properties.data) !== digest(s.payload.data) || s.receipt.payloadDigest !== digest(s.payload) || s.receipt.ownerDigest !== digest(owner) || scopeObject.properties.bindingDigest !== s.configurationDigest || scopeObject.properties.requestRevision !== s.receipt.requestRevision || !proof || proof.levels.some(level => level !== s.evidenceLevel) || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope) || requests?.length !== 1 || requests[0]!.ref.id !== s.receipt.requestId || requests[0]!.properties.revision !== s.receipt.requestRevision) fail('Registration evidence changed or belongs to another participant task');
  const at = options.historical ? Date.parse(s.receipt.receivedAt) : graph.now();
  const request = registrationInputSchema.parse(scopeObject.properties.input);
  if (data.serviceUrl !== request.serviceUrl || data.kind !== request.kind || data.participants !== request.participants || request.startsAt && Date.parse(data.startsAt) !== Date.parse(request.startsAt) || request.endsAt && Date.parse(data.endsAt) !== Date.parse(request.endsAt) || Date.parse(data.endsAt) <= Date.parse(data.startsAt) || s.browserEvidence.pageUrl !== request.serviceUrl || Date.parse(s.payload.expiresAt) <= at || Date.parse(data.observedAt) > at || Date.parse(s.browserEvidence.observedAt) !== Date.parse(data.observedAt) || Date.parse(s.receipt.startedAt) > Date.parse(s.receipt.receivedAt) || Date.parse(data.observedAt) > Date.parse(s.receipt.receivedAt)) fail('Registration source does not match the requested event, time or freshness');
  for (const other of graph.related(owner, s.scope, `${s.payload.type}Observations`, budget) ?? []) {
    if (digest(other.ref) === digest(ref)) continue;
    const newer = snapshotSchema.parse(other.properties.snapshot);
    if (newer.payload.sourceId === s.payload.sourceId && newer.payload.sourceVersion > s.payload.sourceVersion && Date.parse(newer.receipt.receivedAt) <= at && sourceProof(graph, owner, other.ref, budget)) fail('A newer participant source observation supersedes this state');
  }
  return s;
}
export function registrationStatus(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget?: ReadBudget) {
  const s = readRegistration(graph, owner, ref, budget);
  if (s.payload.type === 'RegistrationOffer') {
    const data = registrationOfferSchema.parse(s.payload.data);
    return { status: 'known', free: isFreeRegistration(data), canSubmit: isFreeRegistration(data) && data.availability === 'available' && !data.alreadyRegistered && !data.requiresAdditionalConsent && Date.parse(data.expiresAt) > graph.now(), data, evidenceLevel: s.evidenceLevel };
  }
  const data = registrationRecordSchema.parse(s.payload.data), independent = data.independentRead && s.receipt.action === 'ReadParticipantRegistration';
  const hasSubmission = ['submitted', 'pending_approval', 'waitlisted', 'confirmed'].includes(data.state) && !!data.submittedAt && Date.parse(data.submittedAt) <= graph.now();
  const confirmed = independent && data.state === 'confirmed' && !!data.confirmationReference && !!data.confirmedAt && Date.parse(data.confirmedAt) <= graph.now();
  return { status: data.state, free: isFreeRegistration(data), independentRead: independent, submitted: independent && hasSubmission, confirmed, data, evidenceLevel: s.evidenceLevel };
}
export function evaluateRegistrationFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'registrationStatus') return;
  try { const result = registrationStatus(graph, owner, input.object, budget); return { status: 'known', value: result, evidenceRefs: [input.object], evidenceLevels: [result.evidenceLevel] }; }
  catch (error) { return { status: 'unknown', reason: error instanceof DomainError ? error.message : 'Participant source validation failed', evidenceRefs: [input.object], evidenceLevels: [] }; }
}
export function projectRegistration(ctx: AgentActionContext, action: string, result: RegistrationResult): ObjectRef {
  const receipt = result.receipt;
  if (receipt.ownerDigest !== digest(ctx.owner) || receipt.requestId !== ctx.request.id || receipt.requestRevision !== ctx.request.revision || receipt.planId !== ctx.planId || receipt.intentId !== ctx.intentId || receipt.attemptId !== ctx.attemptId || receipt.modelRunId !== ctx.modelRunId || receipt.operationKey !== ctx.operationKey || receipt.action !== action || receipt.payloadDigest !== digest(result.payload)) fail('Registration receipt is outside the current owned attempt');
  const data = registrationEntities[result.payload.type].parse(result.payload.data);
  if (result.payload.type === 'RegistrationRecord' && (data as RegistrationData).independentRead !== (action === 'ReadParticipantRegistration')) fail('Submission is not an independent registration read');
  const base = { ...result, scope: ctx.state.scope, configurationDigest: ctx.state.programDigest }, snapshot = { ...base, contentDigest: digest(base) };
  const ref = { type: result.payload.type, id: digest({ scope: ctx.state.scope, receipt: receipt.id }) }, root = { type: 'ServiceRequest', id: ctx.request.id };
  const object: ObjectWrite = { ref, properties: { id: ref.id, displayTitle: data.title, requestRevision: ctx.request.revision, data: result.payload.data, snapshot } };
  const links: LinkWrite[] = [{ type: `${ref.type}Request`, from: ref, to: root }, { type: `${ref.type}Task`, from: ref, to: ctx.state.scope }];
  const source = { type: 'SourceReceipt', id: digest({ ref, receipt: receipt.id }) };
  const proof: ObjectWrite = { ref: source, properties: { receiptId: source.id, displayTitle: '参与者报名来源回读', sourceIdentity: receipt.sourceIdentity, sourceEventId: receipt.id, scope: 'reservation', observedAt: receipt.receivedAt, evidenceLevel: result.evidenceLevel, contentDigest: receipt.responseSha256, subjects: [{ object: ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: result.evidenceLevel === 'synthetic' ? '合成报名来源；不是实际参加资格' : '本机授权浏览器观察；来源网页状态与任务提交回执分别记录' } };
  links.push({ type: `${ref.type}Evidence`, from: ref, to: source }, { type: 'ReceiptRequest', from: source, to: root });
  ctx.graph.ingest(ctx.owner, { objects: [object, proof], links }, { kind: result.evidenceLevel === 'synthetic' ? 'synthetic' : 'provider', id: receipt.sourceIdentity, observedAt: receipt.receivedAt });
  readRegistration(ctx.graph, ctx.owner, ref);
  return ref;
}
