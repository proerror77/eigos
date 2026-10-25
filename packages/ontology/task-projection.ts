import { z } from 'zod';
import type { Job } from '../core/domain.js';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { BACKEND_VERSION } from './execution.js';
import { ontologyReceiptSchema } from '../capabilities/paotui-legacy-receipt.js';
import { paotuiPublicPlaceSchema } from '../capabilities/paotui-public-locations.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectBatch, type ObjectWrite, type ObjectSource } from './object-store.js';
import type { ObjectRef } from './model.js';
import { projectDomainSnapshot } from './domain-projection.js';
import { projectCheckoutRequest, projectCommerceSnapshot } from './commerce-projection.js';
import { projectCatalogRead } from './catalog-projection.js';
import { prepareSituationAssessment, projectSituation } from './situation-projection.js';

function upsert(graph: OntologyObjectStore, owner: string, type: string, id: string, values: Record<string, unknown>): ObjectWrite {
  const ref = { type, id }; let expectedRevision: number | undefined;
  try { expectedRevision = graph.read(owner, ref).revision; } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
  const definition = graph.model.object(type);
  return { ref, properties: { [definition.primaryKey]: id, displayTitle: String(values.name ?? values.safeSummary ?? id).slice(0, 500), ...values }, ...(expectedRevision ? { expectedRevision } : {}) };
}

/** A read projection of the one current backend. No migration or execution of historical tasks. */
export function projectTask(graph: OntologyObjectStore, owner: string, job: Job): void {
  if (job.delegation?.backendVersion !== BACKEND_VERSION || job.service !== 'eigos.delegate') return;
  const request = job.delegation.request;
  const progress: Record<Job['state'], string> = { submitted: 'received', working: 'executing', 'input-required': 'clarifying', 'auth-required': 'awaiting_authorization', completed: 'accepted', failed: 'unmet', rejected: 'unmet', canceled: 'canceled' };
  if (job.delegation.outcome?.status === 'unknown' || job.delegation.outcome?.status === 'needs_human') progress.failed = 'needs_review';
  const d = job.delegation, outcome = d.outcome;
  const assessmentRef = outcome ? { type: 'OutcomeAssessment', id: digest({ request: request.id, outcome, state: job.state, coverage: d.goalCoverage?.requestRevision === request.revision ? d.goalCoverage.digest : null }) } : undefined;
  const situation = d.situation ? prepareSituationAssessment(job, d.situation) : undefined;
  const values = { originalGoal: request.originalGoal, ...(request.conditions?.length ? { conditions: request.conditions } : {}), revision: request.revision, requestedOutcome: d.agent?.programRef.id ?? d.plan?.capabilityRef.id ?? (d.goalCoverage?.requestRevision === request.revision ? d.goalCoverage.capabilityRef.id : undefined) ?? d.resolution?.scope.capabilityRef.id ?? 'unresolved', progress: progress[job.state], createdAt: job.createdAt, ...(assessmentRef ? { currentAssessment: assessmentRef } : {}), ...(request.monitoring ? { monitoring: request.monitoring } : {}), ...(situation ? { currentSituation: situation.ref } : {}) };
  const source: ObjectSource = { kind: 'task', id: request.id, observedAt: job.updatedAt };
  const saveRequest = (projectionState: string) => {
    const object = upsert(graph, owner, 'ServiceRequest', job.id, { ...values, projectionState });
    // Recording a reasoning receipt does not change a business request or invalidate its cursor.
    if (object.expectedRevision && digest(graph.read(owner, object.ref).properties) === digest(object.properties)) return;
    graph.ingest(owner, { objects: [object] }, source);
  };
  let previousProjection = 'request_only';
  try {
    const previous = graph.read(owner, { type: 'ServiceRequest', id: request.id }).properties;
    if (previous.revision === request.revision) previousProjection = String(previous.projectionState ?? 'request_only');
  } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
  saveRequest(previousProjection);
  if (situation) projectSituation(graph, owner, job, situation);
  const root = { type: 'ServiceRequest', id: request.id };
  if (d.paQuestion) {
    const question = d.paQuestion.question, ref = { type: 'PAQuestion', id: question.id };
    const object = upsert(graph, owner, ref.type, ref.id, { requestRevision: question.requestRevision, questionDigest: question.digest, question });
    if (!object.expectedRevision) graph.ingest(owner, { objects: [object], links: [{ type: 'PAQuestionTask', from: ref, to: root }] }, source);
  }
  const coverage = d.goalCoverage;
  const coverageRef = coverage ? { type: 'GoalCoverage', id: coverage.digest } : undefined;
  const unchanged = (object: ObjectWrite) => !!object.expectedRevision && digest(graph.read(owner, object.ref).properties) === digest(object.properties);
  if (coverage && coverageRef) {
    const object = upsert(graph, owner, coverageRef.type, coverageRef.id, {
      requestRevision: coverage.requestRevision, requestDigest: coverage.requestDigest, capabilityRef: coverage.capabilityRef, capabilityDigest: coverage.capabilityDigest,
      input: coverage.input, inputDigest: coverage.inputDigest, review: coverage.review, modelRunId: coverage.modelRunId, assessedAt: coverage.assessedAt, digest: coverage.digest,
    });
    if (!unchanged(object)) graph.ingest(owner, { objects: [object], links: [{ type: 'GoalCoverageRequest', from: coverageRef, to: root }] }, { ...source, observedAt: coverage.assessedAt });
  }
  if (outcome && assessmentRef) {
    const assessment = upsert(graph, owner, assessmentRef.type, assessmentRef.id, { requestRevision: outcome.requestRevision, judgment: outcome.status,
      assessedAt: outcome.assessedAt, reason: outcome.reason, taskState: job.state, evidenceLevel: outcome.evidenceLevel ?? 'unverified', evidenceRefs: outcome.evidenceRefs,
      criterionResults: outcome.criterionResults.map(c => ({ criterion: c.requirementId, result: c.status === 'satisfied' ? 'pass' : c.status === 'unsatisfied' ? 'fail' : c.status, evidenceIds: c.evidenceRefs })) });
    const bindingRef = d.agent?.programRef ?? d.plan?.bindingRef;
    const feedback = bindingRef ? upsert(graph, owner, 'ExecutionFeedback', digest({ request: request.id, revision: request.revision, bindingRef }), {
      requestRevision: request.revision, bindingRef, bindingDigest: d.agent?.programDigest ?? digest(d.plan!.bindingDigests), taskState: job.state,
      judgment: outcome.status, evidenceLevel: outcome.evidenceLevel ?? 'unverified', evidenceRefs: outcome.evidenceRefs, observedAt: outcome.assessedAt,
    }) : undefined;
    // Reading/recording another model receipt does not change the assessment.
    // Avoid revalidating the entire relationship graph on every such checkpoint.
    if (!unchanged(assessment) || feedback && !unchanged(feedback)) {
      const sourceReceipts = outcome.evidenceRefs.length ? (graph.related(owner, root, 'sourceReceipts', { remaining: 5000 }) ?? []).filter(receipt => outcome.evidenceRefs.includes(receipt.ref.id) || outcome.evidenceRefs.includes(String(receipt.properties.sourceEventId))) : [];
      const links = [{ type: 'AssessmentRequest', from: assessmentRef, to: root }, ...(coverageRef && coverage?.requestRevision === request.revision ? [{ type: 'AssessmentCoverage', from: assessmentRef, to: coverageRef }] : []), ...sourceReceipts.map(receipt => ({ type: 'AssessmentEvidence', from: assessmentRef, to: receipt.ref }))];
      const old = feedback?.expectedRevision ? graph.related(owner, feedback.ref, 'assessment', { remaining: 1000 }) ?? [] : [];
      graph.ingest(owner, { objects: [assessment, ...(feedback ? [feedback] : [])],
        links: [...links, ...(feedback ? [{ type: 'ExecutionFeedbackRequest', from: feedback.ref, to: root }, { type: 'ExecutionFeedbackAssessment', from: feedback.ref, to: assessmentRef }] : [])],
        removeLinks: feedback ? old.filter(o => o.ref.id !== assessmentRef.id).map(o => ({ type: 'ExecutionFeedbackAssessment', from: feedback.ref, to: o.ref })) : [],
      }, { ...source, observedAt: outcome.assessedAt });
    }
  }
  if (d.agent?.observations.length) saveRequest('typed_result');
  if (job.state !== 'completed' || !job.artifact?.data.result) return;
  const plan = job.delegation.plan;
  const projected = projectReadResult(graph, owner, { request, capabilityId: plan?.capabilityRef.id ?? '', input: plan?.steps[0]?.input ?? {}, preparedReceipt: plan?.details.ontologyReceipt, result: job.artifact.data.result });
  if (projected.state !== 'request_only') saveRequest(projected.state);
}

export interface PreparedObjectRead {
  request: { id: string; revision: number }; capabilityId: string; input: Record<string, unknown>;
  preparedReceipt: unknown; result: unknown;
}
/** A verified read can inform planning before any business decision or completion. */
export function projectReadResult(graph: OntologyObjectStore, owner: string, read: PreparedObjectRead): { state: 'request_only' | 'typed_result' | 'invalid_source'; subject?: ObjectRef } {
  const request = read.request;
  if (!read.result || typeof read.result !== 'object') return { state: 'request_only' };
  const result = read.result as Record<string, unknown>;
  if (result.catalogSnapshot !== undefined) return projectCatalogRead(graph, owner, request, read.capabilityId, read.input, result.catalogSnapshot);
  let checkoutRequest: ObjectRef | undefined;
  if (result.checkoutRequest !== undefined) checkoutRequest = projectCheckoutRequest(graph, owner, request, result.checkoutRequest);
  if (result.ucpSnapshot !== undefined) return projectCommerceSnapshot(graph, owner, request, read.capabilityId, read.input, result.ucpSnapshot);
  if (checkoutRequest) return { state: 'typed_result', subject: checkoutRequest };
  if (result.domainSnapshot !== undefined) return projectDomainSnapshot(graph, owner, read.capabilityId, request, read.input, result.domainSnapshot);
  const parsed = ontologyReceiptSchema.safeParse(result.ontologyReceipt);
  if (!parsed.success) return { state: result.ontologyReceipt !== undefined ? 'invalid_source' : 'request_only' };
  const receipt = parsed.data, { ontologyReceipt: _receipt, ...business } = result;
  if (!['geo.search', 'delivery.quote'].includes(receipt.capabilityRef.id)) return { state: 'request_only' };
  const prepared = ontologyReceiptSchema.safeParse(read.preparedReceipt);
  if (read.capabilityId !== receipt.capabilityRef.id || !prepared.success
      || prepared.data.inputDigest !== receipt.inputDigest || prepared.data.evidenceKind !== receipt.evidenceKind || !/^[a-f0-9]{64}$/.test(receipt.inputDigest)
      || receipt.resultDigest !== digest(business) || receipt.tool !== (receipt.capabilityRef.id === 'geo.search' ? 'ontology_geo_search' : 'ontology_delivery_quote')) { return { state: 'invalid_source' }; }
  const objects: ObjectWrite[] = [], links: NonNullable<ObjectBatch['links']> = [], evidenceSubjects: { object: ObjectRef; digest: string }[] = [];
  const receiptRef = { type: 'SourceReceipt', id: receipt.id };
  const evidenceLevel = receipt.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly';
  const readSource: ObjectSource = { kind: evidenceLevel === 'synthetic' ? 'synthetic' : 'provider', id: receipt.id, observedAt: receipt.observedAt };
  const add = (type: string, id: string, properties: Record<string, unknown>, evidenced = false) => {
    const object = upsert(graph, owner, type, id, properties); objects.push(object);
    if (evidenced) { evidenceSubjects.push({ object: object.ref, digest: digest(object.properties) }); links.push({ type: `${type}Evidence`, from: object.ref, to: receiptRef }); }
    return object.ref;
  };
  let quoteRef: ObjectRef | undefined, routeRef: ObjectRef | undefined;
  const projectedRevision = (ref: ObjectRef) => {
    const next = objects.find(o => o.ref.id === ref.id && o.ref.type === ref.type)!;
    if (!next.expectedRevision) return 1;
    const old = graph.read(owner, ref);
    return old.revision + (digest(old.properties) === digest(next.properties) && digest(old.source) === digest(readSource) ? 0 : 1);
  };
  try {
    if (receipt.capabilityRef.id === 'geo.search') {
      if (business.source !== 'meituan' || business.readOnly !== true || digest(receipt.sourceCalls) !== digest(['search_poi'])) throw new DomainError('INVALID_INPUT', 'Invalid public read');
      const places = z.array(paotuiPublicPlaceSchema).max(100).parse(business.places);
      for (const [i, place] of places.entries()) {
        const native = place.poiId ?? place.id;
        add('Place', digest({ namespace: 'meituan:poi', native, ...(native === undefined ? { receipt: receipt.id, index: i } : {}) }), {
          name: place.name, ...(place.address ? { address: { text: place.address, ...(place.city ? { city: place.city } : {}) } } : {}),
          ...(place.lat !== undefined && place.lng !== undefined ? { coordinates: { lat: place.lat, lng: place.lng }, coordinateUnit: 'degree', coordinateSystem: 'unknown' } : {}),
        }, true);
      }
    } else {
      const quote = z.object({ source: z.literal('meituan'), previewOnly: z.literal(true), orderCreated: z.literal(false), goods: z.object({ name: z.string(), category: z.string(), weightKg: z.number().positive() }), service: z.enum(['ordinary', 'express']), route: z.object({ sender: z.string().min(1), recipient: z.string().min(1) }), quote: z.object({ _previewTotal: z.union([z.string(), z.number().finite().nonnegative()]).transform(String).pipe(z.string().regex(/^\d+(?:\.\d{1,2})?$/)) }) }).parse(business);
      if (!receipt.sourceCalls.includes('delivery_preview') || receipt.sourceCalls.some(c => !['get_address_info', 'get_address_list', 'delivery_preview'].includes(c))) throw new DomainError('INVALID_INPUT', 'Invalid quote read');
      const input = read.input;
      const parcel = add('Parcel', `parcel-${receipt.id}`, { contentsCategory: quote.goods.category, declaredContents: quote.goods.name, ...(typeof input?.weightKg === 'number' ? { declaredWeight: { amount: String(input.weightKg), unit: 'kg' } } : {}) });
      routeRef = add('DeliveryRoute', `route-${receipt.id}`, { originSnapshot: { text: quote.route.sender }, destinationSnapshot: { text: quote.route.recipient }, selectedAt: receipt.observedAt });
      const provider = add('Provider', 'meituan-paotui', { name: '美团跑腿' }), channel = add('Channel', 'meituan', { name: '美团个人只读渠道', accessScope: ['read'], supportedOperationRefs: ['delivery_preview'] });
      const [whole, fraction = ''] = quote.quote._previewTotal.split('.');
      quoteRef = add('DeliveryQuote', receipt.id, { observedAt: receipt.observedAt, expiresAt: new Date(Date.parse(receipt.observedAt) + 300000).toISOString(), validityBasis: 'local_refresh_limit', priceKind: 'estimate', pricingCompleteness: 'unknown', serviceLevel: quote.service, quotedWeight: { amount: String(quote.goods.weightKg), unit: 'kg' }, requestRevision: request.revision,
        parcelRevision: projectedRevision(parcel), routeRevision: projectedRevision(routeRef),
        pricingTerms: { total: { minor: (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))).toString(), currency: 'CNY' }, scope: 'unknown', components: [] } }, true);
      for (const [type, from, to] of [['ParcelRequest', parcel, { type: 'ServiceRequest', id: request.id }], ['RouteRequest', routeRef, { type: 'ServiceRequest', id: request.id }], ['QuoteParcel', quoteRef, parcel], ['QuoteRoute', quoteRef, routeRef], ['OfferRequest', quoteRef, { type: 'ServiceRequest', id: request.id }], ['OfferProvider', quoteRef, provider], ['OfferChannel', quoteRef, channel]] as const) links.push({ type, from, to });
    }
    add('SourceReceipt', receipt.id, { sourceIdentity: receipt.server, sourceEventId: receipt.id, observedAt: receipt.observedAt, evidenceLevel, scope: receipt.capabilityRef.id === 'geo.search' ? 'public_locations' : 'delivery_quote', ...(receipt.capabilityRef.id === 'geo.search' && digest(read.input) === receipt.inputDigest ? { queryScope: { city: read.input.city, keyword: read.input.keyword } } : {}), contentDigest: receipt.resultDigest, subjects: evidenceSubjects.map(s => ({ ...s, linksDigest: linkSnapshotDigest(s.object, links) })), safeSummary: `已校验 ${receipt.tool} 只读回执` });
    links.push({ type: 'ReceiptRequest', from: receiptRef, to: { type: 'ServiceRequest', id: request.id } });
    const removeLinks: NonNullable<ObjectBatch['links']> = [];
    if (routeRef) {
      for (const previous of graph.related(owner, { type: 'ServiceRequest', id: request.id }, 'selectedRoute', { remaining: 1000 }) ?? []) {
        if (previous.ref.id !== routeRef.id) removeLinks.push({ type: 'SelectedRoute', from: { type: 'ServiceRequest', id: request.id }, to: previous.ref });
      }
      links.push({ type: 'SelectedRoute', from: { type: 'ServiceRequest', id: request.id }, to: routeRef });
    }
    graph.ingest(owner, { objects, links, removeLinks }, readSource);
    return { state: 'typed_result', ...(quoteRef ? { subject: quoteRef } : {}) };
  } catch (error) {
    // Preserve the independently verified task artifact. A rejected projection is
    // explicit and contributes no fabricated business objects or successful reads.
    if (!(error instanceof z.ZodError || error instanceof DomainError && error.code === 'INVALID_INPUT')) throw error;
    return { state: 'invalid_source' };
  }
}
