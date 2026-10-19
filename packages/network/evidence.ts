import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, validPlanDigest } from '../core/delegation.js';
import type { JobStore } from '../core/store.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import { BACKEND_VERSION } from '../ontology/execution.js';
import { domainNames } from '../ontology/service-domains.js';
import { domainCapabilityId } from '../ontology/domain-projection.js';
import { paotuiAgentEvidence } from '../ontology/paotui-agent-evidence.js';
import { sourceProof } from '../ontology/object-evidence.js';
import { objectRefSchema } from '../ontology/model.js';
import { ontologyReceiptSchema } from '../capabilities/paotui-mcp-server.js';
import { fail, type Content, type NetworkActor, type ResultRef, type Publication } from './contracts.js';
import { evidenceBodySchema, type EvidenceBody, type EvidenceProjection, type EvidenceCard } from './evidence-contracts.js';
import { NetworkStore } from './store.js';

const labels: Record<EvidenceBody['evidenceLevel'], string> = {
  synthetic_validation: '合成验证', simulated_execution: '模拟执行', live_query: '真实只读查询', live_execution: '真实业务操作',
  live_fulfillment: '真实履约证据', local_generation: '本地内容生成', participant_statement: '参与者声明', insufficient_evidence: '证据不足',
};
const outcomes: Record<EvidenceBody['outcome'], string> = { query_completed: '查询读回已通过验收', accepted: '本次目标验收通过', partial: '仅部分结果成立', failed: '本次目标未通过验收', pending: '结果仍待核验', needs_human: '需要人工核实', canceled: '任务已取消', insufficient_evidence: '不足以确认结果', declared: '仅为发布者陈述' };
const limits: Record<EvidenceBody['evidenceLevel'], string> = {
  synthetic_validation: '仅合成资料验证，不代表真实查询、交易或履约。', simulated_execution: '仅本地或沙箱流程，不代表真实交易、付款到账或履约。',
  live_query: '仅证明查询完成，不代表下单、付款或履约；也不保证当前价格或可用性。', live_execution: '业务操作与履约分开，不能据此声称服务已经交付。',
  live_fulfillment: '只陈述本次回执与验收支持的结果，不保证未来可用性。', local_generation: '仅生成本地内容，不代表底层业务目标完成。',
  participant_statement: '未作为独立核验或履约证明。', insufficient_evidence: '不以任务状态、模型文本或登记能力补足缺失证据。',
};
const subjectsSchema = z.array(z.object({ object: objectRefSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), linksDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100);
const feedbackSchema = z.object({ outcome: z.string(), taskState: z.string(), evidenceLevel: z.string(), observedAt: z.string() });
function observedDay(value: string) {
  z.iso.datetime({ offset: true }).parse(value);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (kind: string) => parts.find(p => p.type === kind)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function serviceKind(id?: string): EvidenceBody['serviceKind'] {
  if (id === 'delivery.quote') return 'delivery_quote'; if (id === 'geo.search') return 'public_locations';
  if (id === 'brief.prepare' || id === 'document.compose') return 'document'; if (id === 'data.quality.audit.simulated') return 'audit';
  if (id === 'commerce.ucp.prepare.sandbox' || id === 'commerce.ucp.confirm.sandbox') return 'commerce';
  return domainNames.find(d => domainCapabilityId(d) === id) ?? 'other';
}

/** Allowlisted historical projection. Raw task, reason, receipt, URL and feedback text never enter the body. */
export class NetworkEvidence {
  constructor(private store: NetworkStore, private jobs: JobStore, private catalog: ExecutionCatalog) {
    if (!jobs.sharesNetworkStore(store)) throw new Error('Evidence projection requires the existing business database');
  }
  policyVersion() { return digest(['eigos.network.evidence@1', BACKEND_VERSION, this.jobs.ontology.model.ref, labels, outcomes, limits]); }
  private material(owner: string, taskId: string, projection: EvidenceProjection) {
    const job = this.jobs.get(owner, taskId), d = job.delegation;
    if (d?.backendVersion !== BACKEND_VERSION) return fail('EVIDENCE_SOURCE_UNSUPPORTED');
    if (projection.kind === 'result' && ['submitted', 'working'].includes(job.state)) fail('RESULT_NOT_READY');
    const feedback = this.jobs.resultFeedback(owner, taskId), parsedFeedback = feedbackSchema.safeParse(feedback);
    const intents = this.jobs.intents(owner, taskId).filter(i => i.planDigest === d.plan?.digest);
    const budget = { remaining: 4000 }, graph = this.jobs.ontology, requestRef = { type: 'ServiceRequest', id: taskId };
    const root = graph.read(owner, requestRef, budget);
    if (root.properties.revision !== d.request.revision || d.request.id !== taskId) fail('EVIDENCE_SOURCE_STALE');
    const receipts = graph.related(owner, requestRef, 'sourceReceipts', budget); if (!receipts) fail('RESOURCE_BUDGET', 429);
    const snapshots: unknown[] = [], validReceipts = new Map<string, { level: string; scope: string; contentDigest: string; sourceIdentity: string; sourceEventId: string; observedAt: string }>();
    for (const receipt of receipts!) {
      const p = receipt.properties, subjects = subjectsSchema.safeParse(p.subjects);
      snapshots.push([receipt.ref, receipt.revision, digest(p), graph.relationshipDigest(owner, receipt.ref, budget)]);
      let valid = subjects.success && !!p.sourceIdentity && !!p.sourceEventId && !!p.contentDigest && Date.parse(String(p.observedAt)) <= graph.now();
      for (const subject of subjects.success ? subjects.data : []) {
        const object = graph.read(owner, subject.object, budget), links = graph.relationshipDigest(owner, object.ref, budget);
        snapshots.push([object.ref, object.revision, digest(object.properties), links]);
        if (digest(object.properties) !== subject.digest || links !== subject.linksDigest) valid = false;
      }
      if (valid && p.evidenceLevel !== 'user_asserted' && (p.evidenceLevel === 'synthetic' ? receipt.source.kind === 'synthetic' : receipt.source.kind === 'provider')) validReceipts.set(receipt.ref.id, { level: String(p.evidenceLevel), scope: String(p.scope), contentDigest: String(p.contentDigest), sourceIdentity: String(p.sourceIdentity), sourceEventId: String(p.sourceEventId), observedAt: String(p.observedAt) });
    }
    const plan = d.plan;
    if (plan && (!validPlanDigest(plan) || plan.requestId !== taskId || plan.requestRevision !== d.request.revision || plan.requestDigest !== digest(d.request))) fail('EVIDENCE_SOURCE_STALE');
    const capability = plan ? this.catalog.capability(plan.capabilityRef) : undefined;
    if (capability && !plan!.definitionDigests.some(p => digest(p.ref) === digest(capability.ref) && p.digest === digest(capability))) fail('EVIDENCE_SOURCE_STALE');
    const readOnly = !!plan && plan.steps.every(s => s.effect === 'read' || s.effect === 'local') && plan.steps.some(s => s.effect === 'read');
    const business = !!plan && plan.steps.some(s => s.effect !== 'read' && s.effect !== 'local');
    const currentOutcome = d.outcome?.requestId === taskId && d.outcome.requestRevision === d.request.revision ? d.outcome : undefined;
    const outcome = currentOutcome?.status;
    const assessmentAccepted = job.state === 'completed' && d.acceptance?.accepted === true && outcome === 'satisfied';
    const verified = intents.filter(i => i.latestObservationId && i.lastVerifiedResult && i.lastResult && i.lastVerifiedResult.eventId === i.lastResult.eventId
      && i.lastVerifiedResult.sourceVersion === i.latestVersion && i.lastVerifiedResult.evidenceRefs.length > 0
      && digest(i.lastVerifiedResult) === digest(i.lastResult) && !['ready', 'dispatching', 'effect_unknown', 'needs_review'].includes(i.state));
    const currentObservations = intents.every(i => d.actions?.some(a => a.id === i.id && a.state === i.state && a.latestObservationId === i.latestObservationId));
    const allVerified = !!plan && currentObservations && verified.length === plan.steps.length && plan.steps.every(s => verified.some(i => i.stepId === s.id && i.effect === s.effect));
    const accepted = assessmentAccepted && allVerified;
    const fb = parsedFeedback.success && parsedFeedback.data.taskState === job.state && parsedFeedback.data.outcome === (outcome ?? 'unknown') ? parsedFeedback.data : undefined;
    const levels = [...validReceipts.values()].map(r => r.level);
    const simulated = d.request.executionEnvironment === 'sandbox' || capability?.environment === 'sandbox' || levels.includes('synthetic')
      || ['sandbox', 'simulated'].includes(fb?.evidenceLevel ?? '');
    let evidenceLevel: EvidenceBody['evidenceLevel'] = 'insufficient_evidence', resultKind: EvidenceBody['resultKind'] = 'unverified_result';
    let result: EvidenceBody['outcome'] = job.state === 'canceled' ? 'canceled' : outcome === 'unsatisfied' ? 'failed' : outcome === 'needs_human' ? 'needs_human' : 'insufficient_evidence';
    const raw = job.artifact?.data.result as Record<string, unknown> | undefined;
    const receipt = ontologyReceiptSchema.safeParse(raw?.ontologyReceipt), prepared = ontologyReceiptSchema.safeParse(plan?.details.ontologyReceipt);
    if (readOnly && allVerified && root.properties.projectionState === 'typed_result' && receipt.success && prepared.success && raw) {
      const { ontologyReceipt: _receipt, ...data } = raw;
      const proof = validReceipts.get(receipt.data.id), scope = plan!.capabilityRef.id === 'delivery.quote' ? 'delivery_quote' : plan!.capabilityRef.id === 'geo.search' ? 'public_locations' : undefined;
      const expectedLevel = receipt.data.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly';
      if (scope && proof?.scope === scope && proof.level === expectedLevel && proof.contentDigest === receipt.data.resultDigest && proof.sourceIdentity === receipt.data.server
        && proof.sourceEventId === receipt.data.id && proof.observedAt === receipt.data.observedAt && receipt.data.resultDigest === digest(data)
        && receipt.data.tool === (scope === 'delivery_quote' ? 'ontology_delivery_quote' : 'ontology_geo_search')
        && prepared.data.inputDigest === receipt.data.inputDigest && prepared.data.evidenceKind === receipt.data.evidenceKind && receipt.data.capabilityRef.id === plan!.capabilityRef.id) {
        evidenceLevel = simulated ? 'synthetic_validation' : 'live_query'; resultKind = 'query_report'; if (accepted) result = 'query_completed';
      }
    }
    if (business && currentObservations && verified.length && fb) {
      resultKind = 'execution_assessment';
      const partial = verified.some(i => i.businessSnapshot?.value.fulfillment === 'partial');
      result = accepted ? 'accepted' : partial ? 'partial' : outcome === 'unsatisfied' ? 'failed' : outcome === 'needs_human' ? 'needs_human' : job.state === 'canceled' ? 'canceled' : 'pending';
      if (simulated) evidenceLevel = 'simulated_execution';
      else if (root.properties.projectionState === 'typed_result' && [...validReceipts.values()].some(r => ['order', 'delivery', 'reservation', 'payment', 'refund', 'checkout_session'].includes(r.scope)) && levels.length && levels.every(l => l === 'live_operation' || l === 'live_fulfillment') && ['live_operation', 'live_fulfillment'].includes(fb.evidenceLevel)) {
        evidenceLevel = 'live_execution';
        // A generic success/order ID is insufficient: require the existing evidenced delivery function too.
        if (accepted && allVerified && plan!.completionTarget === 'delivery' && verified.some(i => i.businessSnapshot?.value.fulfillment === 'delivered')) {
          const orders = graph.related(owner, requestRef, 'orders', budget) ?? [];
          const shipments = orders.flatMap(o => graph.related(owner, o.ref, 'shipments', budget) ?? []);
          const lines = orders.flatMap(o => graph.related(owner, o.ref, 'lines', budget) ?? []);
          const quantities = lines.map(l => graph.evaluate(owner, { function: 'remainingQuantity', object: l.ref }, budget));
          snapshots.push(quantities);
          const fullyDelivered = quantities.length > 0 && quantities.every(q => q.status === 'known' && (q.value as { amount?: string } | undefined)?.amount === '0' && q.evidenceLevels.length > 0 && q.evidenceLevels.every(l => l === 'live_fulfillment'));
          if (shipments.length === 1 && fullyDelivered) {
            const proof = sourceProof(graph, owner, shipments[0]!.ref, budget), arrival = graph.evaluate(owner, { function: 'actualArrival', object: shipments[0]!.ref }, budget);
            snapshots.push([shipments[0]!.ref, proof, arrival]);
            if (proof?.levels.every(l => l === 'live_fulfillment') && arrival.status === 'known' && arrival.evidenceLevels.length && arrival.evidenceLevels.every(l => l === 'live_fulfillment')) evidenceLevel = 'live_fulfillment';
          }
        }
      }
    } else if (plan && plan.steps.every(s => s.effect === 'local') && accepted && allVerified) {
      resultKind = 'local_artifact'; evidenceLevel = simulated ? 'synthetic_validation' : 'local_generation'; result = 'accepted';
    }
    const agentProof = paotuiAgentEvidence(this.jobs, this.catalog, owner, job);
    if (agentProof) { evidenceLevel = agentProof.evidenceKind === 'fixture' ? 'synthetic_validation' : 'live_query'; resultKind = 'query_report'; result = 'query_completed'; snapshots.push(agentProof); }
    if (evidenceLevel === 'insufficient_evidence' && ['accepted', 'partial', 'query_completed'].includes(result)) result = 'insufficient_evidence';
    let statement = '';
    if (projection.kind === 'statement') {
      evidenceLevel = 'participant_statement'; resultKind = 'participant_statement'; result = 'declared';
      statement = { result_received: '发布者声明已收到查询结果。', service_received: '发布者声明已收到服务。', problem_reported: '发布者声明存在待处理问题。' }[projection.statement];
    }
    const body = evidenceBodySchema.parse({ serviceKind: serviceKind(d.agent?.programRef.id ?? plan?.capabilityRef.id), observedOn: observedDay(job.updatedAt), timeZone: 'Asia/Shanghai', resultKind, outcome: result, evidenceLevel,
      safeSummary: `${labels[evidenceLevel]}：${statement || outcomes[result] + '。'}${limits[evidenceLevel]}` });
    return { body, sourceDigest: digest({ policy: this.policyVersion(), body, job, feedback, intents, snapshots, projection }) };
  }
  prepare(a: NetworkActor, source: { kind: 'task'; taskId: string } | { kind: 'inquiry'; inquiryId: string }, projection: EvidenceProjection): ResultRef[] {
    const taskId = source.kind === 'task' ? source.taskId : this.store.get('inquiry', source.inquiryId, a.owner).taskId;
    const material = this.material(a.owner, taskId, projection), old = this.store.list('evidence', a.owner).find(e => e.taskId === taskId);
    if (old) {
      if (old.profileId !== a.profileId) fail('EVIDENCE_PROFILE_MISMATCH');
      if (old.sourceDigest !== material.sourceDigest) fail('EVIDENCE_STALE');
      return [{ kind: 'evidence', id: old.id }];
    }
    this.store.quota('evidence', a.owner);
    const card: EvidenceCard = { id: randomUUID(), owner: a.owner, profileId: a.profileId, taskId, projection, revision: 1, ...material, createdAt: new Date(this.store.now()).toISOString() };
    this.store.put('evidence', card); this.store.event('evidence_prepared', card.id); return [{ kind: 'evidence', id: card.id }];
  }
  refresh(a: NetworkActor, id: string, expectedRevision: number, projection: EvidenceProjection): ResultRef[] {
    const card = this.store.get('evidence', id, a.owner); if (card.profileId !== a.profileId) fail('NOT_FOUND', 404);
    if (card.revision !== expectedRevision) fail('REVISION_CONFLICT');
    const material = this.material(a.owner, card.taskId, projection);
    if (card.sourceDigest !== material.sourceDigest) {
      card.body = material.body; card.sourceDigest = material.sourceDigest; card.projection = projection; card.revision++;
      this.store.put('evidence', card); this.store.event('evidence_changed', card.id);
    }
    return [{ kind: 'evidence', id }];
  }
  content(owner: string, profileId: string, id: string, revision: number): Extract<Content, {kind:'evidence_card'}> {
    const card = this.store.get('evidence', id, owner); if (card.profileId !== profileId) fail('NOT_FOUND', 404);
    if (card.revision !== revision || this.material(owner, card.taskId, card.projection).sourceDigest !== card.sourceDigest) fail('EVIDENCE_STALE');
    return { kind: 'evidence_card', cardId: card.id, cardRevision: card.revision, body: structuredClone(card.body) };
  }
  validate(content: Content, owner: string, profileId: string) {
    if (content.kind === 'evidence_card' && digest(content) !== digest(this.content(owner, profileId, content.cardId, content.cardRevision))) fail('CONTENT_CHANGED');
  }
  withdrawPending(pub: Publication) {
    if (pub.content.kind !== 'evidence_card') return;
    const spaceId = this.store.get('grant', pub.grantId, pub.owner).spaceId;
    for (const grant of this.store.list('grant', pub.owner)) {
      if (grant.status !== 'approved' || grant.spaceId !== spaceId) continue;
      const draft = this.store.get('draft', grant.draftId, pub.owner);
      if (draft.content.kind !== 'evidence_card' || draft.content.cardId !== pub.content.cardId) continue;
      grant.status = 'revoked'; grant.revokedAt = new Date(this.store.now()).toISOString(); grant.revision++; this.store.put('grant', grant);
    }
  }
  resultSummary(owner: string, taskId: string): EvidenceBody {
    return this.material(owner, taskId, { kind: 'result' }).body;
  }
  ownView(owner: string, id: string) {
    const card = this.store.get('evidence', id, owner); let current = false;
    try { this.content(owner, card.profileId, id, card.revision); current = true; } catch { /* Historical private preview is never a current shared card. */ }
    return { id, revision: card.revision, current, projection: card.projection, body: card.body };
  }
}
