import { digest } from '../core/delegation.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import type { Job } from '../core/domain.js';
import type { JobStore } from '../core/store.js';
import { paotuiCompletionSchema, paotuiActionSchemas, legacyPaotuiActionSchemas } from './paotui-agent.js';
import { checkedPaotuiObservation } from './paotui-agent-projection.js';
import { sourceProof } from './object-evidence.js';
import type { ObjectRef } from './model.js';

/** Historical query proof, not a statement that the quote or connection is usable now. */
export function paotuiAgentEvidence(jobs: JobStore, _catalog: ExecutionCatalog, owner: string, job: Job) {
  const d = job.delegation, state = d?.agent, completion = state?.completion;
  if (!d || !state || !completion || job.state !== 'completed' || !d.acceptance?.accepted || d.request.revision !== state.requestRevision) return;
  if (!(state.programRef.id === 'delivery.quote' && ['3', '4'].includes(state.programRef.version) || state.programRef.id === 'address.book.read' && ['2', '3'].includes(state.programRef.version))) return;
  const same = (a: unknown, b: unknown) => digest(a ?? null) === digest(b ?? null);
  try {
    // A historical accepted read is proved by its fixed program/action/attempt
    // records. A newly installed program or expired grant cannot rewrite it.
    if (completion.modelDecision.kind !== 'complete' || completion.modelDecision.requestRevision !== d.request.revision
      || !same(JSON.parse(completion.modelDecision.completionJson), completion.proposal) || !job.runs?.some(r => r.id === completion.modelRunId && r.decisionDigest === digest(completion.modelDecision))) return;
    const selected = paotuiCompletionSchema.parse(completion.proposal), graph = jobs.ontology, seen = new Set<string>(), material: unknown[] = [], kinds = new Set<string>();
    const check = (ref: ObjectRef) => {
      if (seen.has(ref.id)) return; seen.add(ref.id);
      if (!state.observations.some(r => same(r, ref)) || ref.type !== 'PaotuiObservation') throw new Error('Unowned observation');
      const s = checkedPaotuiObservation(graph.readPrivate(owner, ref).properties.privateSnapshot), proof = sourceProof(graph, owner, ref, { remaining: 1000 });
      if (!proof || s.requestId !== job.id || s.requestRevision !== d.request.revision || s.configurationDigest !== state.programDigest || !same(s.scope, state.scope)) throw new Error('Invalid source scope');
      const plan = state.plans.find(p => p.id === s.planId); if (!plan) throw new Error('Missing plan');
      const { digest: planDigest, ...body } = plan;
      if (digest(body) !== planDigest || plan.modelDecision.kind !== 'execute' || !same(plan.programRef, state.programRef) || plan.programDigest !== state.programDigest
        || plan.requestId !== s.requestId || plan.requestRevision !== s.requestRevision || !same(plan.scope, s.scope)
        || !job.runs?.some(r => r.id === plan.modelRunId && r.decisionDigest === digest(plan.modelDecision)) || s.modelRunId !== plan.modelRunId) throw new Error('Missing model decision');
      const step = plan.steps.find(x => x.intentId === s.intentId), intent = jobs.intent(owner, s.intentId), attempts = jobs.attempts(owner, s.intentId);
      if (!step || step.action !== s.action || intent.planDigest !== planDigest || intent.state !== 'effect_confirmed' || intent.effect !== 'read' || !same(intent.acceptedOutput?.object, ref) || !same(intent.lastVerifiedResult, intent.lastResult) || !same(intent.lastVerifiedResult?.output?.source, s)
        || !attempts.some(a => a.id === s.attemptId && a.planDigest === planDigest && a.inputDigest === digest(s.actionInput))) throw new Error('Missing accepted source attempt');
      const chosen = plan.modelDecision.steps.find(x => x.id === step.id), { definitionDigest: _d, input: _i, intentId: _id, ...decisionStep } = step;
      if (!same(chosen, decisionStep) || !same(step.input, JSON.parse(step.argumentsJson))) throw new Error('Changed model-selected action');
      const args = structuredClone(step.input);
      for (const link of step.inputRefs) { const parent = plan.steps.find(p => p.id === link.stepId); if (!parent || !step.dependsOn.includes(parent.id)) throw new Error('Broken dependency'); args[link.targetKey] = jobs.intent(owner, parent.intentId).acceptedOutput?.object; }
      if (!same(args, s.actionInput)) throw new Error('Action arguments changed');
      const receipts = graph.related(owner, ref, 'sourceReceipts', { remaining: 1000 });
      if (receipts?.length !== 1 || receipts[0]!.properties.contentDigest !== s.contentDigest || receipts[0]!.properties.sourceEventId !== s.receipt.id) throw new Error('Receipt changed');
      material.push({ snapshot: s.contentDigest, proof, intent, attempts }); kinds.add(s.receipt.evidenceKind);
      if (s.action === 'ReadSavedAddressDetail') check(paotuiActionSchemas.ReadSavedAddressDetail.parse(s.actionInput).book);
      if (s.action === 'PreviewDeliveryQuote') {
        const a = (s.inputState ? paotuiActionSchemas : legacyPaotuiActionSchemas).PreviewDeliveryQuote.parse(s.actionInput); check(a.sender); check(a.recipient);
        const quoteRef = { type: 'DeliveryQuote', id: s.id };
        if (!sourceProof(graph, owner, quoteRef, { remaining: 1000 })) throw new Error('Typed quote proof changed');
        if (s.inputState) {
          const quote = graph.read(owner, quoteRef), parcel = graph.related(owner, quoteRef, 'parcel', { remaining: 1000 }), route = graph.related(owner, quoteRef, 'route', { remaining: 1000 });
          if (quote.properties.parcelRevision !== s.inputState.parcel.revision || quote.properties.routeRevision !== s.inputState.route.revision
            || parcel?.length !== 1 || !same(parcel[0]!.ref, s.inputState.parcel.ref) || route?.length !== 1 || !same(route[0]!.ref, s.inputState.route.ref)) throw new Error('Priced input snapshots changed');
        }
      }
      return s;
    };
    const s = check(selected.observation); if (!s || s.action !== (state.programRef.id === 'delivery.quote' ? 'PreviewDeliveryQuote' : 'ReadSavedAddresses')) return;
    const answer = (job.artifact?.data.result as { paotuiAnswer?: Record<string, unknown> } | undefined)?.paotuiAnswer;
    if (!answer || !same(answer.observation, selected.observation) || answer.receiptId !== s.receipt.id || answer.noOrder !== true || answer.noPayment !== true || !same(answer.totalPrice, s.summary.totalPrice) || !d.acceptance.evidenceRefs.includes(s.receipt.id)) return;
    const reads = completion.ontologyPlanning, call = { function: 'paotuiObservationStatus', object: selected.observation };
    if (!(reads.deliveredObjects ?? reads.objects).some(o => same(o.ref, selected.observation)) || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(call))) return;
    return { evidenceKind: kinds.has('fixture') ? 'fixture' as const : 'live_readonly' as const, digest: digest({ material, completion, answer }) };
  } catch { return; }
}
