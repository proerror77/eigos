// Synthetic source history only: no Worker, model, browser, provider or payment.
import { digest } from '../../packages/core/delegation.js';
import { registrationSnapshotSchema } from '../../packages/ontology/free-booking.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite } from '../../packages/ontology/object-store.js';

export function registrationHistory(graph: OntologyObjectStore, count: number) {
  const owner = 'synthetic-history-owner', now = graph.now();
  const observedAt = new Date(now - 1000).toISOString(), expiresAt = new Date(now + 300000).toISOString();
  const request = { type: 'ServiceRequest', id: '10000000-0000-4000-8000-000000000001' }, scope = { type: 'RegistrationTask', id: 'history-scope' };
  const configurationDigest = digest('synthetic-history'), serviceUrl = 'https://luma.com/synthetic-history';
  const source = { kind: 'synthetic' as const, id: 'synthetic-history', observedAt };
  graph.ingest(owner, { objects: [
    { ref: request, properties: { requestId: request.id, displayTitle: 'History request', originalGoal: 'Check current free registration terms', revision: 1, progress: 'executing', createdAt: observedAt } },
    { ref: scope, properties: { id: scope.id, displayTitle: 'History scope', requestRevision: 1, input: { kind: 'event_registration', serviceUrl, completionTarget: 'confirmed', participants: 1, startsAt: null }, bindingDigest: configurationDigest, allowedActions: ['InspectRegistrationPage'] } },
  ], links: [{ type: 'RegistrationTaskRequest', from: scope, to: request }] }, source);
  const refs = Array.from({ length: count }, (_, i) => ({ type: 'RegistrationOffer', id: `offer-${String(i).padStart(6, '0')}` }));
  for (const [i, ref] of refs.entries()) {
    const data = { serviceUrl, title: 'Synthetic event', kind: 'event_registration', startsAt: new Date(now + 86400000).toISOString(), endsAt: new Date(now + 90000000).toISOString(), timeZone: 'Asia/Shanghai', participants: 1, attendeeRef: digest(owner),
      payment: { requirement: 'not_required', total: { minor: '0', currency: 'CNY' }, feesComplete: true }, termsRef: 'synthetic-terms',
      availability: 'available', alreadyRegistered: false, requiresApproval: false, requiresAdditionalConsent: false, observedAt, expiresAt };
    const payload = { type: ref.type, data, sourceId: serviceUrl, sourceVersion: i + 1, expiresAt };
    const body = { payload, receipt: { id: digest(ref), ownerDigest: digest(owner), requestId: request.id, requestRevision: 1, action: 'InspectRegistrationPage', planId: 'synthetic-plan', intentId: 'synthetic-intent', attemptId: digest(ref), modelRunId: 'synthetic-run', operationKey: digest(ref), readbackSequence: 0,
      sourceIdentity: source.id, method: 'GET', path: '/synthetic', status: 200, responseSha256: digest(payload), payloadDigest: digest(payload), signature: digest(ref), startedAt: observedAt, receivedAt: observedAt },
      evidenceLevel: 'synthetic', browserEvidence: { pageUrl: serviceUrl, snapshotSha256: digest(data), screenshotSha256: digest(data), observedAt }, scope, configurationDigest };
    const snapshot = registrationSnapshotSchema.parse({ ...body, contentDigest: digest(body) });
    const object: ObjectWrite = { ref, properties: { id: ref.id, displayTitle: data.title, requestRevision: 1, data, snapshot } };
    const receipt = { type: 'SourceReceipt', id: `receipt-${ref.id}` };
    const links: LinkWrite[] = [{ type: 'RegistrationOfferRequest', from: ref, to: request }, { type: 'RegistrationOfferTask', from: ref, to: scope }];
    const proof: ObjectWrite = { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Synthetic receipt', safeSummary: 'Synthetic history only', sourceIdentity: source.id, sourceEventId: snapshot.receipt.id, scope: 'reservation', observedAt, evidenceLevel: 'synthetic', contentDigest: digest(payload),
      subjects: [{ object: ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(ref, links) }] } };
    graph.ingest(owner, { objects: [object, proof], links: [...links, { type: 'RegistrationOfferEvidence', from: ref, to: receipt }, { type: 'ReceiptRequest', from: receipt, to: request }] }, source);
  }
  return { owner, request, scope, refs, source };
}
