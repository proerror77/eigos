// Synthetic model decisions. Live reasoning is a separate verification step.
import { randomUUID } from 'node:crypto';
import { digest } from '../packages/core/delegation.js';
import type { GoalReview, GoalReviewContext } from '../packages/ontology/goal-coverage.js';
import { Coordinator, type Reasoner, type PlanningContext, type PlanningAccess } from '../packages/coordinator/coordinator.js';
import { ExecutionCatalog, type ExecutionAdapter } from '../packages/core/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { SCOPES, ownerKey } from '../packages/core/domain.js';
import type { Grounding, PlanProposal } from '../packages/core/delegation.js';
import type { ServiceRequest, CandidateFacts, ProviderBinding, ServiceCapability } from '../packages/ontology/execution.js';

export const principal = { issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: 'test', scopes: [...SCOPES] };
export const owner = ownerKey(principal);
export const evidence = () => ({ id: randomUUID(), runtime: 'ontology-v2-fixture', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), outputSha256: 'fixture' });
// Explicit synthetic semantic review for tests whose goals/interpretations are
// fixtures. Production has no permissive reviewer fallback.
export async function syntheticGoalReview(ctx: GoalReviewContext) {
  const decision: GoalReview = { requestRevision: ctx.request.revision, verdict: 'covered', message: 'Synthetic coverage fixture, not a natural-language correctness claim', clauses: ctx.request.messages.map((m, i) => ({
    messageId: m.id, quote: m.text, disposition: 'covered', inputKeys: i === 0 ? Object.keys(ctx.input) : [],
    requirementIds: i === 0 ? [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])].map(r => r.id) : [], conditionIds: i === 0 ? (ctx.request.conditions ?? []).map(c => c.id) : [], reason: 'Explicit synthetic mapping',
  })) };
  return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
}
export function interpretation(request: ServiceRequest, id = 'brief.prepare', input: object = { goal: 'Prepare a brief', deliverable: 'Record acceptance requirements' }): Grounding {
  return { kind: 'resolve', requestRevision: request.revision, capabilityRef: { id, version: '2' }, message: 'Fixture interpretation', inputJson: JSON.stringify(input), requirementsJson: '[]', conditionsJson: '[]' };
}
export function proposal(context: PlanningContext, index = 0): PlanProposal {
  const candidate = context.resolution.candidates[index]!;
  return { kind: 'propose_plan', requestRevision: context.request.revision, candidateId: candidate.id, message: 'Fixture plan based on observations',
    steps: candidate.recipe ? candidate.recipe.map(s => ({ id: s.id, actionTypeRef: s.actionTypeRef, bindingRef: s.bindingRef ?? candidate.binding.ref, inputJson: JSON.stringify(s.input), dependsOn: s.dependsOn })) : [{ id: 'action', actionTypeRef: context.capability.actions[0]!.ref, bindingRef: candidate.binding.ref, inputJson: JSON.stringify(candidate.input), dependsOn: [] }] };
}
export function reasoner(ground: (request: ServiceRequest) => Grounding = interpretation, plan: (context: PlanningContext) => PlanProposal = proposal): Reasoner {
  return { reviewGoal: syntheticGoalReview, ground: async request => ({ decision: ground(request), evidence: evidence() }), plan: async (context, _signal, access) => { observePlanning(context, access); return { decision: plan(context), evidence: evidence() }; } };
}
export function observePlanning(context: PlanningContext, access: PlanningAccess) {
  access.session.call('describe_ontology', { search: 'ServiceRequest', limit: 1 });
  access.session.call('query_ontology', { type: 'ServiceRequest', where: [{ property: 'requestId', op: 'eq', value: context.request.id }] });
}
export function backend(catalog: ExecutionCatalog, model = reasoner(), store = new JobStore(':memory:'), options: { allowSandbox?: boolean } = {}) {
  const tasks = new TaskService(store, { catalog, allowSandboxActions: options.allowSandbox }); const coordinator = new Coordinator(store, model, catalog, options);
  const submit = (extra: object = {}) => tasks.submit(principal, { service: 'eigos.delegate', goal: 'Prepare a brief', requestId: randomUUID(), ...extra });
  const run = async () => { const claim = store.claim(['eigos.delegate'], 15000); if (!claim) throw new Error('Expected durable claim'); await coordinator.run(claim, new AbortController().signal); return store.get(owner, claim.job.id); };
  return { store, tasks, coordinator, submit, run };
}
export const fixtureCapability: ServiceCapability = { ref: { id: 'fixture.supply', version: '2' }, ontologyRef: { id: 'fixture.supply-ontology', version: '2' },
  name: 'Synthetic supply', description: 'Test-only supply facts; no real merchants', tags: ['fixture'], inputSchema: { type: 'object' }, ontology: { objects: ['SyntheticOffer'] },
  actions: [{ ref: { id: 'read_proposal', version: '2' }, effect: 'read' }], predicates: [], verifierRef: { id: 'fixture.exact', version: '2' } };
export const fixtureBinding = (id: string): ProviderBinding => ({ ref: { id, version: '2' }, capabilityRef: fixtureCapability.ref, providerId: id, channelId: 'fixture', adapterId: id,
  protocol: 'local', enabled: true, verification: { level: 'local_test', evidenceRefs: ['fixture-only'] }, recovery: { idempotency: 'none', lookup: false } });
export function fixtureAdapter(id: string, facts: CandidateFacts, options: { expiresAt?: string; permitted?: boolean; execute?: ExecutionAdapter['execute']; verify?: ExecutionAdapter['verify'] } = {}): ExecutionAdapter {
  return { id, permitted: () => options.permitted ?? true,
    prepare: async (_ctx, input) => ({ kind: 'ready', input: input as Record<string, unknown>, details: { source: 'synthetic' }, facts, evidenceRefs: [id + ':fixture-facts'], observedAt: new Date().toISOString(), expiresAt: options.expiresAt ?? new Date(Date.now() + 600000).toISOString(), privateData: { secret: 'private-fixture-marker' } }),
    execute: options.execute ?? (async ctx => ({ artifact: { id: randomUUID(), name: 'fixture.json', data: { goal: ctx.request.originalGoal, deliverable: 'Synthetic proposal', execution: 'completed' } }, facts, evidenceRefs: [id + ':fixture-result'] })),
    verify: options.verify ?? (() => ({ accepted: true, reason: 'Synthetic fixture verifier' })) };
}
